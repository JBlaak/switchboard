/**
 * A project's settings for the managers on the empty screen (#409, #412).
 *
 * - **Watch issues**: the Issue manager watches the project's loose GitHub
 *   issues. Off unless switched on.
 * - **Releases are tagged**: whether the project tags its releases, which
 *   the Bug manager's "seen again after the merge" judgement needs. Detected
 *   from the repository (any tag in the last 90 days) unless the project
 *   says otherwise; a stored true or false overrides the detection.
 *
 * Both live in the project's settings blob next to its launch overrides,
 * under keys of their own. Neither is a launch setting, so neither has a
 * global default and "Reset to global settings" leaves them alone.
 */

type Blob = Readonly<Record<string, unknown>> | null | undefined;

export const WATCH_ISSUES_KEY = 'watchIssues';
export const RELEASES_TAGGED_KEY = 'releasesTagged';

/** How far back a tag still counts as the project tagging its releases. */
export const RELEASE_TAG_WINDOW_DAYS = 90;

/** Whether the Issue manager watches the project. */
export function resolveWatchIssues(project: Blob): boolean {
    return project?.[WATCH_ISSUES_KEY] === true;
}

/** The project's own say on Releases are tagged; null when it follows the detection. */
export function releasesTaggedOverride(project: Blob): boolean | null {
    const stored = project?.[RELEASES_TAGGED_KEY];
    return typeof stored === 'boolean' ? stored : null;
}

/**
 * Whether the project's releases are tagged: its override, else what was
 * detected. Not known (no GitHub, `gh` could not be asked) counts as not
 * tagged, which makes the Bug manager ask rather than judge.
 */
export function resolveReleasesTagged(project: Blob, detected: boolean | null): boolean {
    return releasesTaggedOverride(project) ?? detected === true;
}

/** The project's blob with Watch issues on or off; off drops the key. */
export function withWatchIssues(project: Blob, on: boolean): Record<string, unknown> {
    const next: Record<string, unknown> = {...(project ?? {})};
    if (on) next[WATCH_ISSUES_KEY] = true;
    else delete next[WATCH_ISSUES_KEY];
    return next;
}

/** The project's blob with Releases are tagged set to yes, no, or back to detected (null). */
export function withReleasesTagged(project: Blob, value: boolean | null): Record<string, unknown> {
    const next: Record<string, unknown> = {...(project ?? {})};
    if (value === null) delete next[RELEASES_TAGGED_KEY];
    else next[RELEASES_TAGGED_KEY] = value;
    return next;
}

/** Whether a tag made at `latestTagAt` (ISO) means the project tags its releases, at `now`. */
export function taggedRecently(latestTagAt: string | null, now: number): boolean {
    if (!latestTagAt) return false;
    const at = Date.parse(latestTagAt);
    return Number.isFinite(at) && now - at <= RELEASE_TAG_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}
