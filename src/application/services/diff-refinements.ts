/**
 * OmniDiff's refinement of a file in a work page's diff, the same for every
 * page: a session's (its sides read with git) and a pull request's own (its
 * sides read from GitHub). Only the reading of a side differs; which files are
 * refined, what text the differ is shown and what is kept are decided here.
 */
import type {FileDiff} from '../../domain/session-work/model';
import type {FileRefinement} from '../../domain/session-work/refinement';
import type {GitHubCli} from '../ports/github-cli';
import type {Logger} from '../ports/logger';
import {noStructuralDiffer, type StructuralDiffer} from '../ports/structural-differ';

/** Past this, a side is not refined: its lines are drawn plain. */
export const REFINE_MAX_BYTES = 1024 * 1024;

/** Where the two sides of a diff are read. */
export interface DiffSideReader {
    /**
     * The two commits the sides are read at, as one key; null when the after
     * side is the working tree, which can change under it.
     */
    readonly commits: string | null;
    before(path: string): Promise<Uint8Array | null>;
    after(path: string): Promise<Uint8Array | null>;
}

/** A GitHub repository's files at two commits: GitHub's diff of a PR is between its merge-base and head. */
export function gitHubSides(
    github: Pick<GitHubCli, 'fileAt'>,
    repository: string,
    mergeBase: string,
    head: string,
): DiffSideReader {
    return {
        commits: ['github', repository, mergeBase, head].join('\0'),
        before: (path) => github.fileAt(repository, mergeBase, path),
        after: (path) => github.fileAt(repository, head, path),
    };
}

/**
 * The refinements one page made, kept for the page's life: between two
 * commits a file never changes, so neither does what the differ says of it.
 */
export class DiffRefinements {
    private readonly kept = new Map<string, Promise<FileRefinement | null>>();

    constructor(
        private readonly deps: {differ?: StructuralDiffer; log: Logger},
        /** What a failure is logged under, e.g. `[session-work]`. */
        private readonly tag: string,
    ) {}

    /**
     * The differ's reading of `file`, its sides read by `sides`. Null for a
     * file it has nothing to add to (see `refinable`), or a side that is not
     * UTF-8 text no larger than `REFINE_MAX_BYTES`.
     */
    public refine(file: FileDiff, sides: DiffSideReader): Promise<FileRefinement | null> {
        if (!refinable(file)) return Promise.resolve(null);
        const oldPath = file.oldPath ?? file.path;
        if (sides.commits === null) return this.read(file.path, oldPath, sides);
        return memo(this.kept, [sides.commits, oldPath, file.path].join('\0'), () =>
            this.read(file.path, oldPath, sides),
        );
    }

    /** Read both sides and hand them to the differ; null when either is not text it should see. */
    private async read(path: string, oldPath: string, sides: DiffSideReader): Promise<FileRefinement | null> {
        const {differ = noStructuralDiffer, log} = this.deps;
        try {
            const [beforeBytes, afterBytes] = await Promise.all([sides.before(oldPath), sides.after(path)]);
            const beforeText = refinableText(beforeBytes);
            const afterText = refinableText(afterBytes);
            if (beforeText === null || afterText === null) return null;
            return await differ.refine(path, beforeText, afterText);
        } catch (err) {
            log.debug(this.tag, 'refining', path, 'failed:', (err as Error).message);
            return null;
        }
    }
}

/**
 * The answer kept under `key`, or `read`'s, kept. A null is not kept: it may
 * be a passing failure (a timeout under load), so the next ask tries again.
 */
export function memo<T>(
    kept: Map<string, Promise<T | null>>,
    key: string,
    read: () => Promise<T | null>,
): Promise<T | null> {
    let answer = kept.get(key);
    if (!answer) {
        answer = read();
        kept.set(key, answer);
        void answer.then((value) => {
            if (value === null && kept.get(key) === answer) kept.delete(key);
        });
    }
    return answer;
}

/** `read`, asked once and its answer kept; a null is asked again next time (see `memo`). */
export function lazily<T>(read: () => Promise<T | null>): () => Promise<T | null> {
    const kept = new Map<string, Promise<T | null>>();
    return () => memo(kept, '', read);
}

/** A file OmniDiff can say more about than its lines do: changed on both sides, and text. */
export function refinable(file: FileDiff): boolean {
    return (
        (file.status === 'modified' || file.status === 'renamed') &&
        !file.binary &&
        !file.image &&
        file.hunks.length > 0
    );
}

/** A side's bytes as text, or null when they are missing, too large, or not UTF-8 text. */
function refinableText(bytes: Uint8Array | null): string | null {
    if (!bytes || bytes.length > REFINE_MAX_BYTES || bytes.includes(0)) return null;
    try {
        // A byte order mark stays, as it does in git's first line.
        return new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
    } catch {
        return null;
    }
}
