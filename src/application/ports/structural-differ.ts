import type {FileRefinement} from '../../domain/session-work/refinement';

/**
 * Reads two versions of one file by their syntax (OmniDiff) and says which
 * parts of their lines changed. Null whenever it cannot: no differ bundled,
 * a timeout, a crash, output it does not understand. A null is never an
 * error to show; the diff is simply drawn by its lines.
 */
export interface StructuralDiffer {
    /**
     * `path` is the file's path in the repository: its extension picks the
     * language. `before` and `after` are the file's text on each side.
     */
    refine(path: string, before: string, after: string): Promise<FileRefinement | null>;
}

/** The differ when none is bundled (a dev checkout that did not fetch it). */
export const noStructuralDiffer: StructuralDiffer = {
    refine: () => Promise.resolve(null),
};
