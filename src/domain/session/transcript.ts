/**
 * Reading a Claude CLI `.jsonl` transcript.
 *
 * The parsing is pure so it can run anywhere — the main thread, the scanner
 * worker, a test — and so the filesystem stays on one side of it. The adapter
 * supplies the lines and the file's timestamps; everything the sidebar and the
 * search index need is derived here.
 */
import { pullRequestFromLink } from './pull-requests';
import type { Session, SessionPullRequest } from './session';

/** A message body as it appears in a transcript — string, or a content block list. */
interface TranscriptMessage {
  role?: string;
  content?: string | Array<{ text?: string }>;
}

/** One line of a transcript. Every field is best-effort. */
export interface TranscriptEntry {
  type?: string;
  role?: string;
  timestamp?: string;
  slug?: string;
  customTitle?: string;
  aiTitle?: string;
  cwd?: string;
  /** How the CLI was started: `cli` at a terminal, `sdk-cli` for `claude -p`. */
  entrypoint?: string;
  message?: string | TranscriptMessage;
  /** `pr-link` lines only. */
  prNumber?: unknown;
  prUrl?: unknown;
  prRepository?: unknown;
}

/** The file facts the parser cannot see for itself. */
export interface TranscriptFileTimes {
  /** ISO-8601 — used for `created` when no entry carries a timestamp. */
  birthtime: string;
  /** ISO-8601 — the cache-invalidation key, and the `modified` fallback. */
  mtime: string;
}

/** Where the parsed session belongs. */
export interface TranscriptIdentity {
  sessionId: string;
  folder: string;
  projectPath: string;
}

/** The `entrypoint` the CLI writes when it runs headless, as `claude -p`. */
const HEADLESS_ENTRYPOINT = 'sdk-cli';
/** The one it writes when someone runs it at a terminal. */
const INTERACTIVE_ENTRYPOINT = 'cli';

/** How much concatenated message text is kept for the search index. */
const SEARCH_BODY_LIMIT = 8000;
/** How much of any single message contributes to it. */
const SEARCH_BODY_PER_MESSAGE = 500;
/** How much of the first user message becomes the row label. */
const SUMMARY_LIMIT = 120;

/** Pull the displayable text out of an entry, whatever shape its message took. */
export function entryText(msg: TranscriptEntry['message']): string {
  if (typeof msg === 'string') return msg;
  if (typeof msg?.content === 'string') return msg.content;
  if (Array.isArray(msg?.content)) return msg.content[0]?.text ?? '';
  return '';
}

/** Parse one transcript line, or null when it is blank or malformed. */
export function parseTranscriptLine(line: string): TranscriptEntry | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line) as TranscriptEntry;
  } catch {
    return null;
  }
}

/** Does this entry count as a message exchanged with the model? */
function isConversationEntry(entry: TranscriptEntry): boolean {
  return entry.type === 'user' || entry.type === 'assistant' ||
    (entry.type === 'message' && (entry.role === 'user' || entry.role === 'assistant'));
}

/** Is this the user's own turn, rather than the assistant's? */
function isUserTurn(entry: TranscriptEntry): boolean {
  return entry.type === 'user' || (entry.type === 'message' && entry.role === 'user');
}

/**
 * Does a timestamp on this entry mark real activity in the conversation?
 *
 * Not a `pr-link`: the CLI re-writes those, freshly timestamped, in the
 * bookkeeping block it appends whenever a session exits or is resumed, so they
 * would move `modified` without anything having happened. The PR's actual
 * creation needs no help — the tool call that opened it is timestamped within
 * milliseconds of it.
 */
function marksActivity(entry: TranscriptEntry): boolean {
  return entry.type !== 'pr-link';
}

/**
 * The row label taken from a user message, or '' when the message is not one a
 * label should come from.
 *
 * Local command echoes (`!` in the CLI) carry shell markup rather than intent,
 * so the label comes from the next real message instead. A scheduled run names
 * itself in the message, and that name is what the row should say.
 */
export function summaryFromUserMessage(text: string): string {
  if (!text || /<bash-input>|<bash-stdout>|<local-command-caveat>/.test(text)) return '';
  const taskMatch = text.match(/<scheduled-task\s+name="([^"]+)"/);
  return taskMatch ? 'Scheduled: ' + taskMatch[1] : text.slice(0, SUMMARY_LIMIT);
}

/**
 * Turn a transcript's lines into a session, or null when it holds no
 * conversation worth listing: none at all, or one a tool ran headless.
 */
export function parseTranscript(
  lines: string[],
  identity: TranscriptIdentity,
  times: TranscriptFileTimes,
): Session | null {
  let summary = '';
  let messageCount = 0;
  let textContent = '';
  let slug: string | null = null;
  let customTitle: string | null = null;
  let aiTitle: string | null = null;
  // Keyed by URL: the same PR is recorded again on every exit and resume.
  // A Map keeps first-seen order, which is chronological.
  const pullRequests = new Map<string, SessionPullRequest>();
  // Real conversation time bounds. Resuming a session appends untimestamped
  // bookkeeping records (last-prompt, mode, ai-title, …) which bump the file's
  // mtime without any actual activity, so mtime can't be the displayed time.
  let firstTimestamp: string | null = null;
  let lastTimestamp: string | null = null;
  // See `isHeadless`.
  let firstUserEntrypoint: string | undefined;
  let seenFirstUserTurn = false;
  let resumedInteractively = false;

  for (const line of lines) {
    const entry = parseTranscriptLine(line);
    if (!entry) continue;

    if (entry.timestamp && marksActivity(entry)) {
      // ISO-8601 UTC strings — lexicographic comparison is chronological
      if (!firstTimestamp || entry.timestamp < firstTimestamp) firstTimestamp = entry.timestamp;
      if (!lastTimestamp || entry.timestamp > lastTimestamp) lastTimestamp = entry.timestamp;
    }
    if (entry.slug && !slug) slug = entry.slug;
    if (entry.type === 'custom-title' && entry.customTitle) customTitle = entry.customTitle;
    if (entry.type === 'ai-title' && entry.aiTitle) aiTitle = entry.aiTitle;
    if (entry.type === 'pr-link') {
      const pr = pullRequestFromLink(entry);
      if (pr && !pullRequests.has(pr.url)) pullRequests.set(pr.url, pr);
    }
    if (isConversationEntry(entry)) messageCount++;
    if (!seenFirstUserTurn && isUserTurn(entry)) {
      seenFirstUserTurn = true;
      firstUserEntrypoint = entry.entrypoint;
    }
    if (entry.entrypoint === INTERACTIVE_ENTRYPOINT) resumedInteractively = true;

    const text = entryText(entry.message);
    if (!summary && isUserTurn(entry)) summary = summaryFromUserMessage(text);
    if (text && textContent.length < SEARCH_BODY_LIMIT) {
      textContent += text.slice(0, SEARCH_BODY_PER_MESSAGE) + '\n';
    }
  }

  if (!summary || messageCount < 1) return null;
  if (isHeadless(firstUserEntrypoint, resumedInteractively)) return null;

  return {
    ...identity,
    summary,
    firstPrompt: summary,
    // created/modified are display+sort values from message timestamps;
    // fileMtime is the cache-invalidation key.
    created: firstTimestamp || times.birthtime,
    modified: lastTimestamp || times.mtime,
    fileMtime: times.mtime,
    messageCount,
    textContent,
    slug,
    customTitle,
    aiTitle,
    pullRequests: [...pullRequests.values()],
  };
}

/**
 * Was this session run by a tool rather than by someone at a terminal?
 *
 * A tool that asks a question (Yab's address bar) or runs an evaluation (the
 * release tool) starts the CLI with `claude -p`, which writes `sdk-cli` on
 * every line, the first user turn included. Such a run is not work to come back
 * to, so it is not listed at all. A scheduled run also goes through `-p`, but
 * it resumes a session Switchboard seeded without an entrypoint, so it stays.
 * Anyone resuming a headless session at a terminal makes it a conversation
 * after all.
 */
function isHeadless(firstUserEntrypoint: string | undefined, resumedInteractively: boolean): boolean {
  return firstUserEntrypoint === HEADLESS_ENTRYPOINT && !resumedInteractively;
}

/** The first `cwd` any line carries — how a folder resolves to a project path. */
export function cwdFromTranscript(lines: string[]): string | null {
  for (const line of lines) {
    const entry = parseTranscriptLine(line);
    if (entry?.cwd) return entry.cwd;
  }
  return null;
}
