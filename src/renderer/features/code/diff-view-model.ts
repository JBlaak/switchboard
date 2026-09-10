/**
 * The whole-worktree diff's rules, with no DOM in them.
 *
 * What a section is, which body it draws, what order the sections come in, what
 * the header's counts add up to, which files the generated banner is hiding,
 * and — the part the milestone is actually about — which sections are close
 * enough to the viewport to be worth building. All of it decided here so it can
 * be tested by calling a function; `diff-view.ts` builds elements, fetches
 * hunks and decides nothing worth asserting on.
 *
 * Kept free of `../../lib/dom` on purpose: that module resolves every element
 * handle at import, so anything reaching it cannot be imported by a Node test.
 *
 * Two decisions are load-bearing and worth stating up front.
 *
 * **A section exists before its lines do.** `getChanges` classifies the whole
 * tree with one git command and leaves every `hunks` empty — that is the point
 * of the two-phase design, and it is what makes 212 files affordable. So a
 * section is built from the classification alone and knows how to draw itself
 * without any lines at all; `loaded` says whether the second phase has been
 * paid for yet. Nothing here fetches, and nothing here waits.
 *
 * **Every collapse is reversible.** Generated files are hidden, oversize ones
 * are folded and whitespace-only ones are sorted to the bottom — all on by
 * default, because a 212-file migration is unreadable otherwise, and all
 * undoable from the header, because a default that cannot be turned off is a
 * missing file rather than a tidy one. Which is why the counts the banner
 * prints come from the same call that hid them.
 *
 * **A file that is not plain readable text is still a file.** Four of the
 * states below are not "a hunk you can read": a merge conflict, a file two
 * sessions both wrote, a file that changed while you were reading it, and a
 * minified line nothing can colour. Each of them is decided here — is this
 * conflicted, which rows are its markers, is this claimed twice, which session
 * could be asked about it, is this section stale, is this block affordable to
 * colour — so the surface can draw the answer without holding any of the
 * reasoning.
 */
import { sameBase } from '../files/changes-list-model';
import type { ChangesPayload } from '../../../domain/changes/types';
import type { DiffBase, FileDiff, FileStatusCode, Hunk } from '../../../domain/git/types';
import type { SessionClaim } from '../../../domain/attribution/types';

/**
 * What a section shows under its header.
 *
 * Not a property of the file so much as a decision about it: the same
 * `FileDiff` draws as `oversize` under the default and as `hunks` once someone
 * has expanded it, and that is the only thing that changes between them.
 */
export type DiffBody =
  /** The lines. Empty until phase two has been paid for; see `loaded`. */
  | 'hunks'
  /** Past `OVERSIZE_LINES`: one line and an `Expand` that buys the hunks. */
  | 'oversize'
  /** A lockfile or build output, shown only because the banner was turned off. */
  | 'generated'
  /** A rename that changed nothing: one line, old → new, and a similarity. */
  | 'rename'
  /** Sizes only, plus thumbnails when the two sides are images. */
  | 'binary'
  /** The two pointer lines and how far the submodule moved. */
  | 'submodule'
  /** A reformat: tagged, sorted last, and folded to a line with `Expand`. */
  | 'whitespace'
  /** git knows the path and nothing else — it does not track the file yet. */
  | 'untracked'
  /** A mode change on its own, or a patch that turned out to be empty. */
  | 'none';

/** One changed file, as one section of the long scroll. */
export interface DiffSection {
  /** Relative to the worktree, forward-slashed, exactly as git spells it. */
  path: string;
  status: FileStatusCode;
  additions: number;
  deletions: number;
  binary: boolean;
  generated: boolean;
  submodule: boolean;
  whitespaceOnly: boolean;
  untracked: boolean;
  /**
   * git could not merge this file and left both sides in it.
   *
   * `status === 'U'` restated as a flag, because it is the one status that
   * changes how the whole section behaves rather than only which letter it
   * prints: it outranks every "this is boring" collapse, it colours its own
   * rows, and it is the only section with actions of its own.
   */
  conflicted: boolean;
  /** Where a rename or a copy came from. */
  oldPath?: string;
  /** The rename/copy score, 0–100. */
  similarity?: number;
  truncated?: 'size' | 'generated';
  /** Which side ends without a final newline — a note under the hunk. */
  noNewlineAtEof?: 'old' | 'new' | 'both';
  /** e.g. the execute bit arriving — a note under the hunk. */
  modeChange?: { from: string; to: string };
  /** How the body draws, given the toggles and what the reader has expanded. */
  body: DiffBody;
  /** The lines, once phase two has been paid for. Empty otherwise. */
  hunks: readonly Hunk[];
  /** Whether `gitDiffFile` has answered for this path. */
  loaded: boolean;
  /** Who the transcripts say wrote it, most recent first. Possibly empty. */
  claims: readonly SessionClaim[];
}

/** The header's counts: the whole change set, before anything is hidden. */
export interface DiffTotals {
  files: number;
  additions: number;
  deletions: number;
}

/** Everything the surface draws, in the order it draws it. */
export interface DiffView {
  /** The base git actually used. This is the one the header shows. */
  base: DiffBase;
  /** The base that was asked for. */
  requestedBase: DiffBase;
  /**
   * The two differ: the ref was gone, or HEAD is detached, and git fell back to
   * uncommitted-only. Invariant 7 — say which base this is, never imply the
   * other one.
   */
  baseMismatch: boolean;
  totals: DiffTotals;
  sections: DiffSection[];
  /** How many generated files the banner is speaking for. Zero hides it. */
  generatedHidden: number;
  /** How many sections are whitespace-only, wherever they ended up. */
  whitespaceOnly: number;
}

/** What the header's toggles and the reader's clicks add to the payload. */
export interface DiffOptions {
  /** False puts the lockfiles back in the scroll. Defaults to true. */
  hideGenerated?: boolean;
  /**
   * False puts the reformats back in git's order, expanded.
   *
   * Deliberately *not* `git diff -w`: the flag would change what git reports
   * and therefore what the diffstat beside every row means, and the surface
   * would then be printing counts from one command and lines from another.
   * What this does is the part a reader actually wants — a file whose whole
   * change is indentation is tagged, folded and sorted out of the way, and one
   * click puts it back. Defaults to true.
   */
  ignoreWhitespace?: boolean;
  /** Paths the reader has expanded past a collapse, by clicking `Expand`. */
  expanded?: ReadonlySet<string>;
  /** path → what `gitDiffFile` answered, for the files phase two has bought. */
  loaded?: ReadonlyMap<string, FileDiff>;
}

/**
 * Every changed file as a section, in git's order with the reformats last.
 *
 * Untracked files follow the Changes list's rule rather than inventing a second
 * one: **an untracked file is shown only when a session claims it**. A file a
 * session just created is the most interesting thing in the diff; the rest of
 * an untracked working tree is `node_modules` and somebody's scratch file, and
 * the two surfaces disagreeing about how many files changed would be worse than
 * either answer.
 */
export function buildDiffView(payload: ChangesPayload, options: DiffOptions = {}): DiffView {
  const hideGenerated = options.hideGenerated !== false;
  const ignoreWhitespace = options.ignoreWhitespace !== false;
  const expanded = options.expanded ?? new Set<string>();
  const loaded = options.loaded ?? new Map<string, FileDiff>();

  const all: DiffSection[] = [];
  for (const file of payload.files) {
    // Phase two knows more than phase one did: whether the change is only
    // whitespace costs a second diff and is decided per file, and the hunks
    // arrive with it. Where the two disagree the later answer wins.
    const merged = loaded.get(file.path) ?? file;
    all.push(sectionFor(merged, payload.claims[file.path] ?? [], {
      untracked: false,
      loaded: loaded.has(file.path),
      expanded: expanded.has(file.path),
      ignoreWhitespace,
    }));
  }

  for (const file of payload.untracked) {
    const claims = payload.claims[file.path] ?? [];
    if (claims.length === 0) continue;
    const merged = loaded.get(file.path);
    all.push(sectionFor(merged ?? {
      ...file,
      // git cannot count the lines of a file it does not track without reading
      // it, which the summary phase deliberately never does. Zero means "not
      // counted", and the header prints nothing rather than `+0 −0`.
      additions: 0, deletions: 0,
      binary: false, generated: false, whitespaceOnly: false, submodule: false, hunks: [],
    }, claims, {
      untracked: true,
      loaded: loaded.has(file.path),
      expanded: expanded.has(file.path),
      ignoreWhitespace,
    }));
  }

  const totals = totalsOf(all);
  const whitespaceOnly = all.filter(section => section.whitespaceOnly).length;

  // Hidden, not dropped: the banner counts them and putting them back is one
  // click, which is the whole bargain of a default this aggressive.
  //
  // Except for a conflict. A conflicted lockfile is the single most common
  // conflict there is, and hiding it behind a banner that says "generated"
  // would be telling the reader their tree is clean when git is refusing to
  // continue — the one lie this surface must not tell.
  const shown = hideGenerated
    ? all.filter(section => !section.generated || section.conflicted)
    : all;

  return {
    base: payload.base,
    requestedBase: payload.requestedBase,
    baseMismatch: !sameBase(payload.base, payload.requestedBase),
    totals,
    sections: ignoreWhitespace ? sortSections(shown) : [...shown],
    generatedHidden: all.length - shown.length,
    whitespaceOnly,
  };
}

interface SectionFlags {
  untracked: boolean;
  loaded: boolean;
  expanded: boolean;
  ignoreWhitespace: boolean;
}

function sectionFor(
  file: FileDiff, claims: readonly SessionClaim[], flags: SectionFlags,
): DiffSection {
  const section: DiffSection = {
    path: file.path,
    status: flags.untracked ? '?' : file.status,
    additions: file.additions,
    deletions: file.deletions,
    binary: file.binary,
    generated: file.generated,
    submodule: file.submodule,
    whitespaceOnly: file.whitespaceOnly,
    untracked: flags.untracked,
    conflicted: !flags.untracked && file.status === 'U',
    ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
    ...(file.similarity === undefined ? {} : { similarity: file.similarity }),
    ...(file.truncated === undefined ? {} : { truncated: file.truncated }),
    ...(file.noNewlineAtEof === undefined ? {} : { noNewlineAtEof: file.noNewlineAtEof }),
    ...(file.modeChange === undefined ? {} : { modeChange: file.modeChange }),
    body: 'none',
    hunks: file.hunks,
    loaded: flags.loaded,
    claims,
  };
  section.body = bodyFor(section, flags.expanded, flags.ignoreWhitespace);
  return section;
}

/**
 * Which body a section draws, in the order the answers rule each other out.
 *
 * A rename with no content change is settled before anything about size or
 * generation, because it is the one that turns a 212-file migration from
 * unreadable into skimmable: a moved file is one line — old path, arrow, new
 * path, similarity — and never a delete plus an add.
 *
 * A conflict is settled next, and only sheer size still folds it. Every other
 * collapse here is a judgement that the file is *boring* — a lockfile, a
 * reformat — and a file git could not merge is never boring however it was
 * written. Size is the exception because that collapse is about what the
 * browser can draw, not about what is worth reading, and it stays one click
 * from open.
 */
export function bodyFor(
  section: DiffSection, expanded: boolean, ignoreWhitespace = true,
): DiffBody {
  if (section.submodule) return 'submodule';
  if (section.binary) return 'binary';
  if (isPureRename(section)) return 'rename';
  if (section.untracked) return 'untracked';
  if (expanded) return 'hunks';
  if (section.conflicted) return section.truncated === 'size' ? 'oversize' : 'hunks';
  if (section.truncated === 'generated') return 'generated';
  if (section.truncated === 'size') return 'oversize';
  if (ignoreWhitespace && section.whitespaceOnly) return 'whitespace';
  if (section.additions === 0 && section.deletions === 0) return 'none';
  return 'hunks';
}

/** A file that moved and nothing more: git counted no lines either way. */
export function isPureRename(section: {
  status: FileStatusCode; additions: number; deletions: number;
}): boolean {
  return (section.status === 'R' || section.status === 'C')
    && section.additions === 0 && section.deletions === 0;
}

/**
 * git's order, with the reformats pushed to the bottom.
 *
 * Stable on both sides, so within each half the scroll follows the order git
 * reported — which is the repository's own, and the one the sidebar's list is
 * already in. A whitespace-only file is not less real, it is just never the
 * thing you opened the diff to read, and a reformat that buries the one real
 * change is the failure this sort exists to prevent.
 */
export function sortSections(sections: readonly DiffSection[]): DiffSection[] {
  const body: DiffSection[] = [];
  const tail: DiffSection[] = [];
  for (const section of sections) (section.whitespaceOnly ? tail : body).push(section);
  return [...body, ...tail];
}

/**
 * The diffstat of the whole change set — what the header shows.
 *
 * Taken before anything is hidden. The header answers "what has happened in
 * this worktree", and a number that shrank because the generated banner is up
 * would be answering a different question; what the banner took away it says
 * itself, in its own words.
 */
export function totalsOf(sections: readonly DiffSection[]): DiffTotals {
  let additions = 0;
  let deletions = 0;
  for (const section of sections) {
    additions += section.additions;
    deletions += section.deletions;
  }
  return { files: sections.length, additions, deletions };
}

/** The claim the header names: the most recent one, or none. */
export function primaryClaim(section: DiffSection): SessionClaim | null {
  return section.claims[0] ?? null;
}

// ── a conflict, shown and never merged ────────────────────────────────────────

/**
 * What one row of a conflicted file is.
 *
 * git writes a conflict into the file itself, so a conflicted file is an
 * ordinary patch whose added lines happen to include the markers — which is
 * why nothing here needs `--cc`, and why the whole shape of the conflict is
 * already on the wire by the time a section draws.
 *
 * `base` is the diff3 style's third side: with `merge.conflictStyle` set to
 * `diff3` or `zdiff3`, git writes the common ancestor between `|||||||` and
 * `=======`. Most repositories never see it; the ones that do would otherwise
 * have that whole region silently coloured as "ours".
 */
export type ConflictRole =
  /** `<<<<<<< HEAD` */
  | 'start'
  /** Between `<<<<<<<` and the next marker: the side already in the worktree. */
  | 'ours'
  /** `||||||| merged common ancestors` */
  | 'base-marker'
  /** Between `|||||||` and `=======`: the common ancestor, in diff3 style. */
  | 'base'
  /** `=======` */
  | 'separator'
  /** Between `=======` and `>>>>>>>`: the side being merged in. */
  | 'theirs'
  /** `>>>>>>> branch` */
  | 'end';

/**
 * The markers, as git writes them.
 *
 * Seven characters is `merge.conflictMarkerSize`'s default and the only size
 * anything in the wild uses; `{7,}` covers a repository that raised it. Each
 * one must be the whole line or be followed by a space, so a line of `=======`
 * under a heading in a Markdown file is not mistaken for a separator — and
 * even that only matters inside a region, because the state machine below
 * never looks for a separator outside one.
 */
const CONFLICT_START = /^<{7,}(?: |$)/;
const CONFLICT_BASE = /^\|{7,}(?: |$)/;
const CONFLICT_SEPARATOR = /^={7,}(?: |$)/;
const CONFLICT_END = /^>{7,}(?: |$)/;

/**
 * One role per line, `null` for the lines that are outside every region.
 *
 * A region that never closes keeps its roles to the end of the block, because
 * that is the honest reading of what is there: the hunk was cut off, or git
 * really did leave the file that way, and colouring the tail as ordinary code
 * would hide it either way.
 */
export function conflictRoles(lines: readonly string[]): (ConflictRole | null)[] {
  let side: 'ours' | 'base' | 'theirs' | null = null;

  return lines.map(line => {
    if (side === null) {
      if (CONFLICT_START.test(line)) { side = 'ours'; return 'start'; }
      return null;
    }
    if (CONFLICT_BASE.test(line)) { side = 'base'; return 'base-marker'; }
    if (CONFLICT_SEPARATOR.test(line)) { side = 'theirs'; return 'separator'; }
    if (CONFLICT_END.test(line)) { side = null; return 'end'; }
    return side;
  });
}

/** Whether a block of lines holds a conflict git wrote into the file. */
export function hasConflictMarkers(lines: readonly string[]): boolean {
  return lines.some(line => CONFLICT_START.test(line));
}

/** How many separate conflicts are in a file's hunks — what the header counts. */
export function conflictRegionsIn(hunks: readonly Hunk[]): number {
  let regions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) if (CONFLICT_START.test(line.text)) regions += 1;
  }
  return regions;
}

/**
 * Which session to hand a conflicted file to, if any.
 *
 * Invariant 10: the app shows a conflict and offers to hand it to a session,
 * and that offer is the whole feature — so who it goes to has to be a decision
 * and not a guess. In order: a session that claims the file and is still
 * running, most recent claim first; then the session on screen, if it is
 * running; then nobody. A session that is not running is never a target,
 * because a prompt written into a dead terminal is lost without a sound.
 *
 * `running` is the renderer's live-PTY set, which lags the truth by up to one
 * poll — so the caller checks again at the moment of sending rather than
 * trusting an answer that was drawn a minute ago.
 */
export interface AskTarget {
  sessionId: string;
  /** `claim` — a session that wrote this file. `active` — the one on screen. */
  from: 'claim' | 'active';
}

export function askTarget(
  claims: readonly SessionClaim[],
  activeSessionId: string | null,
  running: ReadonlySet<string>,
): AskTarget | null {
  for (const claim of claims) {
    if (running.has(claim.sessionId)) return { sessionId: claim.sessionId, from: 'claim' };
  }
  if (activeSessionId !== null && running.has(activeSessionId)) {
    return { sessionId: activeSessionId, from: 'active' };
  }
  return null;
}

/**
 * Strip everything a terminal would read as a keystroke rather than as text.
 *
 * The prompt is written into a live PTY, so a newline in it is not a newline —
 * it is Return, and it submits whatever is in the composer at that instant.
 * Paths can carry one: git quotes such a path in its output and the parser
 * unquotes it faithfully, so a path with a newline in it reaches this surface
 * intact. An escape would be worse still. Everything below U+0020, plus DEL,
 * collapses to a single space.
 */
export function sanitiseForTerminal(text: string): string {
  // Written as escapes rather than as literal bytes so this file stays plain
  // text: the C0 range, plus DEL.
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
}

/**
 * What `Ask the session` types into the session's composer.
 *
 * One line, because a PTY reads a newline as Return. It names the file, says
 * how many conflicts are in it, and asks for the two sides before any writing
 * — the app is handing over a decision, not delegating it.
 */
export function conflictPrompt(path: string, regions: number): string {
  const count = regions === 1 ? '1 conflict' : `${regions} conflicts`;
  return sanitiseForTerminal(
    `Resolve the merge conflict in ${path} (${count}). `
    + 'Read the file, tell me what each side is doing, and wait for me before writing.',
  );
}

// ── one file, two sessions ────────────────────────────────────────────────────

/**
 * Who wrote this file, and whether that is more than one answer.
 *
 * `overlapping` means **two sessions claim the same file** — nothing narrower.
 * A claim is a `tool_use` in a transcript: a path, a session and a time, with
 * no line numbers anywhere in it. So the honest marker is on the file, and any
 * per-hunk attribution would be a number this surface made up. Saying "two
 * sessions wrote this file, and where they collide is not known here" is worth
 * more than a confident line number that is wrong.
 */
export interface SectionAttribution {
  /** Most recent first, as the payload orders them. */
  claims: readonly SessionClaim[];
  /** More than one session claims the path. Per file — never per line. */
  overlapping: boolean;
  /** Tool calls across every claimant, which is the size of the collision. */
  edits: number;
}

export function attributionOf(section: { claims: readonly SessionClaim[] }): SectionAttribution {
  let edits = 0;
  for (const claim of section.claims) edits += claim.edits;
  return { claims: section.claims, overlapping: section.claims.length > 1, edits };
}

// ── changed underneath you ────────────────────────────────────────────────────

/**
 * How many of the diff's files are watched at once.
 *
 * One `fs.watch` per file, and a 212-file diff scrolled end to end would ask
 * for 212 of them. The reader is looking at one screen; the sections behind
 * them have already been skipped by `content-visibility` and will be rebuilt
 * from a fresh patch if they are ever scrolled back to. So the set is bounded
 * and the oldest entry is released when a new one arrives.
 */
export const MAX_WATCHED_FILES = 64;

/** The watch set after one more path joins it, and whatever fell out. */
export function nextWatched(
  watched: readonly string[], path: string, limit = MAX_WATCHED_FILES,
): { watched: string[]; released: string[] } {
  if (watched.includes(path)) return { watched: [...watched], released: [] };
  const grown = [...watched, path];
  const overflow = Math.max(0, grown.length - Math.max(1, limit));
  return { watched: grown.slice(overflow), released: grown.slice(0, overflow) };
}

/**
 * A watcher's absolute path, as a path inside the worktree — or `null`.
 *
 * The main process answers with `path.resolve`'s spelling of what it was
 * given, which on Windows means backslashes where the diff's own paths have
 * forward slashes. Both sides are normalised before they are compared, so a
 * file changing under a Windows worktree still finds its section.
 */
export function relativeToWorktree(worktreePath: string, changedPath: string): string | null {
  const root = worktreePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const target = changedPath.replace(/\\/g, '/');
  if (root === '' || !target.startsWith(`${root}/`)) return null;
  const rel = target.slice(root.length + 1);
  return rel === '' ? null : rel;
}

/**
 * The stale set after one file changed on disk.
 *
 * Only a path the scroll has actually drawn can go stale — a change to a file
 * the reader has never reached is not news, it is just the tree moving. The
 * answer is a new set rather than a mutation so the caller can tell whether
 * anything happened without diffing by hand.
 */
export function markStale(
  stale: ReadonlySet<string>,
  drawn: ReadonlySet<string>,
  worktreePath: string | null,
  changedPath: string,
): Set<string> {
  const next = new Set(stale);
  if (worktreePath === null) return next;
  const rel = relativeToWorktree(worktreePath, changedPath);
  if (rel === null || !drawn.has(rel)) return next;
  next.add(rel);
  return next;
}

// ── long lines and caps ───────────────────────────────────────────────────────

/**
 * Beyond this many lines in one block, nothing is coloured.
 *
 * Below `MAX_HIGHLIGHT_LINES` in `lib/highlight-static.ts` on purpose: that one
 * is the highlighter's own floor and this one is the diff's, and a diff hands
 * over a hunk at a time rather than a file, so the surface can afford to be
 * the stricter of the two.
 */
export const MAX_HUNK_LINES = 1200;

/**
 * A single line this long turns colouring off for its whole block.
 *
 * Deliberately the same number as `MAX_HIGHLIGHT_LINE_LENGTH`, and the test
 * asserts it has not drifted: the highlighter would refuse the block anyway,
 * and deciding it here means the surface never builds the array of texts to
 * hand over in the first place.
 */
export const MAX_HUNK_LINE_LENGTH = 2000;

/**
 * Whether a block of lines is worth handing to the parser.
 *
 * A minified bundle is one line of 1.6 MB, and Lezer on the renderer's only
 * thread has no frame to yield on — the window would simply stop. False here
 * means the rows are escaped plain text, which is still every character of the
 * change, in the right order, on the right line: uncoloured, not missing.
 */
export function colourable(lines: readonly string[]): boolean {
  if (lines.length > MAX_HUNK_LINES) return false;
  for (const line of lines) if (line.length > MAX_HUNK_LINE_LENGTH) return false;
  return true;
}

// ── lazy rendering ────────────────────────────────────────────────────────────

/** One row of code, in px. Must match `$diff-row-height` in `_diff-view.scss`. */
export const ROW_HEIGHT = 19;

/** A sticky per-file header, in px. Must match `_diff-view.scss`. */
export const HEAD_HEIGHT = 30;

/**
 * The tallest a section is guessed to be before its lines exist.
 *
 * A guess only has to be good enough for `contain-intrinsic-size` and for the
 * arithmetic below; being wrong costs a scrollbar that resettles as content
 * arrives, which is what every virtualised list does. Capping it matters more
 * than being right: a 12,000-line lockfile would otherwise reserve a quarter of
 * a million pixels for a section that is going to draw one collapsed line.
 */
export const MAX_ESTIMATED_ROWS = 240;

/**
 * How tall a section is likely to be, for the browser to reserve.
 *
 * Bodies that are a fixed shape — a rename, a binary, a collapse — are known
 * exactly. A body of hunks is guessed from the diffstat plus a few rows of
 * context per hunk, until phase two replaces the guess with the real thing.
 */
export function estimatedHeight(section: DiffSection): number {
  const rows = (() => {
    switch (section.body) {
      case 'rename': case 'none': return 1;
      case 'oversize': case 'generated': case 'whitespace': return 2;
      case 'submodule': return 3;
      case 'binary': return 4;
      case 'untracked': return 2;
      default: return hunkRows(section);
    }
  })();
  return HEAD_HEIGHT + Math.min(rows, MAX_ESTIMATED_ROWS) * ROW_HEIGHT;
}

/** The real row count once the hunks are in, and a guess with three rows of context before. */
function hunkRows(section: DiffSection): number {
  if (section.loaded) {
    let rows = 0;
    for (const hunk of section.hunks) rows += hunk.lines.length + 1;
    return Math.max(rows, 1);
  }
  return section.additions + section.deletions + 6;
}

/** Where the scroll is, and how much either side of it to build anyway. */
export interface DiffViewport {
  scrollTop: number;
  /** The height of the scrolling element, not of its content. */
  height: number;
  /** Screens of slack above and below. Defaults to `DEFAULT_OVERSCAN`. */
  overscan?: number;
}

/**
 * One screen either side, which is the cheapest number that never shows a gap.
 *
 * A scroll of one wheel notch is a fraction of a screen, so a whole screen of
 * slack means the next section is already built by the time it is needed — and
 * two screens of built-but-hidden DOM is a cost `content-visibility: auto` then
 * declines to pay for anyway.
 */
export const DEFAULT_OVERSCAN = 1;

/**
 * Which sections are worth building right now.
 *
 * The heights are the estimates above, in the same order as the sections, and
 * the answer is every section whose box intersects the viewport grown by
 * `overscan` screens in each direction. This is the whole of the virtualisation
 * policy: everything else — `content-visibility`, the intersection observer
 * that drives it, the per-file fetch — is an implementation of this one
 * decision, which is why it is here and not in the DOM.
 *
 * Always returns at least the first section when there is one, so an empty
 * answer means an empty diff rather than a scroll that has not settled.
 */
export function visibleSections(
  heights: readonly number[], viewport: DiffViewport,
): number[] {
  if (heights.length === 0) return [];

  const overscan = viewport.overscan ?? DEFAULT_OVERSCAN;
  const height = Math.max(0, viewport.height);
  const slack = height * Math.max(0, overscan);
  const top = viewport.scrollTop - slack;
  // At least one pixel tall: a scroll that has not been laid out yet — the half
  // is folded, so the box cannot be measured — should still build the section
  // it is sitting on rather than none at all.
  const bottom = viewport.scrollTop + Math.max(height, 1) + slack;

  const indices: number[] = [];
  let offset = 0;
  for (let i = 0; i < heights.length; i++) {
    const end = offset + heights[i];
    // Strict intersection: a section whose last pixel is the window's first
    // shows nothing, and the overscan is what covers the reader arriving at it.
    if (end > top && offset < bottom) indices.push(i);
    offset = end;
    if (offset >= bottom) break;
  }

  // A scroll position past the end of a list that has since shrunk would
  // otherwise render nothing at all.
  if (indices.length === 0) indices.push(heights.length - 1);
  return indices;
}
