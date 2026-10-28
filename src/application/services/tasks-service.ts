/**
 * BlaakTasks in the app (#248): the one door every task call goes through.
 *
 * The task services — the adapter, `TaskLinkService`, `TaskSessionService` and
 * `TaskWritesService` — exist only while a BlaakTasks URL is set. They are
 * built the first time something asks with the URL set, and built again when
 * the URL has changed since; with no URL there are none, and every call here
 * answers `off` (or nothing) without reaching BlaakTasks.
 *
 * It also holds what ties them to the rest of the app:
 *
 * - the poll: about once a minute, only while a renderer surface watches a
 *   list, sending what did not get through (`retry`) and pushing each watched
 *   list (`tasksChanged`), its last rows kept when BlaakTasks is down;
 * - the events: a start from a task links its session and writes In progress,
 *   a transcript that changed is read for the task it names and for new PRs,
 *   an archive writes its line and says whether to offer Mark done;
 * - `sessionTaskChanged` for every link made or dropped.
 */
import type { BlaakTasksResult, TaskDetail, TaskRow } from '../../domain/tasks/model';
import type { TaskLinkSource } from '../../domain/tasks/links';
import type { SessionPullRequest } from '../../domain/session/session';
import type {
  MarkDoneOffer, TaskChange, TaskQuery, TaskSessions, TaskStartPreparation, TaskStartRequest,
  TaskUpdateResult, TasksUpdate,
} from '../../domain/tasks/surface';
import type { BlaakTasks } from '../ports/blaak-tasks';
import type { Clock, TimerHandle, Timers } from '../ports/clock';
import type { Logger } from '../ports/logger';
import type { RendererGateway } from '../ports/renderer-gateway';
import type { TaskLinkService } from './task-link-service';
import type { TaskSessionService } from './task-session-service';
import type { TaskWritesService } from './task-writes-service';

/** How often a watched list is asked again. */
export const TASKS_POLL_MS = 60_000;

/** The services that exist while a BlaakTasks URL is set, built together for one URL. */
export interface TaskServices {
  tasks: BlaakTasks;
  links: TaskLinkService;
  starts: Pick<TaskSessionService, 'prepare'>;
  writes: TaskWritesService;
}

/** A running session whose transcript may say which task it works on. */
export interface TranscriptSession {
  sessionId: string;
  /** The directory it runs in. */
  projectPath: string;
}

export interface TasksServiceDeps {
  /** The BlaakTasks URL in Settings, '' while it is off. */
  url(): string;
  /** Build the services for this URL; called only with a URL set. */
  build(url: string): TaskServices;
  renderer: Pick<RendererGateway, 'tasksChanged' | 'sessionTaskChanged'>;
  /** The running Claude sessions whose transcripts are in this folder. */
  sessionsIn(folder: string): TranscriptSession[];
  /** A transcript's latest lines, enough to find its latest BlaakTasks call. */
  transcript(folder: string, sessionId: string): string[];
  /** When the transcript was last written, epoch ms; null when it has none. */
  modifiedAt(folder: string, sessionId: string): number | null;
  /** The PRs a session opened, from its transcript's `pr-link` lines. */
  pullRequests(sessionId: string): readonly SessionPullRequest[];
  /** Whether the session is archived: its PRs are not replayed when the services are built. */
  archived(sessionId: string): boolean;
  /** The directory a session runs in; null when there is no such session. */
  sessionProject(sessionId: string): string | null;
  /** A directory's repository: its main checkout, or the directory itself outside git. */
  repoRoot(projectPath: string): Promise<string>;
  clock: Clock;
  timers: Timers;
  log: Logger;
}

interface Watch {
  query: TaskQuery;
  rows: TaskRow[];
  fetchedAt: number | null;
}

export class TasksService {
  #built: { url: string; services: TaskServices } | null = null;
  readonly #watches = new Map<string, Watch>();
  #interval: TimerHandle | null = null;
  #polling: Promise<void> | null = null;
  /** The transcript write each session was last read at, so an unchanged one is not read again. */
  readonly #scanned = new Map<string, number>();

  constructor(private readonly deps: TasksServiceDeps) {}

  /**
   * The services for the URL in Settings, built or rebuilt as it says; null
   * while it is empty. Building replays the PRs of the linked sessions, which
   * the writes service writes once each.
   */
  services(): TaskServices | null {
    const url = this.deps.url().trim();
    if (!url) {
      if (this.#built) this.deps.log.info('[tasks] BlaakTasks switched off');
      this.#built = null;
      return null;
    }
    if (this.#built?.url === url) return this.#built.services;
    this.deps.log.info(this.#built ? '[tasks] the BlaakTasks URL changed; rebuilding' : '[tasks] BlaakTasks on');
    const services = this.deps.build(url);
    this.#built = { url, services };
    this.#scanned.clear();
    this.#replay(services);
    return services;
  }

  /** At startup: build the services when the URL is set, so linked sessions' PRs catch up. */
  start(): void {
    this.services();
  }

  // ── Reading ──

  list(query: TaskQuery): Promise<BlaakTasksResult<TaskRow[]>> {
    const services = this.services();
    if (!services) return Promise.resolve({ kind: 'off' });
    return services.tasks.list(query.view, query.options);
  }

  get(taskId: string): Promise<BlaakTasksResult<TaskDetail>> {
    const services = this.services();
    if (!services) return Promise.resolve({ kind: 'off' });
    return services.tasks.get(taskId);
  }

  /** The task a session works on, or null. */
  sessionTask(sessionId: string): string | null {
    return this.services()?.links.taskOf(sessionId) ?? null;
  }

  /** Every linked session's task, by session id. */
  sessionTasks(): Record<string, string> {
    return this.services()?.links.sessionTasks() ?? {};
  }

  /** A task's sessions, the most recently linked first, and its owner. */
  taskSessions(taskId: string): TaskSessions {
    const links = this.services()?.links;
    if (!links) return { sessions: [], owner: null };
    return { sessions: links.sessionsOf(taskId), owner: links.ownerOf(taskId) };
  }

  /** The tasks whose repo is this project, the most recently linked first. */
  projectTasks(projectPath: string): string[] {
    return this.services()?.links.tasksIn(projectPath) ?? [];
  }

  // ── Changing ──

  /** ★, snooze or Done. Done goes through the writes queue, so it is retried until it gets through. */
  async update(taskId: string, change: TaskChange): Promise<TaskUpdateResult> {
    const services = this.services();
    if (!services) return { kind: 'off' };
    let result: TaskUpdateResult;
    if (change.kind === 'done') {
      const outcome = await services.writes.markDone(taskId);
      result = outcome === 'sent' ? { kind: 'ok', value: null }
        : outcome === 'queued' ? { kind: 'queued' }
        : { kind: 'failed', reason: outcome === 'skipped' ? 'Not a task id: ' + taskId : 'BlaakTasks did not take it' };
    } else {
      result = await services.tasks.update(taskId, change.kind === 'star' ? { today: change.today } : { snoozedUntil: change.until });
    }
    if (result.kind === 'ok') this.#refresh();
    return result;
  }

  /** Moves the task to another repo by hand. */
  setRepo(taskId: string, projectPath: string): void {
    this.#require().links.setRepo(taskId, projectPath);
  }

  /** The worktree and prompt of a new session on the task, or why there is none yet. */
  prepareStart(request: TaskStartRequest): Promise<TaskStartPreparation> {
    const services = this.services();
    if (!services) return Promise.resolve({ kind: 'off' });
    const { task, projectPath, existing } = request;
    return services.starts.prepare(task, { ...(projectPath ? { projectPath } : {}), ...(existing ? { existing } : {}) });
  }

  /**
   * A session started from the task has actually started: it is linked (its
   * project is the repository's main checkout), and the task is set In
   * progress and starred in the background, never holding the session up.
   */
  sessionStarted(taskId: string, sessionId: string, projectPath: string): void {
    const services = this.#require();
    this.#link(services, taskId, sessionId, projectPath, 'start');
    void services.writes.sessionStarted(sessionId).then((outcome) => {
      if (outcome === 'sent') this.#refresh();
    });
  }

  /** "Link task…": the session works on this task now, in its repository. */
  async link(sessionId: string, taskId: string): Promise<void> {
    const services = this.#require();
    const projectPath = this.deps.sessionProject(sessionId);
    if (!projectPath) throw new Error('No such session: ' + sessionId);
    this.#link(services, taskId, sessionId, await this.deps.repoRoot(projectPath), 'manual');
  }

  /** The session no longer works on a task. */
  unlink(sessionId: string): void {
    this.#require().links.unlink(sessionId);
    this.deps.renderer.sessionTaskChanged(sessionId, null);
  }

  // ── Events from the rest of the app ──

  /**
   * A session was archived: a line on its task, and whether to offer Mark
   * done — only when you archived it (`byUser`) and every PR it opened is merged.
   */
  async archived(sessionId: string, archive: { byUser: boolean }): Promise<MarkDoneOffer | null> {
    const services = this.services();
    if (!services) return null;
    const taskId = services.links.taskOf(sessionId);
    if (!taskId) return null;
    try {
      return (await services.writes.sessionArchived(sessionId, archive)) ? { taskId } : null;
    } catch (err) {
      this.deps.log.error('[tasks] archiving a task session:', (err as Error).message);
      return null;
    }
  }

  /**
   * The CLI wrote to transcripts in this folder: each running session there
   * written since its last read is read for the task its BlaakTasks calls name,
   * and its PRs (the `pr-link`s the index just read) go on its task.
   */
  async transcriptsChanged(folder: string): Promise<void> {
    const services = this.services();
    if (!services) return;
    for (const session of this.deps.sessionsIn(folder)) {
      try {
        await this.#scan(services, folder, session);
        this.#pullRequests(services, session.sessionId);
      } catch (err) {
        this.deps.log.error('[tasks] reading a transcript for its task:', (err as Error).message);
      }
    }
  }

  // ── The poll ──

  /**
   * A surface shows this list (or, with null, only wants the poll running);
   * asked now, then on every poll until `unwatch`. Watching again under the
   * same id replaces its query.
   */
  watch(watchId: string, query: TaskQuery | null): void {
    const previous = this.#watches.get(watchId);
    const same = previous && query && JSON.stringify(previous.query) === JSON.stringify(query);
    if (query) this.#watches.set(watchId, same ? previous : { query, rows: [], fetchedAt: null });
    else this.#watches.set(watchId, { query: NO_LIST, rows: [], fetchedAt: null });
    if (this.#interval === null) {
      this.#interval = this.deps.timers.setInterval(() => void this.poll(), TASKS_POLL_MS);
    }
    if (query && !same) void this.#fetch(watchId);
  }

  unwatch(watchId: string): void {
    this.#watches.delete(watchId);
    if (this.#watches.size === 0) this.#stopPolling();
  }

  /** Every surface went away (the window closed): nothing is polled. */
  unwatchAll(): void {
    this.#watches.clear();
    this.#stopPolling();
  }

  /** Whether a surface is watching, so the poll runs. */
  get polling(): boolean {
    return this.#interval !== null;
  }

  /** Send what did not get through, then ask every watched list again. One at a time. */
  poll(): Promise<void> {
    if (this.#polling) return this.#polling;
    this.#polling = this.#poll().finally(() => { this.#polling = null; });
    return this.#polling;
  }

  async #poll(): Promise<void> {
    const services = this.services();
    if (services) {
      try {
        await services.writes.retry();
      } catch (err) {
        this.deps.log.error('[tasks] retrying writes:', (err as Error).message);
      }
    }
    await Promise.all([...this.#watches.keys()].map((watchId) => this.#fetch(watchId)));
  }

  /** Ask a watched list again, and push how it stands. */
  async #fetch(watchId: string): Promise<void> {
    const watch = this.#watches.get(watchId);
    if (!watch || watch.query === NO_LIST) return;
    const { query } = watch;
    const result = await this.list(query);
    // Unwatched, or watching another list, while it was asked.
    if (this.#watches.get(watchId)?.query !== query) return;
    if (result.kind === 'ok') {
      watch.rows = result.value;
      watch.fetchedAt = this.deps.clock.now();
    } else if (result.kind === 'off' || result.kind === 'notSetUp') {
      watch.rows = [];
      watch.fetchedAt = null;
    }
    const update: TasksUpdate = {
      watchId, query, state: result.kind === 'ok' ? 'ok' : result.kind,
      rows: watch.rows, fetchedAt: watch.fetchedAt,
      ...(result.kind === 'unreachable' || result.kind === 'failed' ? { reason: result.reason } : {}),
    };
    this.deps.renderer.tasksChanged(update);
  }

  /** A change made from here: the watched lists show it now rather than within the minute. */
  #refresh(): void {
    if (this.#watches.size > 0) void Promise.all([...this.#watches.keys()].map((watchId) => this.#fetch(watchId)));
  }

  #stopPolling(): void {
    if (this.#interval === null) return;
    this.deps.timers.clearInterval(this.#interval);
    this.#interval = null;
  }

  // ── Links ──

  #require(): TaskServices {
    const services = this.services();
    if (!services) throw new Error('BlaakTasks is off: no URL is set in Settings');
    return services;
  }

  #link(services: TaskServices, taskId: string, sessionId: string, projectPath: string, source: TaskLinkSource): void {
    const link = services.links.link(taskId, sessionId, projectPath, source);
    this.deps.renderer.sessionTaskChanged(sessionId, link.taskId);
  }

  async #scan(services: TaskServices, folder: string, session: { sessionId: string; projectPath: string }): Promise<void> {
    const at = this.deps.modifiedAt(folder, session.sessionId);
    if (at === null || this.#scanned.get(session.sessionId) === at) return;
    this.#scanned.set(session.sessionId, at);
    const lines = this.deps.transcript(folder, session.sessionId);
    const projectPath = await this.deps.repoRoot(session.projectPath);
    const link = services.links.scan(session.sessionId, lines, projectPath);
    if (link) this.deps.renderer.sessionTaskChanged(session.sessionId, link.taskId);
  }

  /** The session's PRs, each written on its task once; nothing without a task. */
  #pullRequests(services: TaskServices, sessionId: string): void {
    if (!services.links.taskOf(sessionId)) return;
    for (const pr of this.deps.pullRequests(sessionId)) void services.writes.pullRequestOpened(sessionId, pr);
  }

  /** Every linked session still in play has its PRs written, once each. */
  #replay(services: TaskServices): void {
    try {
      for (const sessionId of Object.keys(services.links.sessionTasks())) {
        if (!this.deps.archived(sessionId)) this.#pullRequests(services, sessionId);
      }
    } catch (err) {
      this.deps.log.error('[tasks] replaying the PRs of linked sessions:', (err as Error).message);
    }
  }
}

/** A watch that only keeps the poll running: nothing is listed for it. */
const NO_LIST: TaskQuery = Object.freeze({ view: 'today' }) as TaskQuery;
