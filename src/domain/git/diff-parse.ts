/**
 * Parsing `git diff -U3 --find-renames --no-color`.
 *
 * The expensive half of the two-phase diff, and the only place lines are read.
 * One file's patch looks like this:
 *
 *     diff --git a/old.ts b/new.ts
 *     similarity index 95%
 *     rename from old.ts
 *     rename to new.ts
 *     index 1234567..89abcde 100644
 *     --- a/old.ts
 *     +++ b/new.ts
 *     @@ -2,7 +2,7 @@ function foo() {
 *      context
 *     -removed
 *     +added
 *     \ No newline at end of file
 *
 * Three things about it are easy to get wrong.
 *
 * **The `diff --git` line cannot be split reliably.** `a/my file.txt b/my
 * file.txt` has a space on both sides of the boundary, and a rename has two
 * different paths, so there is no rule that always finds the seam. The `---`
 * and `+++` lines are unambiguous — each holds one path to the end of the line
 * — so they are the source of truth, with `rename from`/`rename to` above them
 * and the header split only as a last resort. That resort is needed: a chmod
 * and a binary file have no `---`/`+++` lines at all.
 *
 * **A path may be quoted.** git C-quotes a name containing a quote, a
 * backslash or a byte outside ASCII (`"a/quo\"te.txt"`, `"a/caf\303\251.txt"`),
 * with the octal escapes spelling UTF-8 bytes. It also appends a TAB to an
 * *unquoted* `---`/`+++` path that contains a space, so the reader can find the
 * end of it. Both have to be undone, and neither is optional: a path that is
 * read wrong is a file the surface cannot open.
 *
 * **Content is kept verbatim.** Only the first character of a body line is
 * structure; everything after it is the file, trailing CR included. A parser
 * that trims a diff line is a parser that hides a CRLF change, which the design
 * says must never be silent.
 *
 * The prefixes are `a/` and `b/` because the caller pins them with
 * `--src-prefix`/`--dst-prefix`; a user's `diff.mnemonicPrefix` would otherwise
 * make them `c/` and `w/` here and `i/` and `w/` somewhere else.
 */
import { SUBMODULE_MODE } from './types';
import type { FileDiff, FileStatusCode, Hunk } from './types';

/** `@@ -oldStart[,oldLines] +newStart[,newLines] @@ [section heading]` */
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Every file in the patch, in the order git printed them.
 *
 * `generated` and `whitespaceOnly` are always false here and `truncated` is
 * never set: they are not properties of the text, they are decisions made
 * against `.gitattributes`, a second diff and a threshold, all of which live a
 * layer up. The parser reports what the patch says and nothing else.
 *
 * Anything before the first `diff --git` line is ignored, so a patch that
 * arrives with a commit message or a warning on top still reads.
 */
export function parseUnifiedDiff(stdout: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: Draft | null = null;
  let hunk: Hunk | null = null;

  const finish = (): void => {
    if (file) files.push(seal(file));
    file = null;
    hunk = null;
  };

  for (const line of stdout.split('\n')) {
    if (line.startsWith('diff --git ')) {
      finish();
      const [a, b] = headerPaths(line.slice('diff --git '.length));
      file = draft(a, b);
      continue;
    }
    // A combined diff — the working tree against two parents, which is what
    // `git diff` prints for a file in the middle of a merge. Its body has one
    // column per parent and nothing here renders that; invariant 10 says a
    // conflict is shown as the file with its markers, not as a merge tool. So
    // the file is reported as conflicted with no hunks, and the surface reads
    // it whole instead.
    if (line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) {
      finish();
      const path = unquotePath(line.slice(line.indexOf(' ', 'diff --'.length) + 1));
      file = draft(path, path);
      file.status = 'U';
      file.combined = true;
      continue;
    }
    if (!file) continue;

    if (file.combined) continue;

    if (hunk) {
      const kind = line[0];
      if (kind === '+' || kind === '-' || kind === ' ') {
        hunk.lines.push({ kind: kind === '+' ? 'add' : kind === '-' ? 'del' : 'ctx', text: line.slice(1) });
        if (kind === '+') file.additions += 1;
        if (kind === '-') file.deletions += 1;
        file.lastLineKind = kind;
        continue;
      }
      if (line.startsWith('\\ ')) {
        // `\ No newline at end of file`, which describes the line above it.
        noteMissingNewline(file);
        continue;
      }
      // Anything else ends the hunk and falls through to the header handling.
      hunk = null;
    }

    if (line.startsWith('@@ ')) {
      const match = HUNK_HEADER.exec(line);
      if (!match) continue;
      hunk = { header: line, oldStart: Number(match[1]), newStart: Number(match[2]), lines: [] };
      file.hunks.push(hunk);
      file.lastLineKind = undefined;
      continue;
    }
    if (line.startsWith('old mode ')) { file.modeFrom = line.slice('old mode '.length).trim(); continue; }
    if (line.startsWith('new mode ')) { file.modeTo = line.slice('new mode '.length).trim(); continue; }
    if (line.startsWith('new file mode ')) {
      file.status = 'A';
      file.mode = line.slice('new file mode '.length).trim();
      continue;
    }
    if (line.startsWith('deleted file mode ')) {
      file.status = 'D';
      file.mode = line.slice('deleted file mode '.length).trim();
      continue;
    }
    if (line.startsWith('similarity index ')) {
      file.similarity = Number(line.slice('similarity index '.length).replace('%', '').trim());
      continue;
    }
    if (line.startsWith('rename from ')) { file.status = 'R'; file.oldPath = unquotePath(line.slice('rename from '.length)); continue; }
    if (line.startsWith('rename to ')) { file.status = 'R'; file.path = unquotePath(line.slice('rename to '.length)); continue; }
    if (line.startsWith('copy from ')) { file.status = 'C'; file.oldPath = unquotePath(line.slice('copy from '.length)); continue; }
    if (line.startsWith('copy to ')) { file.status = 'C'; file.path = unquotePath(line.slice('copy to '.length)); continue; }
    if (line.startsWith('index ')) {
      // `index <old>..<new> <mode>`; the mode is absent when it changed, in
      // which case the `old mode`/`new mode` lines above carry it.
      const mode = /^index [0-9a-f]+\.\.[0-9a-f]+ (\d+)$/.exec(line.trimEnd());
      if (mode) file.mode = mode[1];
      continue;
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      file.binary = true;
      continue;
    }
    if (line.startsWith('--- ')) {
      const path = headerPath(line.slice('--- '.length));
      if (path !== null) file.aPath = path;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const path = headerPath(line.slice('+++ '.length));
      if (path !== null) file.bPath = path;
      continue;
    }
  }

  finish();
  return files;
}

/** A `FileDiff` under construction, plus the bookkeeping that does not survive it. */
interface Draft {
  path: string;
  oldPath?: string;
  status: FileStatusCode;
  similarity?: number;
  additions: number;
  deletions: number;
  binary: boolean;
  hunks: Hunk[];
  noNewlineOld: boolean;
  noNewlineNew: boolean;
  /** The mode either side of the diff, for the chmod note. */
  modeFrom?: string;
  modeTo?: string;
  /** The single mode of a file whose mode did not change — `160000` is a submodule. */
  mode?: string;
  /** Where the `---`/`+++` lines said the file is, which beats the header split. */
  aPath?: string;
  bPath?: string;
  lastLineKind?: string;
  combined: boolean;
}

function draft(a: string | null, b: string | null): Draft {
  return {
    path: b ?? a ?? '',
    status: 'M',
    additions: 0,
    deletions: 0,
    binary: false,
    hunks: [],
    noNewlineOld: false,
    noNewlineNew: false,
    combined: false,
  };
}

/** The draft as the type the rest of the app reads. */
function seal(file: Draft): FileDiff {
  // `rename to` and the `+++` line agree when both are there; when only one is,
  // it wins over the ambiguous `diff --git` split the draft started from.
  const path = file.status === 'R' || file.status === 'C'
    ? file.path || file.bPath || ''
    : file.bPath ?? file.aPath ?? file.path;

  const diff: FileDiff = {
    path,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    binary: file.binary,
    generated: false,
    whitespaceOnly: false,
    submodule: file.mode === SUBMODULE_MODE
      || file.modeFrom === SUBMODULE_MODE
      || file.modeTo === SUBMODULE_MODE,
    hunks: file.hunks,
  };
  const oldPath = file.oldPath ?? ((file.status === 'R' || file.status === 'C') ? file.aPath : undefined);
  if (oldPath !== undefined) diff.oldPath = oldPath;
  if (file.similarity !== undefined) diff.similarity = file.similarity;
  if (file.modeFrom !== undefined && file.modeTo !== undefined) {
    diff.modeChange = { from: file.modeFrom, to: file.modeTo };
  }
  if (file.noNewlineOld && file.noNewlineNew) diff.noNewlineAtEof = 'both';
  else if (file.noNewlineOld) diff.noNewlineAtEof = 'old';
  else if (file.noNewlineNew) diff.noNewlineAtEof = 'new';
  return diff;
}

/**
 * Which side the `\ No newline at end of file` above us belongs to.
 *
 * It describes the previous line: after a `-` the old file ends without one,
 * after a `+` the new one does, and after a context line — an unchanged last
 * line that never had one — both do.
 */
function noteMissingNewline(file: Draft): void {
  if (file.lastLineKind === '-') file.noNewlineOld = true;
  else if (file.lastLineKind === '+') file.noNewlineNew = true;
  else {
    file.noNewlineOld = true;
    file.noNewlineNew = true;
  }
}

/**
 * One path from a `---` or `+++` line, or null for `/dev/null` — the side a
 * file that was added or deleted does not exist on.
 *
 * The trailing TAB git adds to an unquoted name containing a space goes first,
 * then the quoting, then the `a/`/`b/` prefix. Only the first prefix is
 * stripped, so `a/a/deep.ts` survives.
 */
function headerPath(rest: string): string | null {
  const unquoted = unquotePath(rest.replace(/\t$/, ''));
  if (unquoted === '/dev/null') return null;
  return unquoted.replace(/^[ab]\//, '');
}

/**
 * The two paths of a `diff --git` header, prefixes stripped, `null` where the
 * split could not be trusted.
 *
 * Quoted, it is two C-strings and unambiguous. Unquoted, it is `a/<x> b/<y>`
 * with no escaping at all, so the only honest reading is the one where both
 * halves agree — which covers every case but a rename, and a rename says its
 * paths again in `rename from`/`rename to`. Failing that the last ` b/` is a
 * guess, kept because a wrong path is still better than no entry: the `---`
 * and `+++` lines will correct it if they exist, and if they do not (a chmod,
 * a binary file) there is nothing else to go on.
 */
function headerPaths(rest: string): [string | null, string | null] {
  if (rest.startsWith('"')) {
    const first = readQuoted(rest);
    if (first) {
      const second = rest.slice(first.end).trimStart();
      return [strip(unquotePath(first.text)), strip(unquotePath(second))];
    }
  }

  for (let at = rest.indexOf(' b/'); at >= 0; at = rest.indexOf(' b/', at + 1)) {
    const left = rest.slice(0, at);
    const right = rest.slice(at + 1);
    if (left.startsWith('a/') && left.slice(2) === right.slice(2)) {
      return [left.slice(2), right.slice(2)];
    }
  }

  const last = rest.lastIndexOf(' b/');
  if (last < 0) return [null, null];
  return [strip(rest.slice(0, last)), strip(rest.slice(last + 1))];
}

/** The `a/` or `b/` a diff header puts in front of every path. */
function strip(path: string): string {
  return path.replace(/^[ab]\//, '');
}

/** A quoted path and where it ended, honouring the backslash escapes inside it. */
function readQuoted(text: string): { text: string; end: number } | null {
  for (let i = 1; i < text.length; i++) {
    if (text[i] === '\\') { i += 1; continue; }
    if (text[i] === '"') return { text: text.slice(0, i + 1), end: i + 1 };
  }
  return null;
}

/**
 * A C-quoted path as its real name.
 *
 * The escapes are the ones `quote_c_style` emits, and `\NNN` is octal for one
 * *byte* — a non-ASCII name arrives as its UTF-8 bytes one escape at a time —
 * so the bytes are collected and decoded together at the end rather than
 * turned into characters as they are read. Anything not actually quoted comes
 * back untouched.
 */
function unquotePath(text: string): string {
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) return text;
  const body = text.slice(1, -1);
  const bytes: number[] = [];

  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') {
      // Inside a quoted name every character git did not escape is ASCII.
      bytes.push(body.charCodeAt(i) & 0xff);
      continue;
    }
    const next = body[i + 1];
    const octal = /^[0-7]{3}/.exec(body.slice(i + 1, i + 4));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += 3;
      continue;
    }
    const escaped = ESCAPES[next];
    if (escaped !== undefined) {
      bytes.push(escaped);
      i += 1;
      continue;
    }
    // A backslash before something that is not an escape is a backslash.
    bytes.push(0x5c);
  }

  return new TextDecoder().decode(new Uint8Array(bytes));
}

const ESCAPES: Record<string, number> = {
  '"': 0x22, '\\': 0x5c, a: 0x07, b: 0x08, f: 0x0c, n: 0x0a, r: 0x0d, t: 0x09, v: 0x0b,
};
