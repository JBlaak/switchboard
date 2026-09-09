/**
 * Parsing `git status --porcelain=v2 -z --untracked-files=normal --branch`.
 *
 * Version 2 rather than the familiar `XY path` because it carries the rename
 * score and tells a submodule from a file, and `-z` because a path may contain
 * anything but a NUL — a newline included, which is exactly the filename that
 * turns a line-based parser into a security bug. So the output is a stream of
 * NUL-terminated *fields*, and a record is one field, except for a rename,
 * which is three:
 *
 *     1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>              a tracked change
 *     2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>\0<origPath>
 *     u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>    unmerged
 *     ? <path>                                                  untracked
 *     ! <path>                                                  ignored
 *     # branch.oid <sha> | (initial)                            header
 *     # branch.head <name> | (detached)                         header
 *
 * The rename record is the one that catches every parser written from memory:
 * the new path comes first and the *original* path is a whole extra field, so
 * a reader that treats one field as one record silently gains a phantom entry
 * named after the old path. Fields, not records, is why the loop below tracks
 * its own index.
 *
 * Nothing here trims or normalises a path. Under `-z` git does not quote it and
 * does not translate it, so the bytes between the NULs are the filename — a
 * trailing CR belongs to the name, and stripping it would name a file that does
 * not exist.
 */
import type { FileStatus, FileStatusCode, StatusBranch } from './types';

/**
 * Every changed path git reported, in git's order.
 *
 * Ignored entries (`!`) are dropped: they only appear when `--ignored` is
 * asked for, and nothing in the app renders them. A malformed record is
 * dropped too rather than thrown over — this is read while an agent is writing
 * in the same directory, and one unparseable line is not a reason to show the
 * user nothing.
 */
export function parseStatus(stdout: string): FileStatus[] {
  const fields = stdout.split('\0');
  const files: FileStatus[] = [];

  for (let i = 0; i < fields.length; i++) {
    const record = fields[i];
    if (record === '' || record.startsWith('#') || record.startsWith('!')) continue;

    if (record.startsWith('? ')) {
      // A directory git has not looked inside, `--untracked-files=normal`'s
      // whole point, arrives as `? sub/` — one entry with a trailing slash
      // standing for everything under it. Kept as git spells it, since the
      // slash is the only thing that says "and everything in here".
      files.push({ path: record.slice(2), status: '?' });
      continue;
    }

    if (record.startsWith('1 ')) {
      const parts = splitFields(record, 9);
      if (!parts) continue;
      files.push({ path: parts[8], status: combinedStatus(parts[1]) });
      continue;
    }

    if (record.startsWith('2 ')) {
      const parts = splitFields(record, 10);
      // The original path is the next field whether or not this record parsed,
      // so the index moves on either way — otherwise it would be read as a
      // record of its own.
      const original = fields[i + 1];
      i += 1;
      if (!parts || original === undefined) continue;
      const score = /^([RC])(\d+)$/.exec(parts[8]);
      const renamed: FileStatus = {
        path: parts[9],
        // The score field, not XY: `2 RM …` is a rename that has since been
        // edited, and it is still a rename.
        status: score ? (score[1] as FileStatusCode) : combinedStatus(parts[1]),
        oldPath: original,
      };
      if (score) renamed.similarity = Number(score[2]);
      files.push(renamed);
      continue;
    }

    if (record.startsWith('u ')) {
      const parts = splitFields(record, 11);
      if (!parts) continue;
      files.push({ path: parts[10], status: 'U' });
    }
  }

  return files;
}

/**
 * The `# branch.*` headers, which is where the HEAD sha lives.
 *
 * Worth asking for even when only the file list is wanted: it makes one
 * `git status` answer both "what changed" and "which commit is this", and the
 * pair of them is exactly the cache key the diff needs. `(initial)` is a branch
 * with no commits on it yet and `(detached)` is a HEAD that is not on a branch;
 * both are ordinary states, not errors.
 */
export function parseStatusBranch(stdout: string): StatusBranch {
  let head: string | null = null;
  let branch: string | null = null;
  let detached = false;

  for (const field of stdout.split('\0')) {
    if (field.startsWith('# branch.oid ')) {
      const oid = field.slice('# branch.oid '.length);
      head = oid === '(initial)' ? null : oid;
    } else if (field.startsWith('# branch.head ')) {
      const name = field.slice('# branch.head '.length);
      detached = name === '(detached)';
      branch = detached ? null : name;
    }
  }

  return { head, branch, detached };
}

/**
 * `count` space-separated fields, the last one holding everything left.
 *
 * The path is always last and may contain spaces, so it cannot be split on;
 * every field before it is fixed-width-ish and cannot contain one. Null when
 * the record ran out of fields, which means it is not the record it claimed.
 */
function splitFields(record: string, count: number): string[] | null {
  const parts: string[] = [];
  let from = 0;
  for (let n = 0; n < count - 1; n++) {
    const space = record.indexOf(' ', from);
    if (space < 0) return null;
    parts.push(record.slice(from, space));
    from = space + 1;
  }
  const last = record.slice(from);
  if (last === '') return null;
  parts.push(last);
  return parts;
}

/**
 * `XY` — index against HEAD, worktree against index — as the one letter the
 * surface renders.
 *
 * Gone from disk wins over everything: `MD` is a file that was edited and then
 * deleted, and the useful thing to say about it is that it is not there. Below
 * that the index column speaks first, because it names the change against HEAD
 * — `AM` is a new file that has been edited since, and it is still new — and
 * the worktree column fills in when the index has nothing to say (`.M`).
 */
function combinedStatus(xy: string): FileStatusCode {
  const index = xy[0] ?? '.';
  const worktree = xy[1] ?? '.';
  if (worktree === 'D') return 'D';
  const letter = index !== '.' ? index : worktree;
  return isStatusCode(letter) ? letter : 'M';
}

/** `T` (a file that became a symlink) and anything unexpected read as a modification. */
function isStatusCode(letter: string): letter is FileStatusCode {
  return letter === 'M' || letter === 'A' || letter === 'D'
    || letter === 'R' || letter === 'C' || letter === 'U';
}
