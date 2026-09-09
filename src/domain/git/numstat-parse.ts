/**
 * Parsing the summary of a diff — how big each file's change is, and what kind
 * of change it was — without reading a single line of it.
 *
 * This is the cheap half of the two-phase diff. `git diff --raw --numstat -z`
 * is one command that prints two sections, and between them they say everything
 * the file list needs: the raw section names what happened to each path, the
 * numstat section says how many lines it cost. Neither carries content, so a
 * session that has just regenerated `package-lock.json` is known to be 12,000
 * lines without those 12,000 lines crossing a pipe.
 *
 *     :100644 100644 58dd9fe 0000000 M\0b.bin\0            raw: modes and status
 *     :100644 100644 470f8c7 4019642 R097\0from\0to\0      raw: a rename, two paths
 *     -\t-\tb.bin\0                                        numstat: binary
 *     4\t0\tto.txt\0                                       numstat: +4 −0
 *     1\t1\t\0from\0to\0                                   numstat: a rename
 *
 * Both sections are NUL-framed and both spell a rename as *two extra fields*,
 * which is the thing to get right. Numstat's version is the sneakier one: the
 * path where a path should be is empty, and the real paths — old first, then
 * new — follow as their own fields. A parser that reads one field as one record
 * turns a single rename into three bogus entries.
 *
 * Each function skips the other's records, so both can be handed the whole
 * stream of one combined call.
 *
 * Whether a rename is spelled that way at all is git's decision, not a
 * guarantee: rename detection compares content, and two short files that happen
 * to differ enough come back as a plain delete and add. Callers must handle
 * both spellings.
 */
import type { FileStatusCode, NumstatEntry, RawDiffEntry } from './types';

/** `<additions>\t<deletions>\t<path>`, with `-\t-\t` for a file git will not count. */
const NUMSTAT_RECORD = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/;

/** `:<oldMode> <newMode> <oldSha> <newSha> <status>`, the status carrying a score for R and C. */
const RAW_RECORD = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(\d*)$/;

/**
 * The numstat section, in git's order.
 *
 * A binary file reports `-` for both counts, because "lines" is not a thing it
 * has; it is reported as zero and zero with `binary` set rather than as a
 * number nobody should trust.
 */
export function parseNumstat(stdout: string): NumstatEntry[] {
  const fields = stdout.split('\0');
  const entries: NumstatEntry[] = [];

  for (let i = 0; i < fields.length; i++) {
    // Step over the other section's records and their paths, so a filename can
    // never be mistaken for a record of this section's shape.
    const raw = RAW_RECORD.exec(fields[i]);
    if (raw) {
      i += raw[5] === 'R' || raw[5] === 'C' ? 2 : 1;
      continue;
    }

    const match = NUMSTAT_RECORD.exec(fields[i]);
    if (!match) continue;

    const binary = match[1] === '-' || match[2] === '-';
    const additions = binary ? 0 : Number(match[1]);
    const deletions = binary ? 0 : Number(match[2]);

    if (match[3] !== '') {
      entries.push({ path: match[3], additions, deletions, binary });
      continue;
    }

    // The empty path is the rename marker: the two fields after it are the old
    // path and the new one, in that order.
    // An absent or empty field is output that was cut off: a filename is never
    // empty, and the last thing `split` hands back is the tail after the final
    // NUL.
    const oldPath = fields[i + 1];
    const path = fields[i + 2];
    if (!oldPath || !path) break;
    i += 2;
    entries.push({ path, oldPath, additions, deletions, binary });
  }

  return entries;
}

/**
 * The raw section, in git's order.
 *
 * The modes are what makes this worth asking for beyond the status letter: a
 * `160000` on either side is a submodule rather than a file, and two different
 * non-zero modes are a chmod, which the surface has to mention because the
 * hunks will not (a file that only gained the execute bit has no hunks at all).
 */
export function parseRawDiff(stdout: string): RawDiffEntry[] {
  const fields = stdout.split('\0');
  const entries: RawDiffEntry[] = [];

  for (let i = 0; i < fields.length; i++) {
    // The mirror of the skip in `parseNumstat`: a numstat rename's two path
    // fields are stepped over rather than examined.
    const numstat = NUMSTAT_RECORD.exec(fields[i]);
    if (numstat) {
      if (numstat[3] === '') i += 2;
      continue;
    }

    const match = RAW_RECORD.exec(fields[i]);
    if (!match) continue;

    const status = rawStatus(match[5]);
    const renamed = status === 'R' || status === 'C';
    const entry: RawDiffEntry = {
      path: '',
      status,
      oldMode: match[1],
      newMode: match[2],
    };
    if (match[6] !== '') entry.similarity = Number(match[6]);

    if (renamed) {
      const oldPath = fields[i + 1];
      const path = fields[i + 2];
      if (!oldPath || !path) break;
      i += 2;
      entry.oldPath = oldPath;
      entry.path = path;
    } else {
      const path = fields[i + 1];
      if (!path) break;
      i += 1;
      entry.path = path;
    }

    entries.push(entry);
  }

  return entries;
}

/**
 * git's raw status letter as one of ours.
 *
 * `T` is a type change — a file replaced by a symlink or a submodule — and `X`
 * and `B` are git reporting that it could not pair the two sides. All three
 * read as a modification: the file is there on both sides and its content is
 * different, which is all the surface does with them.
 */
function rawStatus(letter: string): FileStatusCode {
  switch (letter) {
    case 'A': case 'D': case 'M': case 'R': case 'C': case 'U': return letter;
    default: return 'M';
  }
}
