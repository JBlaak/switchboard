/**
 * Reading a unified diff, and deciding which of its files start collapsed.
 *
 * The page shows diffs from two places — a local `git diff` and `gh pr diff` —
 * and both speak git's unified format, so one parser serves both. Its output
 * keeps every line's number on both sides, because a review comment is pinned
 * to GitHub's `line` + `side`, and a deleted line only has a number on the left.
 */
import type { CollapsedReason, DiffHunk, DiffLine, DiffSide, FileDiff } from './model';

/** Files with more changed lines than this start collapsed (D7). */
export const LARGE_DIFF_LINES = 400;

/** Lock files, matched by file name wherever they sit in the tree. */
const LOCKFILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock',
  'Gemfile.lock', 'composer.lock', 'Podfile.lock', 'go.sum',
]);

/** Build output directories, at any depth so a monorepo package's `dist/` counts too. */
const BUILD_OUTPUT = /(?:^|\/)(?:dist|build|out)\//;

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

const DEV_NULL = '/dev/null';

/** What the parser has gathered about a file before it knows its status. */
interface FileBuilder {
  oldPath: string | null;
  newPath: string | null;
  added: boolean;
  deleted: boolean;
  renamed: boolean;
  copied: boolean;
  binary: boolean;
  /** A `---` line was seen: a second one starts the next file of a plain diff. */
  sawOldHeader: boolean;
  hunks: DiffHunk[];
}

function newBuilder(): FileBuilder {
  return {
    oldPath: null, newPath: null, added: false, deleted: false, renamed: false,
    copied: false, binary: false, sawOldHeader: false, hunks: [],
  };
}

/**
 * Undo git's C-style quoting of a path with unusual characters in it.
 *
 * Git writes such paths as `"a/caf\303\251.txt"`: octal bytes of the UTF-8
 * encoding, so the bytes are collected and decoded together rather than one
 * escape at a time, or a non-ASCII name would come out as mojibake.
 */
function unquote(quoted: string): string {
  const body = quoted.slice(1, -1);
  const bytes: number[] = [];
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') {
      for (const byte of new TextEncoder().encode(ch)) bytes.push(byte);
      continue;
    }
    const next = body[i + 1];
    if (/[0-7]/.test(next ?? '')) {
      const octal = body.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)![0];
      bytes.push(parseInt(octal, 8));
      i += octal.length;
    } else if (next !== undefined && next in simple) {
      bytes.push(simple[next]);
      i += 1;
    } else {
      bytes.push(92);
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** A path from a `---`/`+++`/`rename` line: unquoted, without git's `a/`/`b/` prefix. */
function cleanPath(raw: string, prefix: 'a/' | 'b/' | null): string {
  let path = raw.trim();
  if (path.startsWith('"') && path.endsWith('"') && path.length >= 2) {
    path = unquote(path);
  } else {
    // A plain `diff -u` appends a tab and a timestamp.
    path = path.replace(/\t.*$/, '');
  }
  if (path === DEV_NULL) return path;
  if (prefix && path.startsWith(prefix)) path = path.slice(prefix.length);
  return path;
}

/**
 * The two paths of a `diff --git a/X b/Y` line.
 *
 * Unquoted paths may contain spaces, so the split cannot just look for a
 * space. For anything but a rename both halves name the same file, which pins
 * down where they meet; a rename names its paths again on `rename from/to`
 * lines, so the first-`" b/"` fallback only has to be good enough until then.
 */
function gitHeaderPaths(rest: string): [string, string] | null {
  const quoted = rest.match(/^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*")$/) ??
    rest.match(/^("(?:[^"\\]|\\.)*") (\S+)$/);
  if (quoted && (quoted[1].startsWith('"') || quoted[2].startsWith('"'))) {
    return [cleanPath(quoted[1], 'a/'), cleanPath(quoted[2], 'b/')];
  }
  if ((rest.length - 1) % 2 === 0) {
    const half = (rest.length - 1) / 2;
    const left = rest.slice(0, half);
    const right = rest.slice(half + 1);
    if (rest[half] === ' ' && left.startsWith('a/') && right.startsWith('b/') && left.slice(2) === right.slice(2)) {
      return [left.slice(2), right.slice(2)];
    }
  }
  const split = rest.indexOf(' b/');
  if (split < 0) return null;
  return [cleanPath(rest.slice(0, split), 'a/'), cleanPath(rest.slice(split + 1), 'b/')];
}

function finish(builder: FileBuilder): FileDiff | null {
  const oldPath = builder.oldPath === DEV_NULL ? null : builder.oldPath;
  const newPath = builder.newPath === DEV_NULL ? null : builder.newPath;
  const path = newPath ?? oldPath;
  if (!path) return null;

  let status: FileDiff['status'] = 'modified';
  if (builder.deleted || builder.newPath === DEV_NULL) status = 'deleted';
  else if (builder.added || builder.oldPath === DEV_NULL) status = 'added';
  else if (builder.renamed) status = 'renamed';
  else if (builder.copied) status = 'copied';

  let additions = 0;
  let deletions = 0;
  for (const hunk of builder.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'add') additions++;
      else if (line.kind === 'delete') deletions++;
    }
  }

  const file: FileDiff = {
    path: status === 'deleted' ? (oldPath ?? path) : path,
    status,
    additions,
    deletions,
    hunks: builder.hunks,
    binary: builder.binary,
  };
  if ((status === 'renamed' || status === 'copied') && oldPath) file.oldPath = oldPath;
  return file;
}

/** Options for {@link parseUnifiedDiff}. */
export interface ParseDiffOptions {
  /**
   * Paths `.gitattributes` marks `linguist-generated`. Reading attributes takes
   * git itself (`git check-attr`), so the adapter asks and passes the answer in.
   */
  generatedPaths?: Iterable<string>;
}

/**
 * Turn unified diff text into files, hunks and numbered lines, with each file's
 * collapse rule applied.
 *
 * A hunk is read by its line counts rather than by what its lines look like,
 * because a deleted line that read `-- x` arrives as `--- x`, which is also
 * what a file header looks like. Anything the parser does not recognise is
 * skipped: a diff is shown to help review, and one odd line is no reason to
 * show nothing.
 */
export function parseUnifiedDiff(text: string, options: ParseDiffOptions = {}): FileDiff[] {
  const generated = new Set(options.generatedPaths ?? []);
  const files: FileDiff[] = [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();

  let file: FileBuilder | null = null;
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;

  const flush = () => {
    if (file) {
      const done = finish(file);
      if (done) files.push(done);
    }
    file = null;
    hunk = null;
    oldLeft = newLeft = 0;
  };

  for (const line of lines) {
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const marker = line[0];
      // Some tools strip the space off an empty context line.
      if (line === '' || line === '\r' || marker === ' ') {
        (hunk as DiffHunk).lines.push({ kind: 'context', text: line.slice(1), oldLine: oldLine++, newLine: newLine++ });
        oldLeft--;
        newLeft--;
        continue;
      }
      if (marker === '+') {
        (hunk as DiffHunk).lines.push({ kind: 'add', text: line.slice(1), oldLine: null, newLine: newLine++ });
        newLeft--;
        continue;
      }
      if (marker === '-') {
        (hunk as DiffHunk).lines.push({ kind: 'delete', text: line.slice(1), oldLine: oldLine++, newLine: null });
        oldLeft--;
        continue;
      }
      if (marker === '\\') {
        markNoNewline(hunk);
        continue;
      }
      // A hunk shorter than its header said: fall through and read it as a header.
      oldLeft = newLeft = 0;
    }

    if (line.startsWith('\\')) {
      if (hunk) markNoNewline(hunk);
      continue;
    }

    const header = line.replace(/\r$/, '');

    if (header.startsWith('diff --git ')) {
      flush();
      file = newBuilder();
      const paths = gitHeaderPaths(header.slice('diff --git '.length));
      if (paths) [file.oldPath, file.newPath] = paths;
      continue;
    }

    if (header.startsWith('--- ')) {
      // A plain unified diff has no `diff --git` line between files.
      if (!file || (file as FileBuilder).sawOldHeader) {
        flush();
        file = newBuilder();
      }
      const current = file as FileBuilder;
      current.sawOldHeader = true;
      current.oldPath = cleanPath(header.slice(4), 'a/');
      continue;
    }

    if (!file) continue;
    const current = file as FileBuilder;

    if (header.startsWith('+++ ')) {
      current.newPath = cleanPath(header.slice(4), 'b/');
    } else if (header.startsWith('new file mode')) {
      current.added = true;
    } else if (header.startsWith('deleted file mode')) {
      current.deleted = true;
    } else if (header.startsWith('rename from ')) {
      current.renamed = true;
      current.oldPath = cleanPath(header.slice('rename from '.length), null);
    } else if (header.startsWith('rename to ')) {
      current.renamed = true;
      current.newPath = cleanPath(header.slice('rename to '.length), null);
    } else if (header.startsWith('copy from ')) {
      current.copied = true;
      current.oldPath = cleanPath(header.slice('copy from '.length), null);
    } else if (header.startsWith('copy to ')) {
      current.copied = true;
      current.newPath = cleanPath(header.slice('copy to '.length), null);
    } else if (header.startsWith('Binary files ') || header === 'GIT binary patch') {
      current.binary = true;
      if (/^Binary files \/dev\/null and /.test(header)) current.added = true;
      if (/ and \/dev\/null differ$/.test(header)) current.deleted = true;
    } else {
      const match = HUNK_HEADER.exec(header);
      if (match) {
        const next: DiffHunk = {
          oldStart: Number(match[1]),
          oldLines: match[2] === undefined ? 1 : Number(match[2]),
          newStart: Number(match[3]),
          newLines: match[4] === undefined ? 1 : Number(match[4]),
          section: match[5].trim(),
          lines: [],
        };
        current.hunks.push(next);
        hunk = next;
        oldLine = next.oldStart;
        newLine = next.newStart;
        oldLeft = next.oldLines;
        newLeft = next.newLines;
      }
    }
  }
  flush();

  for (const parsed of files) {
    const reason = collapseReason(parsed, generated);
    if (reason) parsed.collapsedReason = reason;
  }
  return files;
}

function markNoNewline(hunk: DiffHunk): void {
  const last = hunk.lines[hunk.lines.length - 1];
  if (last) last.noNewlineAtEnd = true;
}

/**
 * Why a file should start collapsed, or null when it should be open.
 *
 * These are the files nobody reviews line by line: a lock file is the output
 * of a command, a generated file of a build, and a 2000-line change opened by
 * default would push every other file off the screen. They stay one click away.
 */
export function collapseReason(
  file: Pick<FileDiff, 'path' | 'additions' | 'deletions'>,
  generatedPaths: ReadonlySet<string> = new Set(),
): CollapsedReason | null {
  const name = file.path.slice(file.path.lastIndexOf('/') + 1);
  if (LOCKFILES.has(name)) return 'lockfile';
  if (generatedPaths.has(file.path) || BUILD_OUTPUT.test(file.path)) return 'generated';
  if (file.additions + file.deletions > LARGE_DIFF_LINES) return 'large';
  return null;
}

/**
 * Where a comment on this line is pinned on GitHub.
 *
 * A deleted line only exists in the old file, so it is addressed by its old
 * number on the left; everything else by its new number on the right, which is
 * also where GitHub puts a comment on an unchanged line.
 */
export function commentAnchor(line: DiffLine): { line: number; side: DiffSide } {
  if (line.kind === 'delete') return { line: line.oldLine!, side: 'LEFT' };
  return { line: line.newLine!, side: 'RIGHT' };
}
