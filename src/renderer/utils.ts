import type { PendingSession } from './state.js';
import type { RemoteStatusView } from '../shared/types.js';

// --- Utility functions (shared across renderer modules) ---

/** A fuzzy match: its score, and where in the text each query character landed. */
export interface FuzzyMatch {
  score: number;
  positions: number[];
}

/** The circumstances that keep a pending row alive. */
export interface PendingAbandonOptions {
  /** A PTY is still running under this id. */
  running?: boolean;
  /** The user is looking at it, so its exit banner should stay readable. */
  onScreen?: boolean;
  now?: number;
}

/**
 * Shorten a project path for display: its last two segments.
 *
 * Splits on both separators. projectPath comes from a session's `cwd`, which on
 * Windows is backslash-separated — splitting on '/' alone finds no separator, so
 * every "short" label rendered the entire path.
 */
export function shortProjectPath(projectPath: string | null | undefined): string {
  if (!projectPath) return '';
  // Remote projects render as their connection string ("user@host[:port]"),
  // plus the last segment of the working directory when one is set.
  if (projectPath.startsWith('ssh://')) {
    const rest = projectPath.slice('ssh://'.length);
    const slash = rest.indexOf('/');
    if (slash === -1) return rest;
    const lastSeg = rest.slice(slash + 1).split('/').filter((s: string) => s && s !== '~').pop();
    return lastSeg ? rest.slice(0, slash) + '/' + lastSeg : rest.slice(0, slash);
  }
  return projectPath.split(/[\\/]/).filter(Boolean).slice(-2).join('/');
}

/**
 * Permission modes offered for a session, in the order they're shown.
 *
 * `value` is passed verbatim to `claude --permission-mode`, so each one must
 * stay a member of that flag's choice list (as of CLI 2.1.220: acceptEdits,
 * auto, bypassPermissions, manual, dontAsk, plan). A `null` value means we omit
 * the flag entirely and let the CLI apply the user's own configured default.
 *
 * Shared by both session dialogs and the settings panel — the list used to be
 * copy-pasted in all three, so a new mode reached only whichever copy someone
 * remembered to edit.
 */
export const PERMISSION_MODES = [
  { value: null, label: 'Default', desc: 'Prompt for all actions' },
  { value: 'auto', label: 'Auto', desc: 'Classifier allows routine work, stops for risky actions' },
  { value: 'acceptEdits', label: 'Accept Edits', desc: 'Auto-accept file edits, prompt for others' },
  { value: 'plan', label: 'Plan Mode', desc: 'Read-only exploration, no writes' },
  { value: 'dontAsk', label: "Don't Ask", desc: 'Auto-deny tools not explicitly allowed' },
  { value: 'bypassPermissions', label: 'Bypass', desc: 'Auto-accept all tool calls' },
];

// Mirror Claude CLI's project-folder naming. Must stay in sync with
// encode-project-path.js (main process). Reverse-engineered from claude CLI 2.1.126.
export function encodeProjectPath(projectPath: string): string {
  const sanitized = projectPath.replace(/[^a-zA-Z0-9]/g, '-');
  if (sanitized.length <= 200) return sanitized;
  let h = 0;
  for (let i = 0; i < projectPath.length; i++) {
    h = (h << 5) - h + projectPath.charCodeAt(i) | 0;
  }
  return sanitized.slice(0, 200) + '-' + Math.abs(h).toString(36);
}

/**
 * True when position `i` in `text` starts a new word: the first character, one
 * after a separator, or a camelCase hump.
 */
function isFuzzyBoundary(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1];
  if (/[\s/\\_.@:-]/.test(prev)) return true;
  return prev === prev.toLowerCase() && text[i] !== text[i].toLowerCase();
}

// One left-to-right pass, taking each query character at the earliest position
// at or after `start` that still keeps the match in order.
function fuzzyScanFrom(q: string, lower: string, text: string, start: number): FuzzyMatch | null {
  const positions: number[] = [];
  let score = 0;
  let prev = -2;
  let from = start;
  for (let qi = 0; qi < q.length; qi++) {
    const at = qi === 0 ? start : lower.indexOf(q[qi], from);
    if (at === -1) return null;
    score += 10;
    // Contiguity outweighs a word boundary: in a separator-heavy string every
    // character sits on a boundary, and "b-o-a-r-d" should not outrank the
    // literal "board".
    if (at === prev + 1) score += 25;              // contiguous run
    // Where the match starts says more about intent than a boundary in the
    // middle of it: "sb" should anchor on switchboard, not on the s of joris.
    if (isFuzzyBoundary(text, at)) score += qi === 0 ? 25 : 15;
    if (qi === 0) score -= Math.min(at, 20);       // reward matching early
    positions.push(at);
    prev = at;
    from = at + 1;
  }
  return { score, positions };
}

/**
 * Fuzzy-match `query` against `text` as a case-insensitive subsequence.
 *
 * Returns null when a query character can't be found in order, otherwise the
 * score (higher is better) and the matched positions, so callers can highlight
 * them. Scoring favours contiguous runs, word boundaries, and matches that
 * start early — which is what ranks "swb" onto switchboard ahead of
 * some/web/lib. An empty query matches everything with score 0.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  if (!query) return { score: 0, positions: [] };
  if (!text) return null;
  const q = query.toLowerCase();
  const lower = text.toLowerCase();
  // A single greedy pass can settle for a worse run than one further along
  // ("ab" against "a-ab"), so restart from every occurrence of the first
  // character and keep the best-scoring match.
  let best: FuzzyMatch | null = null;
  for (let start = lower.indexOf(q[0]); start !== -1; start = lower.indexOf(q[0], start + 1)) {
    const match = fuzzyScanFrom(q, lower, text, start);
    if (match && (!best || match.score > best.score)) best = match;
  }
  return best;
}

export function cleanDisplayName(name: string | null | undefined): string | null | undefined {
  if (!name) return name;
  const prefix = 'Implement the following plan:';
  if (name.startsWith(prefix)) name = name.slice(prefix.length).trim();
  // Strip XML/HTML-like tags (e.g. <command>, </message>, <system-reminder>)
  name = name.replace(/<\/?[a-zA-Z][a-zA-Z0-9_-]*(?:\s[^>]*)?\/?>/g, ' ');
  // Collapse multiple spaces and trim
  name = name.replace(/\s+/g, ' ').trim();
  return name;
}

export function formatDate(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export function shellEscape(path: string): string {
  return "'" + path.replace(/'/g, "'\\''") + "'";
}

// --- Remote (SSH) connection status rendering ---
// The live connection state renders as a card over the terminal (see app.js);
// these are the two text bits that go with it — the scrollback record of each
// break, and the label that replaces Running/Stopped in the terminal header.

// One line of connection history in the scrollback. Opens its own line so it
// can't land in the middle of whatever the remote host last printed, and closes
// it so the next PTY output starts clean.
export function remoteStatusBanner(text: string, colour: string): string {
  return `\r\n${colour}── ${text} ──\x1b[0m\r\n`;
}

// Header label for a remote session mid-connect. Null means the connection is
// not in flight and the normal running/stopped label applies.
export function remoteStatusLabel(status: RemoteStatusView | null | undefined, now = Date.now()): string | null {
  if (!status) return null;
  if (status.phase === 'connecting') return status.attempt ? 'Reconnecting…' : 'Connecting…';
  if (status.phase === 'retrying') {
    const secs = Math.max(0, Math.ceil(((status.retryAt ?? 0) - now) / 1000));
    return secs > 0 ? `Reconnecting in ${secs}s` : 'Reconnecting…';
  }
  return null;
}

// A pending row is one the renderer invents before Claude has written its
// .jsonl, so there is something on screen while the CLI starts up. It earns that
// place only while a real session might still turn up: once the PTY is gone and
// no file was ever written, nothing is coming.
//
// Nothing used to evict those. A session that died before its first turn — a CLI
// that refused its --session-id, a pre-launch command that failed — left a row
// that pendingSessions pinned to the Working tier (itself exempt from
// truncation) carrying a client-side `archived: 0` that the archive filter,
// which reads the injected object rather than the DB, could never hide. The row
// was unremovable, and clicking it only relaunched the same dead id.
export const PENDING_GRACE_MS = 60000;

export function isPendingAbandoned(
  pending: PendingSession,
  { running = false, onScreen = false, now = Date.now() }: PendingAbandonOptions = {},
): boolean {
  // Plain terminals are torn down explicitly by onProcessExited, and a remote
  // row is meant to outlive its connection — archive is the only thing that
  // should ever drop one.
  const type = pending.session.type;
  if (type === 'terminal' || type === 'remote') return false;
  // Still running, or still on screen with its exit banner: leave it be.
  if (running || onScreen) return false;
  if (pending.exitedAt) return now - pending.exitedAt > PENDING_GRACE_MS;
  // No exit was seen, but nothing is running under that id either — the event
  // went missing (a reload mid-launch, an openTerminal that failed). Age from
  // creation so a slow first launch still gets its grace period.
  const created = new Date(pending.session.created).getTime();
  return Number.isFinite(created) && now - created > PENDING_GRACE_MS;
}

