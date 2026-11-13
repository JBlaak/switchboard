/**
 * A test rebase (#435): whether a PR's branch rebases cleanly onto its trunk,
 * found without pushing, checking out or touching any working tree, so a
 * waiting PR that will conflict is flagged without spending a CI run.
 */
export interface TestRebaseAnswer {
    readonly conflict: boolean;
    /** The files that conflict, when they could be named. */
    readonly files: readonly string[];
}

export interface TestRebase {
    /** Rebase `branch` onto `trunk` of `repository` (`owner/repo`) as a test; null when it could not be tried. */
    conflicts(repository: string, trunk: string, branch: string): Promise<TestRebaseAnswer | null>;
}
