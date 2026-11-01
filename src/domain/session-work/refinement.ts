/**
 * A finer reading of one file's diff, from OmniDiff (`omnidiff --mode json`).
 *
 * git's diff says which lines changed. OmniDiff parses both sides and says
 * which parts of them changed: the `* item.quantity` added to a line, the
 * `let` that became `const`, an expression that only moved. The page keeps
 * git's lines (they are what GitHub's comments anchor to) and paints these
 * marks inside the changed ones. A file with no refinement is drawn as before.
 */

/** What happened to a marked stretch of a line, in OmniDiff's words. */
export type ChangeKind = 'insert' | 'delete' | 'update' | 'move';

/**
 * One marked stretch of one line. Columns count UTF-16 code units in the
 * line's text as `DiffLine.text` holds it (no trailing newline): `start` up
 * to, not including, `end`.
 */
export interface ChangeMark {
    start: number;
    end: number;
    kind: ChangeKind;
    /** For a move: the 1-based line on the other side it moved from or to. */
    otherLine?: number;
}

/** The file's overall shape, when OmniDiff names one. */
export type RefinementSummary =
    | 'no_changes'
    | 'new_file'
    | 'deleted_file'
    | 'whitespace_only'
    | 'comment_only'
    | 'refactor_moved_only';

export interface FileRefinement {
    summary: RefinementSummary | null;
    /** Marks by 1-based line number in the old file, each line's in column order. */
    before: Record<number, ChangeMark[]>;
    /** Marks by 1-based line number in the new file, each line's in column order. */
    after: Record<number, ChangeMark[]>;
}
