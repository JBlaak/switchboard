/**
 * What Quick Ask (#142) does with the text from the pop-up, in main (R1).
 *
 * Main routes it, with an `AskRouteService` of its own making the quick
 * routing call, so the pop-up and the empty-screen box never cancel each
 * other's requests. The answer goes through `quickAskOutcome` (R2), and what
 * that says is done here: a session is handed to the main window's renderer
 * to start (R3), the choices go back to the pop-up, or the main window comes
 * forward with the New Session picker. The pop-up is only told what to show.
 *
 * Starting a session never brings the main window forward: the user stays in
 * the app they were in. A closed main window is opened without focus (R4).
 *
 * A task or a save is written here too, with no session (C2): one `claude -p`
 * call allowed only that server's `capture` tool, from a config file that
 * exists for that call alone. The pop-up is told it is saving as soon as the
 * route says capture, and the ids are kept ten minutes for ⌘Z (C4). A failed
 * capture keeps its `captureId`, and sending the same text again retries it
 * without routing it again, so James never stores it twice (C5).
 *
 * ⌘Enter skips the routing call: a quick session starts on the text as typed.
 *
 * The capture call is cold. Warming it would mean warming both servers'
 * processes each time the pop-up shows, before the route says which one, and
 * keeping a config with the token on disk while they wait; captures are the
 * rare send, so the ~1.5 s that would save isn't worth it.
 */
import { routeCandidates, folderName, NO_MATCH_LINE } from '../../domain/ask/route';
import {
  CAPTURE_SERVERS, captureArgs, noAnswerLine, readCaptureRun, readUndoRun, undoArgs,
} from '../../domain/ask/capture';
import { NO_QUICK_FOLDER_LINE, quickAskOutcome } from '../../domain/ask/quick-ask';
import { quickRouteArgs, quickRouteBootArgs, quickRoutePrompt, readQuickRouteRun } from '../../domain/ask/quick-route';
import type { QuickAskOutcome, QuickAskReply } from '../../domain/ask/quick-ask';
import type { CaptureReceipt } from '../../domain/ask/capture';
import type { CaptureTarget, QuickRouteResult, RouteRequest } from '../../domain/ask/model';
import type { ClaudeRun } from '../../domain/ask/route';
import type { Project } from '../../domain/project/project';
import type { GlobalSettings } from '../../domain/settings/settings';
import type { ClaudeCaller } from '../ports/claude-cli';
import type { TimerHandle, Timers } from '../ports/clock';
import type { IdGenerator } from '../ports/ids';
import type { Logger } from '../ports/logger';
import type { McpServers } from '../ports/mcp-servers';
import type { SkillCatalog } from '../ports/skill-catalog';
import type { MainWindowHost } from '../ports/main-window';
import type { QuickAskPanel } from '../ports/quick-ask-panel';
import type { RendererGateway } from '../ports/renderer-gateway';
import type { RouteCall } from './ask-route-service';

/** Quick Ask's routing call: Ask Patch's, also asking whether it is a capture (C1). */
export const QUICK_ROUTE_CALL: RouteCall<QuickRouteResult> = {
  bootArgs: quickRouteBootArgs, prompt: quickRoutePrompt, args: quickRouteArgs, read: readQuickRouteRun,
};

/** How long a capture or an undo may take before it counts as failed. */
export const CAPTURE_TIMEOUT_MS = 30_000;

/** How long a capture's ids are kept for ⌘Z. */
export const UNDO_KEPT_MS = 10 * 60_000;

/** The part of `AskRouteService` this uses: its own instance, on `QUICK_ROUTE_CALL`. */
export interface QuickRouter {
  route(request: RouteRequest): Promise<QuickRouteResult>;
  cancel(): void;
  warm(): void;
}

export interface QuickAskServiceDeps {
  router: QuickRouter;
  projects: { list(showArchived: boolean): Project[] };
  /** The skills a request may name, so the route keeps their names. */
  skills: SkillCatalog;
  settings: { global(): GlobalSettings };
  renderer: Pick<RendererGateway, 'launchRequested' | 'pickerRequested'>;
  mainWindow: MainWindowHost;
  panel: Pick<QuickAskPanel, 'onShown'>;
  /** The pop-up, told as a capture starts so it can say where it goes. */
  popUp: { saving(target: CaptureTarget): void };
  cli: Pick<ClaudeCaller, 'call'>;
  mcpServers: McpServers;
  ids: IdGenerator;
  timers: Timers;
  log: Logger;
}

/** A capture that failed, kept for the retry (C5). */
interface FailedCapture {
  /** What was typed, so the same send again is the retry. */
  typed: string;
  target: CaptureTarget;
  text: string;
  captureId: string;
}

export class QuickAskService {
  /** The rewritten prompt of the last unsure answer, for a choice from the list or Tab. */
  #choosing: { prompt: string; candidates: string[] } | null = null;
  #failed: FailedCapture | null = null;
  /** The last capture's ids, for ⌘Z, until they expire. */
  #kept: { receipt: CaptureReceipt; timer: TimerHandle } | null = null;

  constructor(private readonly deps: QuickAskServiceDeps) {
    // A process booted while the user types, so Enter waits on the model only (S2).
    deps.panel.onShown(() => deps.router.warm());
  }

  /** Route what was typed and act on the answer. */
  async route(text: string): Promise<QuickAskReply> {
    const { router, projects, log } = this.deps;
    this.#choosing = null;
    const failed = this.#failed;
    if (failed?.typed === text) return this.#capture(failed.target, failed.text, text, failed.captureId);
    this.#failed = null;
    const candidates = routeCandidates(projects.list(false));
    const skills = this.deps.skills.list(candidates.map(candidate => candidate.projectPath));
    const result = await router.route({ text, candidates, skills });
    log.info(`[quick-ask] routed: ${result.kind}`);
    return this.#follow(quickAskOutcome(result, text, this.#quickFolder()), text);
  }

  /**
   * ⌘Enter: a quick session on the text as typed. No routing call, so there
   * is nothing to wait on; without a Quick Session Folder there is nowhere to
   * start it, and the text goes to the picker instead.
   */
  quick(text: string): QuickAskReply {
    this.#choosing = null;
    this.#failed = null;
    const folder = this.#quickFolder();
    if (folder) return this.#launch(folder, text);
    this.#handOff(text, NO_QUICK_FOLDER_LINE);
    return { kind: 'handedOff' };
  }

  /** A choice from the list, started on the rewritten prompt. */
  start(projectPath: string): QuickAskReply {
    const choosing = this.#choosing;
    if (!choosing || !choosing.candidates.includes(projectPath)) return { kind: 'unlocked' };
    this.#choosing = null;
    return this.#launch(projectPath, choosing.prompt);
  }

  /** Tab from the list: the New Session picker in the main window, with the rewritten prompt. */
  openPicker(): void {
    const choosing = this.#choosing;
    if (!choosing) return;
    this.#choosing = null;
    this.#handOff(choosing.prompt);
  }

  /** ⌘Z after a capture: take back what it stored, while its ids are kept. */
  async undo(): Promise<{ ok: boolean }> {
    const kept = this.#kept;
    if (!kept) return { ok: false };
    this.#forget();
    const { target, ids } = kept.receipt;
    const run = await this.#oneToolCall(target, path => undoArgs(target, ids, path));
    const ok = run !== null && readUndoRun(run);
    if (ok) this.deps.log.info(`[quick-ask] undid a capture in ${CAPTURE_SERVERS[target]}`);
    // The ids, so whatever is left can be found and removed by hand.
    else this.deps.log.warn(`[quick-ask] could not undo a capture in ${CAPTURE_SERVERS[target]}: ${ids.join(', ')}`);
    return { ok };
  }

  /** Esc while waiting: the request in flight answers `cancelled`. */
  cancel(): void {
    this.deps.router.cancel();
  }

  #follow(outcome: QuickAskOutcome, text: string): QuickAskReply | Promise<QuickAskReply> {
    switch (outcome.kind) {
      case 'start':
        return this.#launch(outcome.projectPath, outcome.prompt);
      case 'choose':
        this.#choosing = { prompt: outcome.prompt, candidates: outcome.candidates };
        return {
          kind: 'choose',
          candidates: outcome.candidates.map(projectPath => ({ projectPath, folder: folderName(projectPath) })),
        };
      case 'picker':
        this.#handOff(outcome.prompt, outcome.reason);
        return { kind: 'handedOff' };
      case 'capture':
        return this.#capture(outcome.target, outcome.text, text, this.deps.ids.newId());
      case 'unlock':
        return { kind: 'unlocked' };
    }
  }

  /**
   * Write a task or a save. A server that isn't set up in Claude Code takes
   * the no-match path, with the text as typed (C6).
   */
  async #capture(target: CaptureTarget, text: string, typed: string, captureId: string): Promise<QuickAskReply> {
    const { mcpServers, popUp, log } = this.deps;
    this.#failed = null;
    if (!mcpServers.has(CAPTURE_SERVERS[target])) {
      log.info(`[quick-ask] ${CAPTURE_SERVERS[target]} isn't set up; no match instead`);
      return this.#follow(quickAskOutcome({ kind: 'noMatch', reason: NO_MATCH_LINE }, typed, this.#quickFolder()), typed);
    }
    popUp.saving(target);
    const run = await this.#oneToolCall(target, path => captureArgs(target, text, captureId, path));
    const read = run ? readCaptureRun(run, target) : { kind: 'failed' as const, reason: noAnswerLine(target) };
    if ('kind' in read) {
      log.warn(`[quick-ask] capture into ${CAPTURE_SERVERS[target]} failed`);
      this.#failed = { typed, target, text, captureId };
      return { kind: 'captureFailed', reason: read.reason };
    }
    log.info(`[quick-ask] captured into ${CAPTURE_SERVERS[target]}: ${read.ids.join(', ')}`);
    this.#keep(read);
    return { kind: 'saved', target, summary: read.summary };
  }

  /**
   * One call allowed a single tool of `target`'s server, from a config written
   * for it and removed however the call ends. Null when it couldn't run: the
   * server went missing, the config couldn't be written, `claude` couldn't
   * start, or it took too long and was killed.
   */
  async #oneToolCall(target: CaptureTarget, args: (mcpConfigPath: string) => string[]): Promise<ClaudeRun | null> {
    const { mcpServers, cli, timers, log } = this.deps;
    const controller = new AbortController();
    const timer = timers.setTimeout(() => {
      log.warn('[quick-ask] capture call timed out');
      controller.abort();
    }, CAPTURE_TIMEOUT_MS);
    let config: ReturnType<McpServers['write']> = null;
    try {
      config = mcpServers.write(CAPTURE_SERVERS[target]);
      if (!config) return null;
      const run = await cli.call(args(config.path), controller.signal);
      return controller.signal.aborted ? null : run;
    } catch (err) {
      log.error('[quick-ask] could not run the capture call:', (err as Error).message);
      return null;
    } finally {
      timers.clearTimeout(timer);
      config?.remove();
    }
  }

  /** Hold the ids for ⌘Z, for ten minutes; a newer capture replaces them. */
  #keep(receipt: CaptureReceipt): void {
    this.#forget();
    const timer = this.deps.timers.setTimeout(() => { this.#kept = null; }, UNDO_KEPT_MS);
    this.#kept = { receipt, timer };
  }

  #forget(): void {
    if (this.#kept) this.deps.timers.clearTimeout(this.#kept.timer);
    this.#kept = null;
  }

  /** The session starts in the main window, which stays where it is. */
  #launch(projectPath: string, prompt: string): QuickAskReply {
    this.deps.mainWindow.ensureOpen();
    this.deps.renderer.launchRequested(projectPath, prompt);
    return { kind: 'started', folder: folderName(projectPath) };
  }

  #handOff(prompt: string, reason?: string): void {
    this.deps.mainWindow.bringForward();
    this.deps.renderer.pickerRequested(prompt, reason);
  }

  /** The Quick Session Folder, or '' when none is set. */
  #quickFolder(): string {
    const folder = this.deps.settings.global().quickSessionPath;
    return typeof folder === 'string' ? folder.trim() : '';
  }
}
