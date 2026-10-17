/**
 * The Session work page's back end: one session's footprint, kept current
 * while the page is open.
 *
 * Opening the page reads where the session worked (its transcripts), what git
 * says about each of those worktrees and branches, and what `gh` says about
 * its PRs and issues, and turns that into a snapshot the renderer draws. While
 * it stays open, git's watchers and the transcript's writes rebuild it (once
 * per burst), and `gh` is asked again every minute; a snapshot is pushed only
 * when something in it changed.
 *
 * The page is transient (D4): only one is open at a time, and opening another
 * session's closes the first. Nothing here writes to git or GitHub (A1). The
 * actions on its items are the action service's: their phases are laid over
 * the items, and while a Ship it is under way `gh` is asked every 20 seconds.
 *
 * Errors belong to the item they happened to. A PR whose status `gh` could not
 * fetch, or whose diff could not be had, says so on that item; the rest of the
 * page carries on.
 */
import { parseUnifiedDiff } from '../../domain/session-work/diff';
import { imageFormatOf, imagePaths, type ImageFormat } from '../../domain/session-work/image';
import { deriveWorkItems, workItemKey, type BranchFacts, type WorktreeChanges } from '../../domain/session-work/items';
import { mergeWorkLocations } from '../../domain/session-work/locations';
import { isRemoteProjectPath } from '../../domain/project/remote-target';
import { gitHubRepository } from '../../domain/project/repo-url';
import type { SessionPullRequest } from '../../domain/session/session';
import type {
  FileDiff, GitHubAvailability, IssueRef, IssueStatus, LineStats, PullRequestStatus, SessionWorkItem,
  SessionWorkDiff, SessionWorkSnapshot, WorkItem, WorkLocation,
} from '../../domain/session-work/model';
import type { ActionContext, SessionActivities, WorkPageSource } from './session-action-service';
import type { Clock, TimerHandle, Timers } from '../ports/clock';
import type { Disposable, GitWorkspace } from '../ports/git-workspace';
import type { GitHubCli, PlanReads } from '../ports/github-cli';
import type { GitRemotes } from '../ports/git-remotes';
import type { Logger } from '../ports/logger';
import type { RendererGateway } from '../ports/renderer-gateway';
import type { TranscriptStore } from '../ports/transcript-store';

/** How long git's watchers have to be quiet before the page is rebuilt. */
export const WATCH_DEBOUNCE_MS = 300;

/** How often `gh` is asked again while the page is open (W1's cadence). */
export const GITHUB_REFRESH_MS = 60_000;

/** How often while a Ship it is under way, so its steps keep up with GitHub. */
export const SHIP_REFRESH_MS = 20_000;

/** Where a session's transcripts live and the directory it was started in. */
export interface SessionWorkTarget {
  /** The transcript folder; null when the session has none yet. */
  folder: string | null;
  projectPath: string;
}

export interface SessionWorkServiceDeps {
  /** Where a session lives, or null when no session goes by that id. */
  locate(sessionId: string): SessionWorkTarget | null;
  transcripts: Pick<TranscriptStore, 'locations' | 'issueMentions' | 'readSession'>;
  git: GitWorkspace;
  /** Reads only: the page writes nothing to GitHub; your review is the review service's, plans the plan service's. */
  github: Omit<GitHubCli, 'startPendingReview' | 'addPendingComment' | 'deletePendingReview' | 'submitPendingReview' | PlanReads>;
  remotes: GitRemotes;
  renderer: Pick<RendererGateway, 'sessionWorkSnapshot'>;
  /** The actions on the session's items; without it, no item has one. */
  activities?: { forSession(sessionId: string): SessionActivities };
  clock: Clock;
  timers: Timers;
  log: Logger;
}

/** What `gh` said, kept between rebuilds so a commit does not cost a GitHub round trip. */
interface GitHubFacts {
  availability: GitHubAvailability;
  /** The PR URLs these answers are for; a new PR link asks again. */
  prKey: string;
  /** Per repository; null where the request failed. */
  pullRequests: Map<string, PullRequestStatus[] | null>;
  /** The mentions these answers are for. */
  issueKey: string;
  /** Per repository; null where the request failed. */
  issues: Map<string, IssueStatus[] | null>;
}

/**
 * Where the two sides of a local diff are read, fixed when the diff was made:
 * an image is served at the same commits its diff shows (L2).
 */
interface DiffSides {
  worktree: string;
  /** The commit the before side is read at; null in a repository with no commits yet. */
  before: string | null;
  /** The commit the after side is read at; null for the working tree. */
  after: string | null;
}

/** A parsed diff, and for a local one where its sides are read. */
interface CachedDiff {
  files: FileDiff[];
  sides: DiffSides | null;
}

/** The one open page. */
interface Page {
  readonly sessionId: string;
  readonly target: SessionWorkTarget;
  /** The worktree root of the directory the session was started in. */
  readonly projectRoot: string;
  /** `owner/repo` from the origin remote; '' when it is not on GitHub. */
  repository: string | null;
  /** Each `cwd` the transcripts named, resolved to its worktree root (null: in none). */
  readonly roots: Map<string, string | null>;
  readonly defaultBranches: Map<string, string>;
  /** The ref each worktree's branches are compared against, e.g. `origin/main`. */
  readonly baseRefs: Map<string, string>;
  readonly watchers: Map<string, Disposable>;
  debounce: TimerHandle | null;
  poll: TimerHandle | null;
  /** The faster poll, while a Ship it is under way. */
  shipPoll: TimerHandle | null;
  /** How many worktrees and branches the transcripts name, as last built. */
  footprint: { worktrees: number; branches: number };
  building: Promise<void> | null;
  again: boolean;
  /** The next build asks `gh` again even if nothing new was linked. */
  askGitHub: boolean;
  github: GitHubFacts | null;
  /** The items as last built, errors from the build included. */
  items: Map<string, SessionWorkItem>;
  /** Why an item's diff could not be had, until it can. */
  readonly diffErrors: Map<string, string>;
  readonly diffCache: Map<string, CachedDiff>;
  /**
   * The local diff each item last answered with: the only files `image` will
   * read, at the only commits it will read them at (L3).
   */
  readonly served: Map<string, { files: FileDiff[]; sides: DiffSides }>;
  last: SessionWorkSnapshot | null;
  lastKey: string;
  closed: boolean;
}

const NO_LINES: LineStats = { additions: 0, deletions: 0 };

/** An item with no diff of its own (an issue), or a page that is not open. */
const NO_DIFF: SessionWorkDiff = { files: [], source: null };

const NOT_CHECKED_OUT ='The branch is not checked out here';

/** Why a checked-out PR shows GitHub's diff: its local branch is at another commit. */
export const LOCAL_DIFFERS = 'Local branch differs from the PR; showing GitHub\'s diff.';

const NO_ACTIVITIES: SessionActivities = { byItem: new Map(), queued: 0, shipping: false };

export class SessionWorkService implements WorkPageSource {
  #page: Page | null = null;
  /** Bumped by every open (and by a close of the one still opening), so only the latest takes effect. */
  #opening = 0;
  #pending: string | null = null;

  constructor(private readonly deps: SessionWorkServiceDeps) {}

  /**
   * Can the page open for this session (D14)? Not for a remote session, and
   * not for one whose directory is not in a git repository.
   */
  async canOpen(sessionId: string): Promise<boolean> {
    return (await this.#projectRoot(sessionId)) !== null;
  }

  /**
   * Open the page for a session: build its snapshot, watch its worktrees and
   * poll `gh`. Closes whichever page was open. Answers the first snapshot, or
   * null when the page cannot open for this session (see `canOpen`).
   */
  async open(sessionId: string): Promise<SessionWorkSnapshot | null> {
    const current = this.#page;
    if (current && current.sessionId === sessionId) {
      this.#opening++;
      this.#pending = null;
      current.askGitHub = true;
      await this.#refresh(current);
      return current.last;
    }
    if (current) this.#dispose(current);

    // Another open, or a close, may come in while git is answering; the last word wins.
    const ticket = ++this.#opening;
    this.#pending = sessionId;
    const located = await this.#projectRoot(sessionId);
    if (ticket !== this.#opening) return null;
    this.#pending = null;
    if (!located) return null;
    if (this.#page) this.#dispose(this.#page);

    const page: Page = {
      sessionId,
      target: located.target,
      projectRoot: located.root,
      repository: null,
      roots: new Map(),
      defaultBranches: new Map(),
      baseRefs: new Map(),
      watchers: new Map(),
      debounce: null,
      poll: null,
      shipPoll: null,
      footprint: { worktrees: 0, branches: 0 },
      building: null,
      again: false,
      askGitHub: true,
      github: null,
      items: new Map(),
      diffErrors: new Map(),
      diffCache: new Map(),
      served: new Map(),
      last: null,
      lastKey: '',
      closed: false,
    };
    this.#page = page;
    page.poll = this.deps.timers.setInterval(() => {
      // The Ship it poll asks more often already.
      if (page.shipPoll) return;
      page.askGitHub = true;
      void this.#refresh(page);
    }, GITHUB_REFRESH_MS);

    await this.#refresh(page);
    return page.closed ? null : page.last;
  }

  /** Close the page: stop the watchers and the polling. A close for a page that is no longer open is ignored. */
  close(sessionId: string): void {
    if (this.#pending === sessionId) {
      this.#opening++;
      this.#pending = null;
    }
    const page = this.#page;
    if (page && page.sessionId === sessionId) this.#dispose(page);
  }

  /** Close whatever page is open, for shutdown. */
  closeAll(): void {
    this.#opening++;
    this.#pending = null;
    if (this.#page) this.#dispose(this.#page);
  }

  /** The session whose page is open, if any. */
  get openSessionId(): string | null {
    return this.#page?.sessionId ?? null;
  }

  /** An item of the open page, as last built; null when the page is not this session's. */
  item(sessionId: string, itemId: string): SessionWorkItem | null {
    const page = this.#page;
    if (!page || page.sessionId !== sessionId || !page.last) return null;
    return page.items.get(itemId) ?? null;
  }

  /** What an action's prompt needs to know about the open page's session. */
  context(sessionId: string): ActionContext | null {
    const page = this.#page;
    if (!page || page.sessionId !== sessionId || !page.last) return null;
    return { repository: page.repository ?? '', mainCheckout: page.projectRoot, gh: page.github?.availability ?? 'missing' };
  }

  /**
   * An action changed phase. The open page shows it at once, without asking
   * git or `gh` again; a snapshot is pushed when that changed anything.
   */
  activitiesChanged(_sessionId: string): void {
    const page = this.#page;
    if (page && page.last && !page.closed) this.#publish(page);
  }

  /**
   * Ask `gh` again now and rebuild, for the open page of this session: after
   * your review was written, so the page shows what GitHub made of it.
   */
  async refreshGitHub(sessionId: string): Promise<void> {
    const page = this.#page;
    if (!page || page.sessionId !== sessionId || page.closed) return;
    page.askGitHub = true;
    await this.#refresh(page);
  }

  /**
   * A transcript folder was written to. When it is the open session's, the
   * page is rebuilt: Claude may have moved to another worktree, opened a PR,
   * or edited files (which git's watchers do not report).
   */
  transcriptsChanged(folder: string): void {
    const page = this.#page;
    if (page && page.target.folder === folder) this.#schedule(page);
  }

  /**
   * The parsed diff of one item of the open page.
   *
   * A local branch's diff is cached by the commits on both sides, a PR's by its
   * head commit; uncommitted changes are read fresh each time. When no diff
   * can be had the item says why, and the answer is empty.
   */
  async diff(sessionId: string, itemId: string): Promise<SessionWorkDiff> {
    const page = this.#page;
    if (!page || page.sessionId !== sessionId) return NO_DIFF;
    const item = page.items.get(itemId);
    if (!item) return NO_DIFF;

    let result: SessionWorkDiff;
    let sides: DiffSides | undefined;
    try {
      ({ sides, ...result } = await this.#diffOf(page, item));
    } catch (err) {
      result = { files: [], source: null, error: (err as Error).message || 'The diff could not be read' };
    }
    if (page.closed) return result;

    if (sides) page.served.set(itemId, { files: result.files, sides });
    else page.served.delete(itemId);

    const before = page.diffErrors.get(itemId);
    if (result.error) page.diffErrors.set(itemId, result.error);
    else page.diffErrors.delete(itemId);
    if (before !== page.diffErrors.get(itemId)) this.#publish(page);
    return result;
  }

  /**
   * One side of an image in an item's diff, as bytes; null when there is no
   * such side to read.
   *
   * The renderer names only a file and a side (L3): the path must be an image
   * in the local diff that item last answered with, and it is read at the
   * commits that diff was made from — never at a revision, or a path, the
   * renderer could choose.
   */
  async image(sessionId: string, itemId: string, path: string, side: 'before' | 'after'): Promise<Uint8Array | null> {
    const page = this.#page;
    if (!page || page.sessionId !== sessionId || !page.items.has(itemId)) return null;
    const served = page.served.get(itemId);
    const file = served?.files.find((candidate) => candidate.path === path && candidate.image);
    if (!served || !file?.image) return null;

    const { git } = this.deps;
    const { worktree, before, after } = served.sides;
    const paths = imagePaths(file);
    if (side === 'before') {
      return file.image.before && paths.before && before ? git.blob(worktree, before, paths.before) : null;
    }
    if (side !== 'after' || !file.image.after || !paths.after) return null;
    return after ? git.blob(worktree, after, paths.after) : git.workingFile(worktree, paths.after);
  }

  // ── Building the snapshot ──

  async #projectRoot(sessionId: string): Promise<{ target: SessionWorkTarget; root: string } | null> {
    const target = this.deps.locate(sessionId);
    if (!target || isRemoteProjectPath(target.projectPath)) return null;
    const root = await this.deps.git.worktreeRoot(target.projectPath);
    return root ? { target, root } : null;
  }

  /** Rebuild the page once per burst of watcher events. */
  #schedule(page: Page): void {
    if (page.closed) return;
    this.deps.timers.clearTimeout(page.debounce);
    page.debounce = this.deps.timers.setTimeout(() => {
      page.debounce = null;
      void this.#refresh(page);
    }, WATCH_DEBOUNCE_MS);
  }

  /** Rebuild, one build at a time: a change during a build runs one more after it. */
  #refresh(page: Page): Promise<void> {
    if (page.building) {
      page.again = true;
      return page.building;
    }
    page.building = (async () => {
      do {
        page.again = false;
        try {
          await this.#build(page);
        } catch (err) {
          this.deps.log.error('[session-work] building the page failed:', (err as Error).message);
        }
      } while (page.again && !page.closed);
    })().finally(() => { page.building = null; });
    return page.building;
  }

  async #build(page: Page): Promise<void> {
    const { git, transcripts } = this.deps;
    const { folder, projectPath } = page.target;

    if (page.repository === null) page.repository = await this.#repository(page.projectRoot);
    const repository = page.repository;

    const locations = await this.#locations(page);
    if (page.closed) return;
    this.#syncWatchers(page, locations);

    const pullRequests: SessionPullRequest[] = folder
      ? transcripts.readSession(folder, page.sessionId, projectPath)?.pullRequests ?? []
      : [];
    const mentions = folder ? transcripts.issueMentions(folder, page.sessionId, repository) : [];

    // What git says about each worktree and branch the session was in.
    const worktrees = [...new Set(locations.map((location) => location.worktree))];
    const changes: WorktreeChanges[] = [];
    for (const worktree of worktrees) {
      const [branch, files] = await Promise.all([git.currentBranch(worktree), git.status(worktree)]);
      if (!branch) continue;
      const stats = files.length > 0 ? await git.workingLineStats(worktree) : NO_LINES;
      changes.push({ worktree, branch, files, ...stats });
    }
    const branches: BranchFacts[] = [];
    for (const location of locations) {
      if (!(await git.branchExists(location.worktree, location.branch))) continue;
      const defaultBranch = await this.#defaultBranch(page, location.worktree);
      const base = await this.#baseRef(page, location.worktree);
      const isDefault = location.branch === defaultBranch;
      const ahead = isDefault ? 0 : (await git.aheadBehind(location.worktree, location.branch, base)).ahead;
      const stats = ahead > 0 ? await git.branchLineStats(location.worktree, location.branch, base) : NO_LINES;
      const pushed = ahead > 0 && await git.isPushed(location.worktree, location.branch);
      branches.push({ worktree: location.worktree, branch: location.branch, isDefault, ahead, base, ...stats, pushed });
    }
    if (page.closed) return;

    const github = await this.#github(page, pullRequests, mentions, repository);
    if (page.closed) return;

    const ok = github.availability === 'ok';
    page.footprint = {
      worktrees: new Set(locations.map((location) => location.worktree)).size,
      branches: new Set(locations.map((location) => location.branch)).size,
    };
    const derived = deriveWorkItems({
      locations,
      pullRequests,
      branches,
      changes,
      github: ok ? [...github.pullRequests.values()].flatMap((list) => list ?? []) : null,
      issueMentions: ok ? confirmedIssues(mentions, github.issues, repository) : mentions,
      repository,
      activities: this.#activities(page).byItem,
    });

    const items = new Map<string, SessionWorkItem>();
    for (const item of derived) {
      const id = workItemKey(item);
      const error = ok ? pullRequestError(item, github, repository) : undefined;
      items.set(id, { ...item, id, ...(error ? { error } : {}) });
    }
    page.items = items;
    for (const id of [...page.diffErrors.keys()]) {
      if (!items.has(id)) page.diffErrors.delete(id);
    }
    for (const id of [...page.served.keys()]) {
      if (!items.has(id)) page.served.delete(id);
    }
    this.#publish(page);
  }

  /**
   * Push the snapshot when it differs from the last one pushed. Each item's
   * action is laid over it here rather than in the build, so a change of phase
   * shows without asking git or `gh` again.
   */
  #publish(page: Page): void {
    const gh = page.github?.availability ?? 'missing';
    const activities = this.#activities(page);
    this.#syncShipPoll(page, activities.shipping);
    const items = [...page.items.values()].map((built) => {
      const item: SessionWorkItem = built.kind === 'pr' || built.kind === 'branch'
        ? { ...built, activity: activities.byItem.get(built.id) ?? null }
        : built;
      const fixing = item.kind === 'pr' ? activities.fixingThreads?.get(item.id) : undefined;
      if (item.kind === 'pr' && fixing?.length) item.fixingThreads = [...fixing];
      const error = page.diffErrors.get(item.id) ?? item.error;
      return error ? { ...item, error } : item;
    });
    const { footprint } = page;
    const queued = activities.queued;
    const key = JSON.stringify({ gh, items, footprint, queued });
    if (key === page.lastKey && page.last) return;
    page.lastKey = key;
    page.last = {
      sessionId: page.sessionId,
      repository: page.repository ?? '',
      items,
      footprint,
      queued,
      gh,
      updatedAt: new Date(this.deps.clock.now()).toISOString(),
    };
    this.deps.renderer.sessionWorkSnapshot(page.last);
  }

  #activities(page: Page): SessionActivities {
    return this.deps.activities?.forSession(page.sessionId) ?? NO_ACTIVITIES;
  }

  /** Poll `gh` every 20 s instead of every minute while a Ship it is under way. */
  #syncShipPoll(page: Page, shipping: boolean): void {
    if (page.closed) return;
    if (shipping && !page.shipPoll) {
      page.shipPoll = this.deps.timers.setInterval(() => {
        page.askGitHub = true;
        void this.#refresh(page);
      }, SHIP_REFRESH_MS);
    } else if (!shipping && page.shipPoll) {
      this.deps.timers.clearInterval(page.shipPoll);
      page.shipPoll = null;
    }
  }

  /**
   * Every place the transcripts name, each `cwd` resolved to its worktree root.
   *
   * Roots are remembered per `cwd`, but each one found is checked again every
   * build, so a worktree that was removed drops out (and its `cwd`s with it).
   */
  async #locations(page: Page): Promise<WorkLocation[]> {
    const { folder } = page.target;
    if (!folder) return [];
    const written = this.deps.transcripts.locations(folder, page.sessionId);

    const resolved: WorkLocation[] = [];
    for (const entry of written) {
      if (!page.roots.has(entry.cwd)) page.roots.set(entry.cwd, await this.deps.git.worktreeRoot(entry.cwd));
      const worktree = page.roots.get(entry.cwd);
      if (worktree) resolved.push({ worktree, branch: entry.branch, fromSubagent: entry.fromSubagent });
    }

    const gone = new Set<string>();
    for (const worktree of new Set(resolved.map((location) => location.worktree))) {
      if ((await this.deps.git.worktreeRoot(worktree)) !== worktree) gone.add(worktree);
    }
    if (gone.size > 0) {
      for (const [cwd, root] of page.roots) {
        if (root && gone.has(root)) page.roots.set(cwd, null);
      }
    }
    return mergeWorkLocations(resolved.filter((location) => !gone.has(location.worktree)));
  }

  /** Watch exactly the worktrees the page shows. */
  #syncWatchers(page: Page, locations: readonly WorkLocation[]): void {
    const wanted = new Set(locations.map((location) => location.worktree));
    for (const [worktree, watcher] of page.watchers) {
      if (wanted.has(worktree)) continue;
      watcher.dispose();
      page.watchers.delete(worktree);
    }
    for (const worktree of wanted) {
      if (page.watchers.has(worktree)) continue;
      page.watchers.set(worktree, this.deps.git.watch(worktree, () => this.#schedule(page)));
    }
  }

  async #defaultBranch(page: Page, worktree: string): Promise<string> {
    let branch = page.defaultBranches.get(worktree);
    if (branch === undefined) {
      branch = await this.deps.git.defaultBranch(worktree);
      page.defaultBranches.set(worktree, branch);
    }
    return branch;
  }

  /** `origin/<default>`, or the local default branch in a repository without that remote branch. */
  async #baseRef(page: Page, worktree: string): Promise<string> {
    let base = page.baseRefs.get(worktree);
    if (base === undefined) {
      const defaultBranch = await this.#defaultBranch(page, worktree);
      const remote = 'origin/' + defaultBranch;
      base = (await this.deps.git.commitSha(worktree, remote)) ? remote : defaultBranch;
      page.baseRefs.set(worktree, base);
    }
    return base;
  }

  /** `owner/repo` of the origin remote when it is on github.com; '' otherwise. */
  async #repository(projectRoot: string): Promise<string> {
    const origin = await this.deps.remotes.originUrl(projectRoot);
    return origin ? gitHubRepository(origin) : '';
  }

  /**
   * What `gh` says, asked again on the minute's poll, when the page opens, and
   * when the session linked a PR or mentioned an issue it had not before.
   */
  async #github(
    page: Page,
    pullRequests: readonly SessionPullRequest[],
    mentions: readonly IssueRef[],
    repository: string,
  ): Promise<GitHubFacts> {
    const { github } = this.deps;
    const prKey = pullRequests.map((pr) => pr.url).sort().join('\n');
    const issueKey = mentions.map((issue) => (issue.repository || repository) + '#' + issue.number).sort().join('\n');
    const known = page.github;
    const askAgain = page.askGitHub || !known;
    page.askGitHub = false;

    const availability = askAgain || !known ? await github.available() : known.availability;
    if (availability !== 'ok') {
      page.github = { availability, prKey, pullRequests: new Map(), issueKey, issues: new Map() };
      return page.github;
    }

    let prs = known?.pullRequests ?? new Map<string, PullRequestStatus[] | null>();
    if (askAgain || known?.availability !== 'ok' || known.prKey !== prKey) {
      prs = new Map();
      for (const [repo, numbers] of byRepository(pullRequests, repository)) {
        prs.set(repo, await github.pullRequests(repo, numbers));
      }
    }
    let issues = known?.issues ?? new Map<string, IssueStatus[] | null>();
    if (askAgain || known?.availability !== 'ok' || known.issueKey !== issueKey) {
      issues = new Map();
      for (const [repo, numbers] of byRepository(mentions, repository)) {
        issues.set(repo, await github.issues(repo, numbers));
      }
    }
    page.github = { availability, prKey, pullRequests: prs, issueKey, issues };
    return page.github;
  }

  // ── Diffs ──

  /** An item's diff, and for a local one where its sides are read. */
  async #diffOf(page: Page, item: SessionWorkItem): Promise<SessionWorkDiff & { sides?: DiffSides }> {
    const { git, github } = this.deps;
    const failed = (error: string): SessionWorkDiff => ({ files: [], source: null, error });
    if (item.kind === 'issue') return NO_DIFF;
    if (item.kind === 'dirty') {
      const worktree = item.location.worktree;
      // HEAD is read before the diff, so the before side is the commit the diff was taken against.
      const sides: DiffSides = { worktree, before: await git.commitSha(worktree, 'HEAD'), after: null };
      const files = await this.#withImages(sides, await this.#parse(worktree, await git.workingDiff(worktree)));
      return { files, source: 'local', sides };
    }

    // A PR's local branch at another commit than GitHub's (unpushed or
    // unpulled work) has other line numbers: a comment anchored to them
    // would land on the wrong line, so the PR's own diff is shown instead.
    let differs = false;
    if (item.diff.kind === 'local') {
      const { worktree, base, head } = item.diff;
      const [headSha, baseSha] = await Promise.all([git.commitSha(worktree, head), git.commitSha(worktree, base)]);
      differs = headSha !== null && item.kind === 'pr' && !!item.pr.headSha && headSha !== item.pr.headSha;
      if (headSha && !differs) {
        // The merge-base follows from both commits, so the key covers the image sides too.
        const key = ['local', worktree, head, headSha, base, baseSha ?? ''].join('\0');
        const { files, sides } = await this.#cached(page, key, async () => {
          const sides: DiffSides = { worktree, before: await git.mergeBase(worktree, headSha, baseSha ?? base), after: headSha };
          const parsed = await this.#parse(worktree, await git.branchDiff(worktree, head, base));
          return { files: await this.#withImages(sides, parsed), sides };
        });
        return { files, source: 'local', ...(sides ? { sides } : {}) };
      }
      // The branch went between the snapshot and this request: a PR still has GitHub's copy.
      if (item.kind === 'branch') return failed('The branch no longer exists');
    }
    if (item.kind !== 'pr') return NO_DIFF;

    const pr = item.pr;
    const repository = pr.repository || page.repository || '';
    const availability = page.github?.availability ?? 'missing';
    if (availability !== 'ok') {
      return failed(NOT_CHECKED_OUT + (availability === 'missing'
        ? ', and gh is not installed to fetch the diff'
        : ', and gh is not signed in to fetch the diff'));
    }
    if (!repository) return failed(NOT_CHECKED_OUT + ', and the repository is unknown');

    const fetch = async (): Promise<FileDiff[] | null> => {
      const text = await github.pullRequestDiff(repository, pr.number);
      return text === null ? null : this.#parse(page.projectRoot, text);
    };
    const fromGitHub = (files: FileDiff[] | null | undefined): SessionWorkDiff =>
      files
        ? { files, source: 'github', ...(differs ? { note: LOCAL_DIFFERS } : {}) }
        : failed('GitHub did not send the diff');
    if (!pr.headSha) return fromGitHub(await fetch());
    const key = ['pr', repository, String(pr.number), pr.headSha].join('\0');
    const cached = page.diffCache.get(key);
    if (cached) return fromGitHub(cached.files);
    const files = await fetch();
    if (files && !page.closed) page.diffCache.set(key, { files, sides: null });
    return fromGitHub(files);
  }

  async #cached(page: Page, key: string, read: () => Promise<CachedDiff>): Promise<CachedDiff> {
    const cached = page.diffCache.get(key);
    if (cached) return cached;
    const diff = await read();
    if (!page.closed) page.diffCache.set(key, diff);
    return diff;
  }

  /**
   * A local diff's images, each marked with its format and the size of each
   * side, so the page can draw them and decide whether to load them at once
   * (L1). A side that cannot be found is left null; a file with neither side
   * stays a plain file.
   */
  async #withImages(sides: DiffSides, files: FileDiff[]): Promise<FileDiff[]> {
    const images = new Map<FileDiff, { format: ImageFormat; before: string | null; after: string | null }>();
    for (const file of files) {
      const format = imageFormatOf(file.path);
      if (format) images.set(file, { format, ...imagePaths(file) });
    }
    if (images.size === 0) return files;

    const { git } = this.deps;
    const { worktree } = sides;
    const befores = [...images.values()].flatMap((image) => (image.before === null ? [] : [image.before]));
    const afters = [...images.values()].flatMap((image) => (image.after === null ? [] : [image.after]));
    const [beforeSizes, afterSizes] = await Promise.all([
      sides.before && befores.length > 0 ? git.blobSizes(worktree, sides.before, befores) : new Map<string, number>(),
      afters.length === 0 ? new Map<string, number>()
        : sides.after ? git.blobSizes(worktree, sides.after, afters) : git.workingFileSizes(worktree, afters),
    ]);

    return files.map((file) => {
      const image = images.get(file);
      if (!image) return file;
      const before = image.before === null ? undefined : beforeSizes.get(image.before);
      const after = image.after === null ? undefined : afterSizes.get(image.after);
      if (before === undefined && after === undefined) return file;
      return {
        ...file,
        image: {
          format: image.format,
          before: before === undefined ? null : { bytes: before },
          after: after === undefined ? null : { bytes: after },
        },
      };
    });
  }

  /** Parse a diff, with the files `.gitattributes` marks generated collapsed (D7). */
  async #parse(worktree: string, text: string): Promise<FileDiff[]> {
    const files = parseUnifiedDiff(text);
    if (files.length === 0) return files;
    const generated = await this.deps.git.generatedPaths(worktree, files.map((file) => file.path));
    return generated.length > 0 ? parseUnifiedDiff(text, { generatedPaths: generated }) : files;
  }

  #dispose(page: Page): void {
    page.closed = true;
    this.deps.timers.clearTimeout(page.debounce);
    this.deps.timers.clearInterval(page.poll);
    this.deps.timers.clearInterval(page.shipPoll);
    page.debounce = null;
    page.poll = null;
    page.shipPoll = null;
    for (const watcher of page.watchers.values()) watcher.dispose();
    page.watchers.clear();
    if (this.#page === page) this.#page = null;
  }
}

/** Numbers grouped by repository, an unnamed one taken to be the session's own. */
function byRepository(refs: readonly IssueRef[], repository: string): Map<string, number[]> {
  const grouped = new Map<string, number[]>();
  for (const ref of refs) {
    const repo = ref.repository || repository;
    if (!repo) continue;
    const numbers = grouped.get(repo) ?? [];
    if (!numbers.includes(ref.number)) numbers.push(ref.number);
    grouped.set(repo, numbers);
  }
  return grouped;
}

/**
 * The mentions that are issues, with what `gh` knows about them. A mention
 * `gh` left out is a PR or does not exist; where `gh` could not be asked, the
 * mention stays as it was rather than vanish.
 */
function confirmedIssues(
  mentions: readonly IssueRef[],
  answers: ReadonlyMap<string, IssueStatus[] | null>,
  repository: string,
): Array<IssueRef | IssueStatus> {
  const confirmed: Array<IssueRef | IssueStatus> = [];
  for (const mention of mentions) {
    const repo = mention.repository || repository;
    const answer = repo ? answers.get(repo) : undefined;
    if (!answer) {
      confirmed.push(mention);
      continue;
    }
    const status = answer.find((issue) => issue.number === mention.number);
    if (status) confirmed.push({ ...status, repository: mention.repository });
  }
  return confirmed;
}

/** Why `gh` has nothing on this PR, when it was asked. */
function pullRequestError(item: WorkItem, github: GitHubFacts, repository: string): string | undefined {
  if (item.kind !== 'pr') return undefined;
  const repo = item.pr.repository || repository;
  const answer = github.pullRequests.get(repo);
  if (answer === null) return 'GitHub did not answer for this PR';
  if (answer && !answer.some((pr) => pr.number === item.pr.number)) return 'GitHub does not know this PR';
  return undefined;
}
