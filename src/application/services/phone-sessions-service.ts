/**
 * What a paired phone can do once it is in (#194): see the running sessions,
 * watch and type into a session's terminal, answer its questions, and start a
 * new one through Ask Patch. Also the Mac's side of terminal ownership, which
 * the terminal IPC handlers ask before they resize or type.
 *
 * The phone access service hands every connection over after `welcome`; from
 * then on this service speaks the protocol (`domain/phone/protocol`) and never
 * sees a socket. It is fed the same events the renderer gateway is — output,
 * exits, re-keys, busy and attention, questions, a changed project list — by
 * the wiring, and answers each with messages to the phones.
 *
 * Who a session's terminal belongs to is decided by the domain rules
 * (`domain/phone/ownership`); this keeps their state, does what they say to
 * the PTYs, and tells every phone (`owner`) and the renderer
 * (`terminalOwnerChanged`) whenever an owner changes.
 *
 * What main can't know the way the renderer does: whether the user has looked
 * at a session. The sidebar clears "needs you" when the row is opened; here it
 * clears when the next turn starts, and an unread finished turn ranks with the
 * idle ones, which is where the sidebar files it too.
 */
import { routeCandidates, folderName } from '../../domain/ask/route';
import { defaultSessionOptions } from '../../domain/launch/session-options';
import { MAC, NO_OWNERSHIP, acceptsInput, applyOwnership, ownerOf } from '../../domain/phone/ownership';
import { sessionTier, TIER_ATTENTION, TIER_RUNNING } from '../../domain/session/tiers';
import { cleanDisplayName, resolveSessionName } from '../../domain/session/title';
import { ENTER_ALT_SCREEN, HIDE_CURSOR } from '../../domain/terminal/ansi';
import type { RouteCandidate, RouteRequest, RouteResult } from '../../domain/ask/model';
import type { Device, OwnershipEvent, OwnershipState, TerminalSize } from '../../domain/phone/ownership';
import type {
  ClientMessage, PhoneAskResult, PhoneProject, PhoneSession, ServerMessage, TerminalOwner,
} from '../../domain/phone/protocol';
import type { Project } from '../../domain/project/project';
import type { PendingQuestions, QuestionsSettled } from '../../domain/questions/question';
import type { SessionRow } from '../../domain/session/session';
import type { EffectiveSettings } from '../../domain/settings/settings';
import type { ActiveSession } from '../model/active-session';
import type { SessionRegistry } from '../model/session-registry';
import type { Clock, Timers } from '../ports/clock';
import type { IdGenerator } from '../ports/ids';
import type { Logger } from '../ports/logger';
import type { DeviceConnection } from '../ports/phone-access';
import type { RendererGateway } from '../ports/renderer-gateway';
import type { QuestionService } from './question-service';
import type { OpenSessionRequest, OpenSessionResult } from './session-launcher';

/**
 * How long buffering stays suppressed after a plain terminal's resize; the
 * same settle the renderer's resizes get (`main/ipc/terminal-handlers`).
 */
export const RESIZE_SETTLE_MS = 200;

/** The delays of the resize nudge that makes a TUI repaint; as the renderer's resizes. */
export const NUDGE_DELAY_MS = 50;

/**
 * How long changes are gathered before the list goes out again. A turn
 * ending fires busy, attention and a question within a few milliseconds, and
 * each would otherwise rebuild the project list and send it whole.
 */
export const SESSIONS_PUSH_MS = 100;

/** What a session with no row yet is called: the renderer's pending row says the same. */
const NEW_SESSION_NAME = 'New session';

/** Ask Patch's routing, one instance per phone: an `AskRouteService` on `ASK_PATCH_CALL`. */
export interface PhoneRouter {
  route(request: RouteRequest): Promise<RouteResult>;
  cancel(): void;
}

export interface PhoneSessionsServiceDeps {
  registry: SessionRegistry;
  /** The ids with a live PTY (`SessionLifecycle`). */
  running: { runningSessionIds(): string[] };
  /** Every project with its session rows (`ProjectListService`): names, and the local projects Ask Patch offers. */
  projects: { list(showArchived: boolean): Project[] };
  questions: Pick<QuestionService, 'pending' | 'answer'>;
  /** A router of the phone's own, so two phones (or a phone and the Mac) never cancel each other. */
  router(): PhoneRouter;
  launcher: { open(request: OpenSessionRequest): Promise<OpenSessionResult> };
  /** Stop the session and archive its row, as the Mac's archive does; `ok: false` leaves it running and listed. */
  archiver: { archive(sessionId: string): { ok: boolean; error?: string } };
  settings: { effective(projectPath: string): EffectiveSettings };
  renderer: Pick<RendererGateway, 'terminalOwnerChanged' | 'projectsChanged'>;
  ids: IdGenerator;
  clock: Clock;
  timers: Timers;
  log: Logger;
}

/** One phone's open connection, and what it is doing. */
interface Phone {
  readonly connection: DeviceConnection;
  readonly deviceId: string;
  /** Sessions it is attached to, by current id: their output streams to it. */
  readonly attached: Set<string>;
  router: PhoneRouter | null;
  /** The Ask Patch request in flight, if any. */
  asking: string | null;
  open: boolean;
}

export class PhoneSessionsService {
  readonly #phones = new Map<string, Phone>();
  /** What each device called itself, kept past its disconnect: it may still own sessions. */
  readonly #names = new Map<string, string>();
  #ownership: OwnershipState = NO_OWNERSHIP;
  /** Sessions whose CLI is mid-turn. */
  readonly #busy = new Set<string>();
  /** Sessions blocked on the user in the terminal, until their next turn starts. */
  readonly #attention = new Set<string>();
  /** When each session's state last changed, for the row's "2m". */
  readonly #changedAt = new Map<string, number>();
  /** The ids the phones were last sent, so an exit is told once and under the id they know. */
  #listed = new Set<string>();
  #pushTimer: unknown = null;

  constructor(private readonly deps: PhoneSessionsServiceDeps) {}

  // ── The phones ──

  /** An enrolled phone said hello and was welcomed: it gets the list and the questions. */
  connected(connection: DeviceConnection, device: { id: string; name: string }): void {
    this.#names.set(device.id, device.name);
    this.#phones.set(connection.id, {
      connection, deviceId: device.id, attached: new Set(), router: null, asking: null, open: true,
    });
    connection.send({ type: 'sessions', sessions: this.#sessionList() });
    connection.send({ type: 'questions', pending: this.deps.questions.pending() });
  }

  message(connection: DeviceConnection, message: ClientMessage): void {
    const phone = this.#phones.get(connection.id);
    if (!phone) return;
    switch (message.type) {
      case 'attach':
        return this.#attach(phone, message.sessionId, { cols: message.cols, rows: message.rows });
      case 'detach':
        phone.attached.delete(this.#currentId(message.sessionId) ?? message.sessionId);
        return;
      case 'size': {
        const sessionId = this.#currentId(message.sessionId);
        if (sessionId) this.#apply({ type: 'size', sessionId, device: phone.deviceId, size: { cols: message.cols, rows: message.rows } });
        return;
      }
      case 'use-here': {
        const sessionId = this.#currentId(message.sessionId);
        if (sessionId) this.#apply({ type: 'use-here', sessionId, device: phone.deviceId });
        return;
      }
      case 'input':
        return this.#input(phone, message.sessionId, message.data);
      case 'answer':
        return this.#answer(phone, message.sessionId, message.toolUseId, message.answers);
      case 'ask':
        void this.#ask(phone, message.requestId, message.text, sizeOf(message));
        return;
      case 'ask-cancel':
        if (phone.asking === message.requestId) phone.router?.cancel();
        return;
      case 'ask-start':
        void this.#askStart(phone, message.requestId, message.projectPath, message.prompt, sizeOf(message));
        return;
      case 'list-projects':
        connection.send({ type: 'projects', projects: this.#projects() });
        return;
      case 'archive':
        return this.#archive(phone, message.sessionId);
      case 'hello':
      case 'pair':
        // The access service's; one after welcome is noise.
        return;
    }
  }

  /** The connection closed. Ownership stays where it is (#194: a dropped phone keeps its sessions). */
  disconnected(connection: DeviceConnection): void {
    const phone = this.#phones.get(connection.id);
    if (!phone) return;
    phone.open = false;
    this.#phones.delete(connection.id);
    // Killed, not left to finish on the user's quota.
    phone.router?.cancel();
    this.#apply({ type: 'device-left', device: phone.deviceId });
  }

  /** Revoked, or every device by Reset: its sessions go back to the Mac. */
  deviceRemoved(deviceId: string): void {
    this.#apply({ type: 'device-removed', device: deviceId });
    this.#names.delete(deviceId);
  }

  // ── The Mac's side ──

  /** Every session something has happened to, with its owner; any other running session is the Mac's. */
  owners(): Record<string, TerminalOwner> {
    const owners: Record<string, TerminalOwner> = {};
    for (const sessionId of Object.keys(this.#ownership.sessions)) {
      owners[sessionId] = this.#wireOwner(ownerOf(this.#ownership, sessionId));
    }
    return owners;
  }

  /**
   * Use here on the Mac. With the Mac's size, it is remembered first so the
   * PTY takes it at once; without, the renderer's resize that follows does it.
   */
  useHereOnMac(sessionId: string, cols?: number, rows?: number): { ok: boolean; error?: string } {
    const id = this.#currentId(sessionId);
    if (!id) return { ok: false, error: 'That session is not running' };
    if (cols !== undefined && rows !== undefined) {
      this.#apply({ type: 'size', sessionId: id, device: MAC, size: { cols, rows } });
    }
    this.#apply({ type: 'use-here', sessionId: id, device: MAC });
    return { ok: true };
  }

  /**
   * The Mac's terminal for a session was fitted to this size. True when the
   * PTY should take it now, which the caller does the way it always has; false
   * while a phone owns the session, whose size it keeps.
   */
  macResized(sessionId: string, cols: number, rows: number): boolean {
    const id = this.#currentId(sessionId) ?? sessionId;
    this.#ownership = applyOwnership(this.#ownership, { type: 'size', sessionId: id, device: MAC, size: { cols, rows } }).state;
    return ownerOf(this.#ownership, id) === MAC;
  }

  /** Whether the Mac's typing reaches the PTY: only while the Mac owns the session. */
  macInputAllowed(sessionId: string): boolean {
    return acceptsInput(this.#ownership, this.#currentId(sessionId) ?? sessionId, MAC);
  }

  // ── Events, from where the renderer gateway gets them ──

  terminalData(sessionId: string, data: string): void {
    for (const phone of this.#phones.values()) {
      if (phone.attached.has(sessionId)) phone.connection.sendTerminal(sessionId, data);
    }
  }

  /**
   * A session's process ended. The lifecycle says so under every id the
   * session has had; the phones hear it once, under the one they know.
   */
  processExited(sessionId: string, exitCode: number): void {
    const known = this.#listed.has(sessionId)
      || [...this.#phones.values()].some(phone => phone.attached.has(sessionId));
    for (const phone of this.#phones.values()) phone.attached.delete(sessionId);
    this.#listed.delete(sessionId);
    this.#busy.delete(sessionId);
    this.#attention.delete(sessionId);
    this.#changedAt.delete(sessionId);
    this.#apply({ type: 'ended', sessionId });
    if (known) this.#broadcast({ type: 'exited', sessionId, exitCode });
    this.#schedulePush();
  }

  /** A fork or plan accept re-keyed a running session: the phones move the row, not replace it. */
  sessionForked(oldId: string, newId: string): void {
    if (oldId === newId) return;
    this.#apply({ type: 'rekeyed', from: oldId, to: newId });
    for (const phone of this.#phones.values()) moveKey(phone.attached, oldId, newId);
    moveKey(this.#busy, oldId, newId);
    moveKey(this.#attention, oldId, newId);
    const changedAt = this.#changedAt.get(oldId);
    this.#changedAt.delete(oldId);
    if (changedAt !== undefined) this.#changedAt.set(newId, changedAt);
    if (this.#listed.delete(oldId)) this.#listed.add(newId);
    this.#broadcast({ type: 'session-rekeyed', from: oldId, to: newId });
    this.#schedulePush();
  }

  cliBusyState(sessionId: string, busy: boolean): void {
    if (busy) {
      this.#busy.add(sessionId);
      // A turn starting means whatever it was blocked on got its answer.
      this.#attention.delete(sessionId);
    } else {
      this.#busy.delete(sessionId);
    }
    this.#changed(sessionId);
  }

  sessionNeedsAttention(sessionId: string): void {
    this.#attention.add(sessionId);
    this.#changed(sessionId);
  }

  questionsAsked(pending: PendingQuestions): void {
    this.#broadcast({ type: 'questions', pending: this.deps.questions.pending() });
    this.#changed(pending.sessionId);
  }

  /**
   * A set was answered or withdrawn. An answer on the Mac makes the Mac the
   * active device, as one from a phone makes that phone it (#194); the
   * phone's own answer moved ownership when it was given.
   */
  questionsSettled(settled: QuestionsSettled): void {
    const { sessionId, toolUseId, outcome } = settled;
    this.#broadcast({ type: 'questions-settled', sessionId, toolUseId, outcome, answeredOn: settled.answeredOn ?? null });
    this.#broadcast({ type: 'questions', pending: this.deps.questions.pending() });
    if (outcome === 'answered' && settled.answeredOn === 'mac') {
      const id = this.#currentId(sessionId);
      if (id) this.#apply({ type: 'answered', sessionId: id, device: MAC });
    }
    this.#changed(sessionId);
  }

  /** The project list changed: a session started, ended, was renamed or got its title. */
  sessionsChanged(): void {
    this.#schedulePush();
  }

  // ── The terminal ──

  /** `attached`, then the replay, then live output as it comes. A second attach replays again. */
  #attach(phone: Phone, requested: string, size: TerminalSize): void {
    const found = this.deps.registry.find(requested);
    if (!found || (found.session.exited && !found.session.isReconnecting)) {
      this.deps.log.info(`[phone] attach to ${requested}, which is not running`);
      return;
    }
    const { key: sessionId, session } = found;
    this.#apply({ type: 'size', sessionId, device: phone.deviceId, size });
    phone.connection.send({ type: 'attached', sessionId, owner: this.#wireOwner(ownerOf(this.#ownership, sessionId)) });
    for (const chunk of replay(session)) phone.connection.sendTerminal(sessionId, chunk);
    phone.attached.add(sessionId);
  }

  /** Prompt-box text or a key: dropped unless this phone owns the session. */
  #input(phone: Phone, requested: string, data: string): void {
    const found = this.deps.registry.find(requested);
    if (!found || found.session.exited) return;
    if (!acceptsInput(this.#ownership, found.key, phone.deviceId)) {
      this.deps.log.info(`[phone] input for ${found.key} from a device that isn't active; dropped`);
      return;
    }
    found.session.pty.write(data);
  }

  #answer(phone: Phone, requested: string, toolUseId: string, answers: Record<string, string>): void {
    const result = this.deps.questions.answer(requested, toolUseId, answers, 'phone');
    phone.connection.send({ type: 'answer-result', sessionId: requested, toolUseId, ...result });
    if (!result.ok) return;
    const sessionId = this.#currentId(requested);
    if (sessionId) this.#apply({ type: 'answered', sessionId, device: phone.deviceId });
  }

  /**
   * Archive under the session's current id, or the one asked for once it has
   * exited: a row with nothing running under it can still be archived.
   */
  #archive(phone: Phone, requested: string): void {
    const sessionId = this.#currentId(requested) ?? requested;
    let result: { ok: boolean; error?: string };
    try {
      result = this.deps.archiver.archive(sessionId);
    } catch (err) {
      result = { ok: false, error: (err as Error).message };
    }
    this.deps.log.info(`[phone] archive ${sessionId}: ${result.ok ? 'done' : result.error}`);
    phone.connection.send({ type: 'archive-result', sessionId: requested, ...result });
  }

  /** Feed an event to the ownership rules, and do what they say. */
  #apply(event: OwnershipEvent): void {
    const change = applyOwnership(this.#ownership, event);
    this.#ownership = change.state;
    // A move gets the nudge even at an unchanged size: the TUI has to repaint for the device that took over.
    const moved = event.type === 'use-here' || event.type === 'answered' || event.type === 'started' || event.type === 'device-removed';
    for (const [sessionId, size] of Object.entries(change.resize)) this.#resizePty(sessionId, size, moved);
    for (const sessionId of change.ownerChanged) {
      const owner = this.#wireOwner(ownerOf(this.#ownership, sessionId));
      this.#broadcast({ type: 'owner', sessionId, owner });
      this.deps.renderer.terminalOwnerChanged(sessionId, owner);
    }
    if (change.ownerChanged.length > 0) this.#schedulePush();
  }

  /**
   * Size the PTY the way a resize from the renderer does
   * (`main/ipc/terminal-handlers`): remembered for a remote's next dial, kept
   * out of a plain terminal's buffer, and nudged by a column and back so a
   * full-screen TUI repaints — on the first resize after an attach, and on
   * every move.
   */
  #resizePty(sessionId: string, { cols, rows }: TerminalSize, moved: boolean): void {
    const session = this.deps.registry.get(sessionId);
    if (!session) return;
    const { timers } = this.deps;
    if (session.remote) {
      session.remote.cols = cols;
      session.remote.rows = rows;
    }
    if (session.exited) return;

    if (session.isPlainTerminal) session.output.suppress();
    session.pty.resize(cols, rows);
    if (session.isPlainTerminal) {
      timers.setTimeout(() => session.output.resume(), RESIZE_SETTLE_MS);
      return;
    }

    if (!moved && !session.firstResize) return;
    session.firstResize = false;
    timers.setTimeout(() => {
      try {
        session.pty.resize(cols + 1, rows);
        timers.setTimeout(() => {
          try { session.pty.resize(cols, rows); } catch { /* gone */ }
        }, NUDGE_DELAY_MS);
      } catch {
        // The session exited between the nudge being scheduled and running.
      }
    }, NUDGE_DELAY_MS);
  }

  // ── Ask Patch ──

  /**
   * Route what the phone typed. Confident starts the session straight away;
   * anything else goes back for the phone to settle. A newer request from the
   * same phone answers the older one `cancelled`.
   */
  async #ask(phone: Phone, requestId: string, text: string, size: TerminalSize | undefined): Promise<void> {
    const candidates = routeCandidates(this.deps.projects.list(false));
    phone.router ??= this.deps.router();
    phone.asking = requestId;
    const result = await phone.router.route({ text, candidates });
    if (phone.asking === requestId) phone.asking = null;
    if (!phone.open) return;
    this.deps.log.info(`[phone] ask ${requestId} routed: ${result.kind}`);

    if (result.kind !== 'confident') {
      phone.connection.send({ type: 'ask-result', requestId, result: phoneAskResult(result, candidates) });
      return;
    }
    const started = await this.#launch(phone, result.projectPath, result.prompt, size);
    if (!phone.open) return;
    if ('error' in started) {
      phone.connection.send({ type: 'ask-error', requestId, error: started.error });
      return;
    }
    phone.connection.send({
      type: 'ask-result', requestId,
      result: { kind: 'confident', sessionId: started.sessionId, project: folderName(result.projectPath) },
    });
  }

  /** The user picked the project: an unsure candidate, or one from the list after no match. */
  async #askStart(
    phone: Phone, requestId: string, projectPath: string, prompt: string, size: TerminalSize | undefined,
  ): Promise<void> {
    const local = routeCandidates(this.deps.projects.list(false));
    if (!local.some(candidate => candidate.projectPath === projectPath)) {
      phone.connection.send({ type: 'ask-error', requestId, error: 'That project can’t be started from the phone' });
      return;
    }
    const started = await this.#launch(phone, projectPath, prompt, size);
    if (!phone.open) return;
    if ('error' in started) phone.connection.send({ type: 'ask-error', requestId, error: started.error });
    else phone.connection.send({ type: 'ask-started', requestId, sessionId: started.sessionId });
  }

  /**
   * Start a Claude session with the project's default options, owned by the
   * phone from the start: the PTY takes its size as soon as it exists, and the
   * Mac shows the placeholder for it.
   */
  async #launch(
    phone: Phone, projectPath: string, prompt: string, size: TerminalSize | undefined,
  ): Promise<{ sessionId: string } | { error: string }> {
    const { launcher, settings, ids, renderer, log } = this.deps;
    const sessionId = ids.newId();
    const options = { ...defaultSessionOptions(settings.effective(projectPath)), initialPrompt: prompt };
    let opened: OpenSessionResult;
    try {
      opened = await launcher.open({ sessionId, projectPath, isNew: true, options });
    } catch (err) {
      opened = { ok: false, error: (err as Error).message };
    }
    if (!opened.ok) {
      log.warn(`[phone] could not start a session in ${projectPath}: ${opened.error}`);
      return { error: opened.error ?? 'The session could not be started' };
    }
    log.info(`[phone] started ${sessionId} in ${projectPath} from ${phone.deviceId}`);
    this.#apply({ type: 'started', sessionId, device: phone.deviceId, ...(size ? { size } : {}) });
    renderer.projectsChanged();
    this.#schedulePush();
    return { sessionId };
  }

  /** The local projects Ask Patch may start in, with how many sessions run in each. */
  #projects(): PhoneProject[] {
    const running = new Map<string, number>();
    for (const sessionId of this.deps.running.runningSessionIds()) {
      const path = this.deps.registry.get(sessionId)?.projectPath;
      if (path) running.set(path, (running.get(path) ?? 0) + 1);
    }
    return routeCandidates(this.deps.projects.list(false)).map(candidate => ({
      path: candidate.projectPath,
      folder: folderName(candidate.projectPath),
      running: running.get(candidate.projectPath) ?? 0,
    }));
  }

  // ── The list ──

  #changed(sessionId: string): void {
    this.#changedAt.set(sessionId, this.deps.clock.now());
    this.#schedulePush();
  }

  #schedulePush(): void {
    if (this.#pushTimer !== null || this.#phones.size === 0) return;
    this.#pushTimer = this.deps.timers.setTimeout(() => {
      this.#pushTimer = null;
      if (this.#phones.size === 0) return;
      this.#broadcast({ type: 'sessions', sessions: this.#sessionList() });
    }, SESSIONS_PUSH_MS);
  }

  /**
   * The running sessions, local and SSH, in the sidebar's order: needing you
   * first, then idle (most recent first), then working (newest started
   * first) — `sessionTier` and the sidebar's sort keys, for live rows only.
   */
  #sessionList(): PhoneSession[] {
    const { registry, running, projects, questions } = this.deps;
    const rows = new Map<string, SessionRow>();
    for (const project of projects.list(true)) {
      for (const row of project.sessions) rows.set(row.sessionId, row);
    }
    const asking = new Set(questions.pending().map(set => set.sessionId));

    const listed: { session: PhoneSession; tier: number; sortTime: number }[] = [];
    for (const sessionId of running.runningSessionIds()) {
      const session = registry.get(sessionId);
      if (!session) continue;
      const row = findRow(rows, session, sessionId);
      const busy = this.#busy.has(sessionId);
      const terminal = this.#attention.has(sessionId);
      const questionsWaiting = asking.has(sessionId);
      const tier = sessionTier({
        needsAttention: terminal || questionsWaiting, responseReady: false, busy, pending: !row, hasLivePty: true,
      });
      const opened = new Date(session.openedAt).toISOString();
      const sortTime = Date.parse(tier === TIER_RUNNING ? row?.created ?? opened : row?.modified ?? opened);
      listed.push({
        tier,
        sortTime: Number.isNaN(sortTime) ? session.openedAt : sortTime,
        session: {
          id: sessionId,
          name: displayName(row, session),
          project: folderName(session.projectPath),
          projectPath: session.projectPath,
          remote: session.remote?.target ?? null,
          state: tier === TIER_ATTENTION ? 'needs-you' : busy ? 'busy' : 'idle',
          waiting: questionsWaiting ? 'questions' : terminal ? 'terminal' : null,
          owner: this.#wireOwner(ownerOf(this.#ownership, sessionId)),
          changedAt: this.#changedAt.get(sessionId) ?? session.openedAt,
        },
      });
    }
    listed.sort((a, b) => b.tier - a.tier || b.sortTime - a.sortTime);
    this.#listed = new Set(listed.map(entry => entry.session.id));
    return listed.map(entry => entry.session);
  }

  // ── Helpers ──

  #broadcast(message: ServerMessage): void {
    for (const phone of this.#phones.values()) phone.connection.send(message);
  }

  /** The id a session is registered under now, from any id it has had; null when it isn't running. */
  #currentId(sessionId: string): string | null {
    return this.deps.registry.find(sessionId)?.key ?? null;
  }

  #wireOwner(device: Device): TerminalOwner {
    if (device === MAC) return { kind: 'mac' };
    return { kind: 'device', deviceId: device, name: this.#names.get(device) ?? 'Phone' };
  }
}

/** Both or neither, as the protocol says. */
function sizeOf(message: { cols?: number; rows?: number }): TerminalSize | undefined {
  return message.cols !== undefined && message.rows !== undefined ? { cols: message.cols, rows: message.rows } : undefined;
}

/** What a reattaching renderer is sent (`SessionLifecycle.replayTo`), in the same order. */
function replay(session: ActiveSession): string[] {
  const chunks: string[] = [];
  if (session.altScreen && !session.isPlainTerminal) chunks.push(ENTER_ALT_SCREEN);
  chunks.push(...session.output.chunks());
  if (!session.isPlainTerminal) chunks.push(HIDE_CURSOR);
  return chunks;
}

/** A running session's row, under its current id or any it has had. */
function findRow(rows: ReadonlyMap<string, SessionRow>, session: ActiveSession, sessionId: string): SessionRow | null {
  for (const id of session.allIds(sessionId)) {
    const row = rows.get(id);
    if (row) return row;
  }
  return null;
}

/** The name the sidebar shows: rename, AI title, first prompt; a row not written yet is a new session. */
function displayName(row: SessionRow | null, session: ActiveSession): string {
  if (!row) return session.isPlainTerminal ? 'Terminal' : NEW_SESSION_NAME;
  return cleanDisplayName(resolveSessionName({ storedName: row.name, aiTitle: row.aiTitle }) || row.summary) || NEW_SESSION_NAME;
}

/** Every routing outcome but confident, which launches, as the phone needs it. */
function phoneAskResult(result: Exclude<RouteResult, { kind: 'confident' }>, candidates: RouteCandidate[]): PhoneAskResult {
  switch (result.kind) {
    case 'unsure':
      return {
        kind: 'unsure',
        prompt: result.prompt,
        candidates: result.candidates.map(path => ({
          path,
          folder: folderName(path),
          recentTitle: candidates.find(candidate => candidate.projectPath === path)?.recentTitles[0] ?? null,
        })),
      };
    case 'noMatch':
      return { kind: 'noMatch', reason: result.reason };
    case 'failed':
      return { kind: 'failed', reason: result.reason };
    case 'cancelled':
      return { kind: 'cancelled' };
  }
}

function moveKey(set: Set<string>, from: string, to: string): void {
  if (set.delete(from)) set.add(to);
}
