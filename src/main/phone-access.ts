/**
 * Phone access (#194), put together: the listener, the access service that
 * owns it, the sessions service the enrolled phones talk to, and the voice
 * service it hands their hold-to-talk to.
 *
 * Kept apart from `composition-root.ts` and free of Electron so the whole of
 * it can be driven in node against a real listener (test/phone-access-wiring
 * .test.ts); the composition root hands in the Electron-backed identity, the
 * SQLite registry and `dns-sd`.
 *
 * The phones hear what the renderer hears. `PhoneEventTee` sits in front of
 * the renderer gateway, so every service that already tells the renderer
 * about output, exits, re-keys, busy, attention, questions and a changed
 * project list tells the phones too, without knowing they exist.
 */
import { encodeTerminalFrame, parseClientMessage } from '../domain/phone/codec';
import { PhoneAccessService } from '../application/services/phone-access-service';
import { PhoneSessionsService } from '../application/services/phone-sessions-service';
import { VoiceService } from '../application/services/voice-service';
import { TlsDeviceLink } from '../infrastructure/phone/tls-device-link';
import type { PhoneAccessState, TerminalOwner } from '../domain/phone/state';
import type { PendingQuestions, QuestionsSettled } from '../domain/questions/question';
import type { RemoteStatusPayload } from '../domain/remote/remote-status';
import type { SessionWorkSnapshot } from '../domain/session-work/model';
import type { PullRequestStatusChange } from '../domain/session-work/status';
import type { WorkingAgent } from '../domain/terminal/program-status-children';
import type { UpdateNotice } from '../domain/update/release';
import type { Clock, Timers } from '../application/ports/clock';
import type { ClaudeCaller } from '../application/ports/claude-cli';
import type { IdGenerator } from '../application/ports/ids';
import type { Logger } from '../application/ports/logger';
import type { DeviceRegistry, ServerIdentityStore, ServiceAdvertiser } from '../application/ports/phone-access';
import type { RendererGateway } from '../application/ports/renderer-gateway';
import type { SettingsStore } from '../application/ports/settings-store';
import type { Transcriber, VoiceModelStore } from '../application/ports/voice';
import type { PhoneSessionsServiceDeps } from '../application/services/phone-sessions-service';

/** What the sessions service is told of, from where the renderer is. */
export type PhoneSessionEvents = Pick<PhoneSessionsService,
  | 'terminalData' | 'processExited' | 'sessionForked' | 'cliBusyState' | 'sessionNeedsAttention'
  | 'questionsAsked' | 'questionsSettled' | 'sessionsChanged' | 'sessionArchived'>;

/**
 * The renderer gateway, with the phones listening in: every push goes to the
 * window as before, and the ones the phones care about to the sessions
 * service as well. `phones` is read per call, because the sessions service is
 * built after the services that push through this.
 */
export class PhoneEventTee implements RendererGateway {
  constructor(
    private readonly inner: RendererGateway,
    private readonly phones: () => PhoneSessionEvents | null,
  ) {}

  get attached(): boolean {
    return this.inner.attached;
  }

  terminalData(sessionId: string, data: string): void {
    this.inner.terminalData(sessionId, data);
    this.phones()?.terminalData(sessionId, data);
  }

  processExited(sessionId: string, exitCode: number): void {
    this.inner.processExited(sessionId, exitCode);
    this.phones()?.processExited(sessionId, exitCode);
  }

  sessionForked(oldId: string, newId: string): void {
    this.inner.sessionForked(oldId, newId);
    this.phones()?.sessionForked(oldId, newId);
  }

  cliBusyState(sessionId: string, busy: boolean): void {
    this.inner.cliBusyState(sessionId, busy);
    this.phones()?.cliBusyState(sessionId, busy);
  }

  terminalNotification(sessionId: string, message: string): void {
    this.inner.terminalNotification(sessionId, message);
  }

  sessionNeedsAttention(sessionId: string): void {
    this.inner.sessionNeedsAttention(sessionId);
    this.phones()?.sessionNeedsAttention(sessionId);
  }

  sessionAgents(sessionId: string, agents: WorkingAgent[]): void {
    this.inner.sessionAgents(sessionId, agents);
  }

  remoteStatus(sessionId: string, status: RemoteStatusPayload): void {
    this.inner.remoteStatus(sessionId, status);
  }

  questionsAsked(pending: PendingQuestions): void {
    this.inner.questionsAsked(pending);
    this.phones()?.questionsAsked(pending);
  }

  questionsSettled(settled: QuestionsSettled): void {
    this.inner.questionsSettled(settled);
    this.phones()?.questionsSettled(settled);
  }

  /** A session started, ended, was renamed or got its title: the phones' list follows. */
  projectsChanged(): void {
    this.inner.projectsChanged();
    this.phones()?.sessionsChanged();
  }

  statusUpdate(text: string, type: string): void {
    this.inner.statusUpdate(text, type);
  }

  fullscreenChanged(isFullscreen: boolean): void {
    this.inner.fullscreenChanged(isFullscreen);
  }

  updateAvailable(update: UpdateNotice): void {
    this.inner.updateAvailable(update);
  }

  sessionWorkSnapshot(snapshot: SessionWorkSnapshot): void {
    this.inner.sessionWorkSnapshot(snapshot);
  }

  prStatusChanged(change: PullRequestStatusChange): void {
    this.inner.prStatusChanged(change);
  }

  launchRequested(projectPath: string, initialPrompt: string): void {
    this.inner.launchRequested(projectPath, initialPrompt);
  }

  pickerRequested(initialPrompt: string, reason?: string): void {
    this.inner.pickerRequested(initialPrompt, reason);
  }

  phoneAccessChanged(state: PhoneAccessState): void {
    this.inner.phoneAccessChanged(state);
  }

  terminalOwnerChanged(sessionId: string, owner: TerminalOwner): void {
    this.inner.terminalOwnerChanged(sessionId, owner);
  }

  sessionStarted(sessionId: string, projectPath: string): void {
    this.inner.sessionStarted(sessionId, projectPath);
    this.phones()?.sessionsChanged();
  }

  sessionArchived(sessionId: string): void {
    this.inner.sessionArchived(sessionId);
    this.phones()?.sessionArchived(sessionId);
  }
}

export interface PhoneAccessDeps extends Omit<PhoneSessionsServiceDeps, 'settings' | 'renderer' | 'voice'> {
  identity: ServerIdentityStore;
  devices: DeviceRegistry;
  advertiser: ServiceAdvertiser;
  /** Where the listener binds; the Mac's LAN addresses unless given (loopback for e2e and tests). */
  addresses?: () => string[];
  /** The setting that keeps Phone access on, and each project's new-session defaults. */
  settings: Pick<SettingsStore, 'get' | 'set'> & PhoneSessionsServiceDeps['settings'];
  /** The tee in front of the window's gateway. */
  renderer: RendererGateway;
  /** Hold-to-talk: Whisper, its model, and `claude` for the cleanup. */
  voice: { transcriber: Transcriber; model: VoiceModelStore; cli: ClaudeCaller };
  ids: IdGenerator;
  clock: Clock;
  timers: Timers;
  log: Logger;
  randomBytes(length: number): Uint8Array;
  macName: string;
  appVersion: string;
}

export interface PhoneAccess {
  access: PhoneAccessService;
  sessions: PhoneSessionsService;
  link: TlsDeviceLink;
}

export function buildPhoneAccess(deps: PhoneAccessDeps): PhoneAccess {
  const { renderer, launcher, log } = deps;
  const link = new TlsDeviceLink({
    parse: parseClientMessage,
    encodeTerminalFrame,
    log,
    ...(deps.addresses ? { addresses: deps.addresses } : {}),
  });
  const voice = new VoiceService({ ...deps.voice, registry: deps.registry, projects: deps.projects, timers: deps.timers, log });
  const sessions = new PhoneSessionsService({
    ...deps,
    renderer,
    voice,
    // A session a phone starts gets its row on the Mac at once (#194 story
    // 69), not only once its transcript has been written and indexed.
    launcher: {
      async open(request) {
        const opened = await launcher.open(request);
        if (opened.ok && !opened.reattached) renderer.sessionStarted(request.sessionId, request.projectPath);
        return opened;
      },
    },
  });
  const access = new PhoneAccessService({ ...deps, link, sessions, renderer });
  return { access, sessions, link };
}
