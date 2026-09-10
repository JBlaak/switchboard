/**
 * The Changes list's rules, with no DOM in them.
 *
 * What the list contains, which group a file lands in, what order the groups
 * come in, what the header's diffstat adds up to and what a query leaves
 * standing. All of it decided here so it can be tested by calling a function —
 * `changes-list.ts` builds elements and calls IPC and decides nothing else
 * worth asserting on, which is the same split the file tree keeps.
 *
 * Kept free of `../../lib/dom` on purpose: that module resolves every element
 * handle at import, so anything reaching it cannot be imported by a test.
 *
 * The one structural decision worth stating up front: **a file claimed by two
 * sessions appears under both of them**. That is the point of the surface — the
 * thing a git panel cannot say — not a bug in the grouping, and the row carries
 * `shared` so the drawing can mark it where it happens.
 */
import type { DiffBase, FileStatusCode } from '../../../domain/git/types';
import type { ChangesPayload } from '../../../domain/changes/types';
import type { SessionClaim } from '../../../domain/attribution/types';

/**
 * How many changed files earn a filter field and a `Generated` toggle.
 *
 * Below this the list is short enough to read, and a search box over eleven
 * rows is furniture. Above it the sidebar cannot show the whole list at once,
 * so narrowing it is the only way to find a file — and the tree below gives up
 * height to make room for what the filter leaves.
 */
export const CROWDED_AT = 30;

/** How much of a session id stands in for a session nobody can name. */
const SHORT_ID = 8;

/** One changed file, as one row of one group. */
export interface ChangeRow {
  /** Relative to the worktree, forward-slashed, exactly as git spells it. */
  path: string;
  status: FileStatusCode;
  additions: number;
  deletions: number;
  /** A lockfile, a build output, or `linguist-generated`: drawn dimmed. */
  generated: boolean;
  binary: boolean;
  submodule: boolean;
  /** Where a rename or a copy came from. */
  oldPath?: string;
  /** git does not track it yet, so no line counts exist for it. */
  untracked: boolean;
  /** More than one session claims it — the amber marker. */
  shared: boolean;
}

/**
 * One heading and the rows under it.
 *
 * `sessionId` is null for the one group that is not a session: the paths git
 * reports and no transcript claims. There is exactly one of those, and it comes
 * last.
 */
export interface ChangeGroup {
  kind: 'session' | 'unclaimed';
  sessionId: string | null;
  /** The group's most recent claim, which is what orders the groups. */
  lastAtIso: string;
  rows: ChangeRow[];
}

/** The header's right-hand side: how much changed, before any filter. */
export interface ChangeTotals {
  files: number;
  additions: number;
  deletions: number;
}

/** Everything the surface draws, in the order it draws it. */
export interface ChangesView {
  /** The base git actually used. This is the one the header shows. */
  base: DiffBase;
  /** The base that was asked for. */
  requestedBase: DiffBase;
  /**
   * The two differ: the ref was gone, or HEAD is detached, and git fell back.
   * Invariant 7 — a silently different base is a lie about what you are looking
   * at, so the header says so.
   */
  baseMismatch: boolean;
  totals: ChangeTotals;
  groups: ChangeGroup[];
  /** The list is long enough to earn a filter field and a `Generated` toggle. */
  crowded: boolean;
  /** How many of `totals.files` the query and the toggle took off screen. */
  hidden: number;
}

/** What narrows the list. Both only reachable once `crowded` is true. */
export interface ChangesFilter {
  /** Matched against the path, case-insensitively. Empty shows everything. */
  query?: string;
  /** False drops the files git classifies as generated. Defaults to true. */
  showGenerated?: boolean;
}

/**
 * The whole surface, from one `getChanges` answer.
 *
 * Untracked files are not all here. `DiffResult` keeps them apart from `files`
 * because git's diff cannot see them, and the design leaves it to the surface
 * to decide which belong: **an untracked file is shown only when a session
 * claims it**. A file a session just created is the most interesting row in the
 * list; the rest of an untracked working tree is `node_modules`, a build
 * directory and someone's scratch file, and putting those in the
 * `not by a session` group would bury the group that matters under them.
 */
export function buildChangesView(payload: ChangesPayload, filter: ChangesFilter = {}): ChangesView {
  const rows = allRows(payload);
  const totals = totalsOf(rows);

  const kept = rows.filter(row => matches(row, filter));
  const groups = groupRows(kept, payload.claims);

  return {
    base: payload.base,
    requestedBase: payload.requestedBase,
    baseMismatch: !sameBase(payload.base, payload.requestedBase),
    totals,
    groups,
    crowded: totals.files > CROWDED_AT,
    hidden: totals.files - kept.length,
  };
}

/** Every row the list could show, tracked and claimed-untracked alike, by path. */
function allRows(payload: ChangesPayload): ChangeRow[] {
  const rows: ChangeRow[] = [];

  for (const file of payload.files) {
    rows.push({
      path: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      generated: file.generated,
      binary: file.binary,
      submodule: file.submodule,
      ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
      untracked: false,
      shared: claimsFor(payload.claims, file.path).length > 1,
    });
  }

  for (const file of payload.untracked) {
    const claims = claimsFor(payload.claims, file.path);
    if (claims.length === 0) continue;
    rows.push({
      path: file.path,
      status: '?',
      // git can count the lines of a file it does not track only by reading it,
      // which the summary phase deliberately never does. Zero here means "not
      // counted", and the drawing prints nothing rather than `+0 −0`.
      additions: 0,
      deletions: 0,
      generated: false,
      binary: false,
      submodule: false,
      untracked: true,
      shared: claims.length > 1,
    });
  }

  return rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The diffstat of the whole change set — what the header shows.
 *
 * Deliberately taken before the filter: the header answers "what has happened
 * in this worktree", and a number that shrank because someone typed three
 * letters in the box would be answering a different question. What the filter
 * removed is `hidden`, reported separately.
 */
function totalsOf(rows: readonly ChangeRow[]): ChangeTotals {
  let additions = 0;
  let deletions = 0;
  for (const row of rows) {
    additions += row.additions;
    deletions += row.deletions;
  }
  return { files: rows.length, additions, deletions };
}

function matches(row: ChangeRow, filter: ChangesFilter): boolean {
  if (filter.showGenerated === false && row.generated) return false;
  const query = (filter.query ?? '').trim().toLowerCase();
  // A substring of the path, not a fuzzy match: the user is looking at these
  // paths while they type, so what they type is a piece of one.
  return query === '' || row.path.toLowerCase().includes(query);
}

/**
 * One group per session that claims a file, then the group nothing claims.
 *
 * Sessions are ordered by their most recent claim, which puts whatever was just
 * being worked on at the top and keeps it there while the user reads it. The
 * unclaimed group is always last: it is what the list has left over, not a
 * participant in it.
 */
function groupRows(rows: readonly ChangeRow[], claims: ChangesPayload['claims']): ChangeGroup[] {
  const sessions = new Map<string, ChangeGroup>();
  const unclaimed: ChangeRow[] = [];

  for (const row of rows) {
    const claimed = claimsFor(claims, row.path);
    if (claimed.length === 0) {
      unclaimed.push(row);
      continue;
    }
    for (const claim of claimed) {
      let group = sessions.get(claim.sessionId);
      if (!group) {
        sessions.set(claim.sessionId, group = {
          kind: 'session',
          sessionId: claim.sessionId,
          lastAtIso: claim.lastAtIso,
          rows: [],
        });
      }
      // A group is as recent as its most recent claim, whichever file carried it.
      if (claim.lastAtIso > group.lastAtIso) group.lastAtIso = claim.lastAtIso;
      group.rows.push(row);
    }
  }

  const groups = [...sessions.values()].sort(byRecency);
  if (unclaimed.length > 0) {
    groups.push({ kind: 'unclaimed', sessionId: null, lastAtIso: '', rows: unclaimed });
  }
  return groups;
}

/** Most recent first, then by id so two equal timestamps still have one order. */
function byRecency(a: ChangeGroup, b: ChangeGroup): number {
  if (a.lastAtIso !== b.lastAtIso) return a.lastAtIso < b.lastAtIso ? 1 : -1;
  return (a.sessionId ?? '') < (b.sessionId ?? '') ? -1 : 1;
}

function claimsFor(claims: ChangesPayload['claims'], path: string): readonly SessionClaim[] {
  return claims[path] ?? [];
}

/** Two bases are the same base — used to decide whether git honoured the request. */
export function sameBase(a: DiffBase, b: DiffBase): boolean {
  if (a.kind === 'uncommitted' || b.kind === 'uncommitted') return a.kind === b.kind;
  return a.kind === b.kind && a.ref === b.ref;
}

/**
 * How a base reads in the header.
 *
 * A merge base says so, because "vs main" and "vs where this branch left main"
 * are different diffs and the difference is the whole reason a long-lived
 * worktree wants the second one.
 */
export function baseLabel(base: DiffBase): string {
  switch (base.kind) {
    case 'branch': return base.ref;
    case 'merge-base': return `${base.ref} (merge base)`;
    default: return 'uncommitted';
  }
}

// ── the base this list is taken against ─────────────────────────────

/**
 * What the base control offers, as a choice rather than as a ref.
 *
 * A ref cannot be stored: `main` is not what every repository calls its default
 * branch, and a choice remembered as `{ kind: 'merge-base', ref: 'main' }`
 * would be wrong the moment it was read back in a repository that kept
 * `master`. The choice is the durable half — *the default branch*, *the merge
 * base with it*, *uncommitted only* — and the ref is filled in from whatever
 * that repository turned out to call it.
 */
export type BaseChoice = 'default-branch' | 'merge-base' | 'uncommitted';

/**
 * What a project that has never chosen gets.
 *
 * Merge-base, because a long-lived worktree wants *what has this branch done*
 * rather than every commit the default branch has made since it was cut — open
 * question 2's own answer, and what the hard-coded base used to ask for.
 */
export const DEFAULT_BASE_CHOICE: BaseChoice = 'merge-base';

/** The key a project's choice is remembered under, inside its settings blob. */
export const BASE_CHOICE_SETTING = 'diffBase';

const BASE_CHOICES: readonly string[] = ['default-branch', 'merge-base', 'uncommitted'];

/** A stored value, if it is still one of the choices; null for anything else. */
export function parseBaseChoice(value: unknown): BaseChoice | null {
  return typeof value === 'string' && BASE_CHOICES.includes(value) ? value as BaseChoice : null;
}

/**
 * The choice as a base git can be asked for.
 *
 * Both branch readings need a branch, so without one they are uncommitted-only
 * — the same answer git would fall back to, arrived at before the round trip
 * rather than after it.
 */
export function baseForChoice(choice: BaseChoice, defaultBranch: string | null): DiffBase {
  if (choice === 'uncommitted' || !defaultBranch) return { kind: 'uncommitted' };
  return choice === 'merge-base'
    ? { kind: 'merge-base', ref: defaultBranch }
    : { kind: 'branch', ref: defaultBranch };
}

/** One entry of the base control. */
export interface BaseOption {
  choice: BaseChoice;
  /** As the header spells it, so the control and the header cannot disagree. */
  label: string;
  /** Which diff this actually is, for the option's tooltip. */
  title: string;
}

/**
 * What the control can offer here.
 *
 * A repository with no default branch — no commits yet, or nothing named
 * `main`, `master` or pointed at by `origin/HEAD` — has one honest reading and
 * gets one option. The surface can then draw the label it always drew instead
 * of a picker that picks nothing.
 */
export function baseOptions(defaultBranch: string | null): BaseOption[] {
  const options: BaseOption[] = [];
  if (defaultBranch) {
    options.push({
      choice: 'default-branch',
      label: baseLabel({ kind: 'branch', ref: defaultBranch }),
      title: `Every difference from ${defaultBranch}, including what ${defaultBranch} did since`,
    });
    options.push({
      choice: 'merge-base',
      label: baseLabel({ kind: 'merge-base', ref: defaultBranch }),
      title: `What this branch has done since it left ${defaultBranch}`,
    });
  }
  options.push({
    choice: 'uncommitted',
    label: baseLabel({ kind: 'uncommitted' }),
    title: 'Everything not yet committed',
  });
  return options;
}

/** A session nobody has a name for: enough id to tell two of them apart. */
export function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, SHORT_ID);
}

/**
 * Which colour a status letter is drawn in.
 *
 * A conflict is its own tone rather than a shade of "changed": it is not a file
 * that was modified, it is a file the user has to decide about.
 */
export function statusTone(status: FileStatusCode): 'add' | 'mod' | 'del' | 'conflict' | 'plain' {
  switch (status) {
    case 'A': case '?': return 'add';
    case 'M': return 'mod';
    case 'D': return 'del';
    case 'U': return 'conflict';
    default: return 'plain';
  }
}
