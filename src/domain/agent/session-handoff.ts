/**
 * The rules of a session hand-off (#276 stage 3) that need no git and no link:
 * which checkout a session works in, and how its transcript is changed to
 * continue on the VM.
 *
 * A session hand-off moves a conversation, and a conversation is tied to a
 * folder. Claude keeps a transcript under the folder it ran in, and writes
 * that folder into every line as `cwd`. On the VM the conversation goes on in
 * the copy (or in a worktree of the copy with the same name, when the session
 * worked in a worktree), so the checkout has to be known first and the
 * transcript's `cwd` changed to the VM's folder before it goes over.
 */

/** Where Claude Code makes the worktrees of `claude --worktree`, under the repository's root. */
export const CLAUDE_WORKTREES_SEGMENT = '/.claude/worktrees/';

/** The checkout a session works in, as git and the transcript name it. */
export type SessionCheckout =
    | {
          kind: 'main';
          /** The repository's main checkout, which is also `root`. */
          checkout: string;
          root: string;
      }
    | {
          kind: 'worktree';
          /**
           * The worktree's name: its folder under `<root>/.claude/worktrees/`, or
           * the last segment of a linked worktree kept anywhere else. The VM
           * recreates it at `<copy>/.claude/worktrees/<name>` either way.
           */
          name: string;
          /** The linked worktree's own top folder on the Mac. */
          checkout: string;
          /** The main checkout of the repository the worktree belongs to. */
          root: string;
      };

/**
 * Which checkout a session works in.
 *
 * `toplevel` is `git rev-parse --show-toplevel` in the session's `cwd`, and
 * `commonDir` is `git rev-parse --git-common-dir` there, as an absolute path.
 * In a main checkout the common dir is `<toplevel>/.git`; in a linked worktree
 * it is the main checkout's `.git`, which is how the two are told apart (a
 * worktree's own `.git` is a file pointing there). A common dir that is not a
 * `.git` folder (a bare repository, a submodule's `modules/` entry) has no
 * main checkout to copy, and is answered with why.
 */
export function sessionCheckout(toplevel: string, commonDir: string): SessionCheckout | {error: string} {
    const top = trimSlashes(toplevel);
    const common = trimSlashes(commonDir);
    if (!common.endsWith('/.git')) {
        return {error: 'This session works in a repository without a main checkout, which cannot be handed off.'};
    }
    const root = common.slice(0, -'/.git'.length);
    if (top === root) return {kind: 'main', checkout: top, root};
    const under = root + CLAUDE_WORKTREES_SEGMENT;
    const rest = top.startsWith(under) ? top.slice(under.length) : '';
    const name = rest && !rest.includes('/') ? rest : top.slice(top.lastIndexOf('/') + 1);
    if (!name) return {error: `Could not name the worktree at ${toplevel}.`};
    return {kind: 'worktree', name, checkout: top, root};
}

/**
 * A transcript with every line's own `cwd` moved from `from` to `to`.
 *
 * Only the top-level `cwd` of each JSONL line changes, and only when it is
 * `from` or a folder under it: the rest of the line stays byte for byte as
 * Claude wrote it, line endings included, and so does every line that does
 * not parse or has no such `cwd`. The change is spliced into the raw text
 * rather than made by parsing and re-serialising the line, which would
 * reorder nothing but could still re-escape characters (`U+2028`, `/`) and
 * change numbers' spelling.
 *
 * Nothing else is rewritten, on purpose:
 * - Message text and tool calls name Mac paths (`/Users/…/src/a.ts`), but
 *   they are what was said and done, and Claude reads them as history; a
 *   rewrite there would change the conversation and could mangle code.
 * - `gitBranch` is the same on the VM: the copy (or its worktree) is on the
 *   same branch.
 * - `sessionId` is kept: the session resumes under its own id.
 * - Nested objects that happen to have a `cwd` (a tool's result) are part of
 *   the history too.
 * Claude finds the transcript by the folder it lives in on the VM, which the
 * agent's `import-transcript` decides; the `cwd` lines are what Switchboard
 * reads to tell which project a transcript belongs to, and what Claude shows.
 */
export function rewriteTranscriptCwd(transcript: string, from: string, to: string): string {
    const source = trimSlashes(from);
    const target = trimSlashes(to);
    if (!source) return transcript;
    return transcript
        .split('\n')
        .map((line) => rewriteLine(line, source, target))
        .join('\n');
}

/** One line, its top-level `cwd` moved when it names `from` or a folder under it. */
function rewriteLine(line: string, from: string, to: string): string {
    const span = topLevelStringValue(line, 'cwd');
    if (!span) return line;
    let cwd: unknown;
    try {
        cwd = JSON.parse(line.slice(span.start, span.end));
    } catch {
        return line;
    }
    if (typeof cwd !== 'string') return line;
    const moved = movedPath(cwd, from, to);
    if (moved === null) return line;
    return line.slice(0, span.start) + JSON.stringify(moved) + line.slice(span.end);
}

/** `path` with its `from` prefix replaced by `to`; null when it is neither `from` nor under it. */
function movedPath(path: string, from: string, to: string): string | null {
    const trimmed = trimSlashes(path);
    if (trimmed === from) return to;
    if (trimmed.startsWith(from + '/')) return to + trimmed.slice(from.length);
    return null;
}

/**
 * Where the string value of `key` in a JSON object's top level sits in
 * `line`: the quoted value, quotes included. Null when the line is not an
 * object, has no such key at its top level, or the value is not a string.
 * A small scanner rather than `JSON.parse`, because the caller needs the
 * position to splice at, not the value.
 */
function topLevelStringValue(line: string, key: string): {start: number; end: number} | null {
    let index = skipSpace(line, 0);
    if (line[index] !== '{') return null;
    let depth = 0;
    let expectKey = false;
    for (; index < line.length; index++) {
        const char = line[index];
        if (char === '"') {
            const end = stringEnd(line, index);
            if (end < 0) return null;
            if (depth === 1 && expectKey) {
                const name = line.slice(index, end);
                const colon = skipSpace(line, end);
                if (line[colon] !== ':') return null;
                const value = skipSpace(line, colon + 1);
                if (name === JSON.stringify(key)) {
                    if (line[value] !== '"') return null;
                    const valueEnd = stringEnd(line, value);
                    return valueEnd < 0 ? null : {start: value, end: valueEnd};
                }
                expectKey = false;
                index = colon;
                continue;
            }
            index = end - 1;
            continue;
        }
        if (char === '{' || char === '[') {
            depth++;
            expectKey = char === '{' && depth === 1;
        } else if (char === '}' || char === ']') {
            depth--;
            if (depth === 0) return null;
        } else if (char === ',' && depth === 1) {
            expectKey = true;
        }
    }
    return null;
}

/** The index just past the string starting at `start` (a `"`); -1 when it never closes. */
function stringEnd(text: string, start: number): number {
    for (let index = start + 1; index < text.length; index++) {
        const char = text[index];
        if (char === '\\') index++;
        else if (char === '"') return index + 1;
    }
    return -1;
}

function skipSpace(text: string, from: number): number {
    let index = from;
    while (index < text.length && ' \t\r\n'.includes(text[index])) index++;
    return index;
}

function trimSlashes(path: string): string {
    return path.length > 1 ? path.replace(/\/+$/, '') : path;
}
