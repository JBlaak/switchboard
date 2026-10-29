/**
 * BlaakTasks' tasks as Switchboard uses them (#244).
 *
 * A row is what `list`, `update` and `progress` answer with; a detail is what
 * `get` answers with: the row, its brief, its progress log and its Notion
 * page. Switchboard keeps only the fields it shows or writes back. `parse.ts`
 * reads them from the tool replies.
 */
import { posixQuote } from '../shell/quoting';

/** A task's status, as BlaakTasks names it. */
export type TaskStatus = 'Not started' | 'In progress' | 'Waiting' | 'Done' | 'Dropped';

/** Which of the two databases a task is in. */
export type TaskContext = 'work' | 'private';

export interface TaskRow {
  id: string;
  context: TaskContext;
  title: string;
  /** A shorter line for a long or link-heavy title, which lists show instead; null when there is none. */
  summary: string | null;
  status: TaskStatus;
  /** `YYYY-MM-DD` or a local datetime; null without one. */
  deadline: string | null;
  /** The deadline as BlaakTasks words it, e.g. "Fri 2 Oct"; null without one. */
  dueLabel: string | null;
  /** Starred for today (★ Today). */
  today: boolean;
  effort: 'Quick' | 'Focus' | null;
  bucket: string | null;
  client: string | null;
  topic: string | null;
  waitingOn: string | null;
  /** Kept off Home until then; null while awake. */
  snoozedUntil: string | null;
  /** The newest progress line. */
  lastUpdate: string | null;
  /**
   * The pull requests carrying the work, oldest first. Read from
   * `pullRequests`, or the single `pullRequest` a server from before
   * JBlaak/BlaakTasks#95 sends.
   */
  pullRequests: string[];
}

/** One line of a task's progress log. */
export interface ProgressEntry {
  /** `YYYY-MM-DD`. */
  day: string;
  text: string;
}

export interface TaskDetail extends TaskRow {
  notes: string | null;
  /** The task's Notion page. */
  url: string;
  /** The page body above the progress log: the full idea. */
  brief: string;
  /** Oldest first. */
  progress: ProgressEntry[];
}

/** A list `view`, as the `list` tool names them. */
export type TaskView = 'quick' | 'due' | 'today' | 'pitch' | 'waiting' | 'snoozed' | 'bucket' | 'client' | 'topic';

export interface TaskListOptions {
  /** The bucket, client or topic, for those views. */
  name?: string;
  /** Text over open tasks; the view is ignored when it is set. */
  query?: string;
  context?: TaskContext;
  limit?: number;
}

/** What `update` may change. Absent fields are left alone; null clears. */
export interface TaskPatch {
  title?: string;
  status?: TaskStatus;
  /** true stars it for today, false un-stars. */
  today?: boolean;
  deadline?: string | null;
  snoozedUntil?: string | null;
  notes?: string | null;
}

/**
 * How a BlaakTasks call ended. It never throws: an outage is an answer like
 * any other, so a list can keep what it showed and say it is retrying.
 *
 * - `off`: no BlaakTasks URL is set, so nothing was called.
 * - `notSetUp`: the URL is set, but no server in `~/.claude.json` has it.
 * - `unreachable`: the request never got an answer: no network, a timeout,
 *   a 5xx.
 * - `failed`: BlaakTasks answered, but no: a refused token, an unknown id, a
 *   JSON-RPC error, a reply that doesn't parse.
 */
export type BlaakTasksResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'off' }
  | { kind: 'notSetUp' }
  | { kind: 'unreachable'; reason: string }
  | { kind: 'failed'; reason: string };

/** The server name the add command gives BlaakTasks, as Quick Ask's capture looks it up. */
export const BLAAKTASKS_SERVER = 'blaaktasks';

/** The Settings line shown when the URL is set but no server in `~/.claude.json` has it. */
export const ADD_TO_CLAUDE_LINE = 'Add BlaakTasks to Claude Code with this URL';

/**
 * The MCP address for the URL in Settings: the URL itself, or `/mcp` on it
 * when it names only the site (`https://tasks.example.com/`), which is where
 * BlaakTasks serves its tools. '' stays ''.
 */
export function blaakTasksEndpoint(url: string): string {
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.pathname === '/' && !parsed.search && !parsed.hash) return `${parsed.origin}/mcp`;
  } catch {
    // Not a URL: matched and called as typed, which tells the user it is wrong.
  }
  return trimmed;
}

/** The command that adds BlaakTasks to Claude Code at `url`, for the user to copy. */
export function addToClaudeCommand(url: string): string {
  const trimmed = blaakTasksEndpoint(url);
  // A URL with nothing a shell reads specially stays readable; anything else is quoted.
  const arg = /^[\w:/.\-@%+=~,]+$/.test(trimmed) ? trimmed : posixQuote(trimmed);
  return `claude mcp add --transport http --scope user ${BLAAKTASKS_SERVER} ${arg}`;
}
