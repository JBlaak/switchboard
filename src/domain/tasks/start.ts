/**
 * Starting a session from a BlaakTasks task (#244): the branch it works on,
 * the prompt Claude starts with, and what Ask Patch is asked when the task
 * has no repo yet.
 *
 * The prompt is BlaakTasks' own "Copy for Claude" handoff, so the `/task`
 * skill takes over unchanged; a change to that wording in BlaakTasks belongs
 * here too. Switchboard has marked the task In progress already, which the
 * prompt says so the session leaves the status alone.
 */
import { titleSlug, type ExistingBranch } from '../project/branch-worktree';

/** What starting a session needs to know of a task. */
export interface TaskStartInput {
  id: string;
  title: string;
  /** The task's description, when it has one: routing reads it with the title. */
  brief?: string;
}

/** The branch of a task with no letters or digits in its title. */
const UNTITLED_BRANCH = 'task';

/**
 * The issue rule without the number: the title's first five words, as a slug.
 * A slug that starts with a digit gets `task-` in front, or `issueFromBranch`
 * would read it as an issue's branch.
 */
export function taskBranchName(title: string): string {
  const slug = titleSlug(title);
  if (!slug) return UNTITLED_BRANCH;
  return /^[0-9]/.test(slug) ? UNTITLED_BRANCH + '-' + slug : slug;
}

/** The first prompt of a new session on a task. */
export function taskSessionPrompt(task: TaskStartInput): string {
  return `Work on my task “${task.title}” (blaaktasks ${task.id}): read it with get, log progress at every checkpoint and link the PR. ` +
    'It is already marked In progress; don\'t change its status.';
}

/**
 * The prompt for continuing on a task's branch that exists already: the work
 * so far is on it, so it is read before anything new is done.
 */
export function taskContinuePrompt(task: TaskStartInput): string {
  return `Continue work on my task “${task.title}” (blaaktasks ${task.id}): this branch already has earlier work on it. ` +
    'Read the task with get, then what the branch has so far (its commits, and any uncommitted changes) before going on. ' +
    'Log progress at every checkpoint and link the PR, unless it is linked already. ' +
    'It is already marked In progress; don\'t change its status.';
}

/** What Ask Patch is asked to route: the title, then the brief when there is one. */
export function taskRouteText(task: TaskStartInput): string {
  const brief = task.brief?.trim();
  return brief ? `${task.title}\n\n${brief}` : task.title;
}

/**
 * What preparing a session on a task answers: a worktree and its prompt, ready
 * to launch; the refusal over a branch that exists already, which says what is
 * there; or how routing ended when the task had no repo to start in.
 *
 * `projectPath` is the repository's main checkout the worktree was made under.
 */
export type TaskSessionPreparation =
  | {
    kind: 'ready';
    projectPath: string;
    worktreePath: string;
    branch: string;
    prompt: string;
    /** Something the renderer shows: it started, but not as asked (a fetch that failed). */
    warning?: string;
  }
  | { kind: 'existing'; projectPath: string; reason: string; existing: ExistingBranch }
  /** Ask Patch could not choose: up to three candidate paths, best first, for the user to pick from. */
  | { kind: 'unsure'; candidates: string[] }
  | { kind: 'noMatch'; reason: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'cancelled' };
