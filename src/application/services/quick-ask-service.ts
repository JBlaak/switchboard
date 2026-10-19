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
 */
import { routeCandidates, folderName, NO_MATCH_LINE } from '../../domain/ask/route';
import { quickAskOutcome } from '../../domain/ask/quick-ask';
import { quickRouteArgs, quickRouteBootArgs, quickRoutePrompt, readQuickRouteRun } from '../../domain/ask/quick-route';
import type { QuickAskOutcome, QuickAskReply } from '../../domain/ask/quick-ask';
import type { QuickRouteResult, RouteRequest } from '../../domain/ask/model';
import type { Project } from '../../domain/project/project';
import type { GlobalSettings } from '../../domain/settings/settings';
import type { Logger } from '../ports/logger';
import type { MainWindowHost } from '../ports/main-window';
import type { QuickAskPanel } from '../ports/quick-ask-panel';
import type { RendererGateway } from '../ports/renderer-gateway';
import type { RouteCall } from './ask-route-service';

/** Quick Ask's routing call: Ask Patch's, also asking whether it is a capture (C1). */
export const QUICK_ROUTE_CALL: RouteCall<QuickRouteResult> = {
  bootArgs: quickRouteBootArgs, prompt: quickRoutePrompt, args: quickRouteArgs, read: readQuickRouteRun,
};

/** The part of `AskRouteService` this uses: its own instance, on `QUICK_ROUTE_CALL`. */
export interface QuickRouter {
  route(request: RouteRequest): Promise<QuickRouteResult>;
  cancel(): void;
  warm(): void;
}

export interface QuickAskServiceDeps {
  router: QuickRouter;
  projects: { list(showArchived: boolean): Project[] };
  settings: { global(): GlobalSettings };
  renderer: Pick<RendererGateway, 'launchRequested' | 'pickerRequested'>;
  mainWindow: MainWindowHost;
  panel: Pick<QuickAskPanel, 'onShown'>;
  log: Logger;
}

export class QuickAskService {
  /** The rewritten prompt of the last unsure answer, for a choice from the list or Tab. */
  #choosing: { prompt: string; candidates: string[] } | null = null;

  constructor(private readonly deps: QuickAskServiceDeps) {
    // A process booted while the user types, so Enter waits on the model only (S2).
    deps.panel.onShown(() => deps.router.warm());
  }

  /** Route what was typed and act on the answer. */
  async route(text: string): Promise<QuickAskReply> {
    const { router, projects, log } = this.deps;
    this.#choosing = null;
    const result = await router.route({ text, candidates: routeCandidates(projects.list(false)) });
    log.info(`[quick-ask] routed: ${result.kind}`);
    return this.#follow(quickAskOutcome(result, text, this.#quickFolder()), text);
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

  /** Esc while waiting: the request in flight answers `cancelled`. */
  cancel(): void {
    this.deps.router.cancel();
  }

  #follow(outcome: QuickAskOutcome, text: string): QuickAskReply {
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
      // Until #151 writes captures, one goes where nothing fits.
      case 'capture':
        return this.#follow(quickAskOutcome({ kind: 'noMatch', reason: NO_MATCH_LINE }, text, this.#quickFolder()), text);
      case 'unlock':
        return { kind: 'unlocked' };
    }
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
