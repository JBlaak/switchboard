/**
 * Test doubles for the ports.
 *
 * One of the points of the ports is that a double is a few lines rather than a
 * mocking framework, and that a test can assert on what a use case *asked for*
 * rather than on what the OS did. These are shared because several tests want
 * the same fake clock and the same recording gateway.
 */
import type { PendingQuestions, QuestionsSettled } from '../../src/domain/questions/question';
import type { RemoteStatusPayload } from '../../src/domain/remote/remote-status';
import type { WorkingAgent } from '../../src/domain/terminal/program-status-children';
import type { RepositoryIssue, RepositoryPullRequest, WorktreeSummary } from '../../src/domain/project/overview';
import type { Timers } from '../../src/application/ports/clock';
import type { GitWorkspace, GitWrite } from '../../src/application/ports/git-workspace';
import type { BranchWorktreesDeps } from '../../src/application/services/branch-worktrees';
import type { RouteRequest, RouteResult } from '../../src/domain/ask/model';
import type { GitHubCli, ProjectReads } from '../../src/application/ports/github-cli';
import type { Logger } from '../../src/application/ports/logger';
import type { RendererGateway } from '../../src/application/ports/renderer-gateway';
import type { SessionTaskLink, TaskLinkStore } from '../../src/application/ports/task-link-store';
import type { TaskLink } from '../../src/domain/tasks/links';
import type {
  PtyHandle, SpawnSpec, TerminalGateway,
} from '../../src/application/ports/terminal-gateway';

export const silentLog: Logger = {
  debug() {}, info() {}, warn() {}, error() {},
};

// ── A fake clock ──

export interface FakeTimers extends Timers {
  /** Run every callback that is currently due; each may schedule the next. */
  tick(): void;
  /** How many callbacks are still pending. */
  readonly pending: number;
}

/**
 * Timers that never touch the real clock.
 *
 * `tick` runs one *round*: the callbacks scheduled before it was called. That
 * is what lets an escalation ladder be walked a rung at a time, which is the
 * whole reason the delays are injected.
 */
export function fakeTimers(): FakeTimers {
  let seq = 0;
  const scheduled = new Map<number, () => void>();

  return {
    setTimeout(fn) {
      const id = ++seq;
      scheduled.set(id, fn);
      return id;
    },
    clearTimeout(handle) {
      if (handle != null) scheduled.delete(handle as number);
    },
    setInterval(fn) {
      const id = ++seq;
      scheduled.set(id, fn);
      return id;
    },
    clearInterval(handle) {
      if (handle != null) scheduled.delete(handle as number);
    },
    tick() {
      for (const [id, fn] of [...scheduled]) {
        scheduled.delete(id);
        fn();
      }
    },
    get pending() {
      return scheduled.size;
    },
  };
}

// ── A fake PTY ──

export interface FakePty extends PtyHandle {
  /** Every `kill(signal)` this handle saw, in order. */
  readonly kills: (NodeJS.Signals | undefined)[];
  /** Everything written to it. */
  readonly writes: string[];
  /** Push a chunk as if the process had printed it. */
  emitData(data: string): void;
  /** End it, as if the process had exited. */
  emitExit(exitCode: number, signal?: number): void;
}

export function fakePty(pid = 4242): FakePty {
  return makePty(pid);
}

/**
 * A handle whose process is already gone.
 *
 * `fakePty(undefined)` cannot express this: a JS default parameter applies to
 * `undefined`, so it would hand back the default pid.
 */
export function pidlessPty(): FakePty {
  return makePty(undefined);
}

function makePty(pid: number | undefined): FakePty {
  const kills: (NodeJS.Signals | undefined)[] = [];
  const writes: string[] = [];
  let onData: ((data: string) => void) | null = null;
  let onExit: ((e: { exitCode: number; signal?: number }) => void) | null = null;

  return {
    pid,
    disposed: false,
    kills,
    writes,
    write(data) { writes.push(data); },
    resize() {},
    onData(listener) { onData = listener; },
    onExit(listener) { onExit = listener; },
    kill(signal) { kills.push(signal); },
    emitData(data) { onData?.(data); },
    emitExit(exitCode, signal) { onExit?.({ exitCode, signal }); },
  };
}

// ── A fake terminal gateway ──

export interface FakeTerminals extends TerminalGateway {
  /** Every spawn it was asked for. */
  readonly spawns: SpawnSpec[];
  /** Every `signalTree` call, as [pid, signal]. */
  readonly signals: [number | undefined, NodeJS.Signals][];
  /** The pids it should report as still running. */
  readonly alive: Set<number>;
  /** The handle the next spawn will return. */
  nextPty: FakePty;
}

export function fakeTerminals(alive: Iterable<number> = [4242]): FakeTerminals {
  const spawns: SpawnSpec[] = [];
  const signals: [number | undefined, NodeJS.Signals][] = [];
  const aliveSet = new Set(alive);

  const gateway: FakeTerminals = {
    spawns,
    signals,
    alive: aliveSet,
    nextPty: fakePty(),
    baseEnv: {},
    spawn(spec) {
      spawns.push(spec);
      return gateway.nextPty;
    },
    signalTree(handle, signal) {
      signals.push([handle.pid, signal]);
      return true;
    },
    isAlive(handle) {
      return handle.pid !== undefined && aliveSet.has(handle.pid);
    },
  };
  return gateway;
}

// ── A recording renderer gateway ──

/** One event the fake gateway saw: the method name and its arguments. */
export type RecordedEvent = [string, ...unknown[]];

export interface FakeRenderer extends RendererGateway {
  readonly events: RecordedEvent[];
  /** Just the events of one kind, for the common single-channel assertion. */
  only(kind: string): RecordedEvent[];
}

export function fakeRenderer(): FakeRenderer {
  const events: RecordedEvent[] = [];
  const record = (kind: string) => (...args: unknown[]): void => {
    events.push([kind, ...args]);
  };

  return {
    events,
    only: (kind) => events.filter(e => e[0] === kind),
    attached: true,
    terminalData: record('terminalData'),
    processExited: record('processExited'),
    sessionForked: record('sessionForked'),
    cliBusyState: record('cliBusyState'),
    terminalNotification: record('terminalNotification'),
    sessionNeedsAttention: record('sessionNeedsAttention'),
    sessionAgents: record('sessionAgents') as (id: string, agents: WorkingAgent[]) => void,
    remoteStatus: record('remoteStatus') as (id: string, s: RemoteStatusPayload) => void,
    questionsAsked: record('questionsAsked') as (pending: PendingQuestions) => void,
    questionsSettled: record('questionsSettled') as (settled: QuestionsSettled) => void,
    projectsChanged: record('projectsChanged'),
    statusUpdate: record('statusUpdate'),
    fullscreenChanged: record('fullscreenChanged'),
    updateAvailable: record('updateAvailable'),
    sessionWorkSnapshot: record('sessionWorkSnapshot'),
    prStatusChanged: record('prStatusChanged'),
    launchRequested: record('launchRequested'),
    pickerRequested: record('pickerRequested'),
    phoneAccessChanged: record('phoneAccessChanged'),
    terminalOwnerChanged: record('terminalOwnerChanged'),
    sessionStarted: record('sessionStarted'),
    sessionArchived: record('sessionArchived'),
    tasksChanged: record('tasksChanged'),
    sessionTaskChanged: record('sessionTaskChanged'),
  };
}

// ── The project page's reads (#167) ──

export interface FakeProjectGitHub extends Pick<GitHubCli, ProjectReads> {
  /** What `issuesIn` answers; null as when `gh` could not be asked. */
  issues: RepositoryIssue[] | null;
  /** What `pullRequestsIn` answers; null as when `gh` could not be asked. */
  pullRequests: RepositoryPullRequest[] | null;
  /** Every read it was asked for, as `issuesIn owner/repo` or `pullRequestsIn owner/repo`. */
  readonly calls: string[];
}

/**
 * A repository's issues and PRs, as `gh` would answer them. Closed issues and
 * merged PRs are only answered when asked for, like the real reads.
 */
export function fakeProjectGitHub(
  issues: RepositoryIssue[] | null = [],
  pullRequests: RepositoryPullRequest[] | null = [],
): FakeProjectGitHub {
  const fake: FakeProjectGitHub = {
    issues,
    pullRequests,
    calls: [],
    async issuesIn(repo, options) {
      fake.calls.push('issuesIn ' + repo);
      return fake.issues && fake.issues.filter((issue) => options.closed || issue.state === 'open');
    },
    async pullRequestsIn(repo, options) {
      fake.calls.push('pullRequestsIn ' + repo);
      return fake.pullRequests && fake.pullRequests.filter((pr) => options.merged || pr.state === 'open');
    },
  };
  return fake;
}

export interface FakeWorktrees extends Pick<GitWorkspace, 'worktrees'> {
  /** The checkouts each repository answers with; any other answers none. */
  readonly byRepository: Map<string, WorktreeSummary[]>;
  /** Every repository it was asked about. */
  readonly calls: string[];
}

export function fakeWorktrees(byRepository: Record<string, WorktreeSummary[]> = {}): FakeWorktrees {
  const fake: FakeWorktrees = {
    byRepository: new Map(Object.entries(byRepository)),
    calls: [],
    async worktrees(repository) {
      fake.calls.push(repository);
      return fake.byRepository.get(repository) ?? [];
    },
  };
  return fake;
}

// ── A phone's connection (#194) ──

import type { DeviceConnection } from '../../src/application/ports/phone-access';
import type { ServerMessage } from '../../src/domain/phone/protocol';

export interface FakeDeviceConnection extends DeviceConnection {
  /** Every JSON message sent to it, in order. */
  readonly sent: ServerMessage[];
  /** Every terminal frame sent to it, as [session id, output]. */
  readonly frames: [string, string][];
  /** Set once `close` was called. */
  closed: { code: number; reason: string } | null;
  /** Just the messages of one type. */
  of<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[];
  /** Forget what it was sent so far. */
  clear(): void;
}

export function fakeDeviceConnection(id = 'conn-1', deviceId = 'phone-1'): FakeDeviceConnection {
  const fake: FakeDeviceConnection = {
    id,
    fingerprint: `fp-${deviceId}`,
    grant: { kind: 'device', deviceId },
    sent: [],
    frames: [],
    closed: null,
    send(message) { fake.sent.push(message); },
    sendTerminal(sessionId, data) { fake.frames.push([sessionId, data]); },
    close(code, reason) { fake.closed = { code, reason }; },
    of: (type) => fake.sent.filter(message => message.type === type) as never,
    clear() {
      fake.sent.length = 0;
      fake.frames.length = 0;
    },
  };
  return fake;
}

/** A fake PTY that also records every resize, as [cols, rows]. */
export function resizingPty(pid = 4242): FakePty & { readonly resizes: [number, number][] } {
  const resizes: [number, number][] = [];
  const pty = makePty(pid);
  return Object.assign(pty, { resizes, resize(cols: number, rows: number) { resizes.push([cols, rows]); } });
}

// ── A repository to start sessions in ──

/** A repository with `main` on origin, for starting a session on a branch: records every write. */
export class FakeStartGit {
  readonly writes: string[] = [];
  readonly branches = new Set<string>(['main']);
  readonly remoteBranches = new Set<string>(['main']);
  /** Branches whose fetch fails, with git's reason. */
  readonly unfetchable = new Map<string, string>();
  checkout: string | null;
  current = new Map<string, string>();
  /** The checkouts `worktrees` lists, the main one first. */
  checkouts: WorktreeSummary[] = [];
  /** A write that fails, by its first word (`remove`, `delete`, `checkout`), with git's reason. */
  readonly failing = new Map<string, string>();

  /** `root` is the main checkout `mainCheckout` answers. */
  constructor(root: string) {
    this.checkout = root;
  }

  readonly port: BranchWorktreesDeps['git'] = {
    mainCheckout: async () => this.checkout,
    defaultBranch: async () => 'main',
    currentBranch: async (worktree) => this.current.get(worktree) ?? null,
    branchExists: async (_repo, branch) => this.branches.has(branch),
    commitSha: async (_repo, ref) => {
      if (ref.startsWith('origin/')) return this.remoteBranches.has(ref.slice('origin/'.length)) ? 'sha' : null;
      return this.branches.has(ref) ? 'sha' : null;
    },
    fetchBranch: async (_repo, branch): Promise<GitWrite> => {
      this.writes.push('fetch ' + branch);
      const reason = this.unfetchable.get(branch);
      return reason ? { ok: false, reason } : { ok: true };
    },
    addWorktree: async (_repo, path, branch, base): Promise<GitWrite> => {
      this.writes.push(`worktree add -b ${branch} ${path} ${base}`);
      this.branches.add(branch);
      return { ok: true };
    },
    worktrees: async () => this.checkouts,
    checkoutWorktree: async (_repo, path, branch) => this.write('checkout', `worktree add ${path} ${branch}`),
    removeWorktree: async (_repo, path, options) => this.write('remove', `worktree remove ${options?.force ? '--force ' : ''}${path}`),
    pruneWorktrees: async () => this.write('prune', 'worktree prune'),
    deleteBranch: async (_repo, branch) => {
      const result = this.write('delete', 'branch -D ' + branch);
      if (result.ok) this.branches.delete(branch);
      return result;
    },
  };

  private write(kind: string, command: string): GitWrite {
    this.writes.push(command);
    const reason = this.failing.get(kind);
    return reason ? { ok: false, reason } : { ok: true };
  }
}

// ── Ask Patch's routing call ──

export interface FakeRouter {
  route(request: RouteRequest): Promise<RouteResult>;
  /** Every request it was asked, in order. */
  readonly requests: RouteRequest[];
}

/** A router that answers every request with `result`. */
export function fakeRouter(result: RouteResult): FakeRouter {
  const requests: RouteRequest[] = [];
  return {
    requests,
    async route(request) {
      requests.push(request);
      return result;
    },
  };
}

// ── Task links (#245) ──

/** The store as the SQLite one behaves: one link per session, one repo set by hand per task. */
export class MemoryTaskLinkStore implements TaskLinkStore {
  links: TaskLink[] = [];
  unlinks = new Map<string, number>();
  all(): TaskLink[] { return [...this.links]; }
  forTask(taskId: string): TaskLink[] { return this.links.filter((link) => link.taskId === taskId); }
  forSession(sessionId: string): TaskLink | null { return this.links.find((link) => link.sessionId === sessionId) ?? null; }
  link(link: SessionTaskLink): void {
    this.links = this.links.filter((other) => other.sessionId !== link.sessionId);
    this.links.push({ ...link });
    this.unlinks.delete(link.sessionId);
  }
  unlink(sessionId: string, at: number): void {
    this.links = this.links.filter((link) => link.sessionId !== sessionId);
    this.unlinks.set(sessionId, at);
  }
  unlinkedAt(sessionId: string): number | null { return this.unlinks.get(sessionId) ?? null; }
  setRepo(taskId: string, projectPath: string, at: number): void {
    this.links = this.links.filter((link) => !(link.taskId === taskId && link.sessionId === null));
    this.links.push({ taskId, projectPath, sessionId: null, source: 'manual', linkedAt: at });
  }
}
