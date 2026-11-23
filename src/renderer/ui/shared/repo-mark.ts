/**
 * A project's little coloured mark: its initial on a square in a colour of its
 * own, the same in every manager, so a repository is known at a glance.
 *
 * The colour follows from the project's short name alone, lower-cased, so
 * `JBlaak/switchboard` (Merge and Issue manager), a local project folder
 * `~/Development/switchboard` and a Bug manager group titled "switchboard"
 * all get the same one.
 *
 * Pure, so it is tested in node; `RepoMark` draws it.
 */

/** The colours a mark can take (`_repo-mark.scss` gives each a dark and a light shade). */
export const REPO_HUES = ['green', 'yellow', 'blue', 'purple', 'orange', 'red', 'teal', 'pink'] as const;

export type RepoHue = (typeof REPO_HUES)[number];

export interface RepoMarkFacts {
    /** "S" for switchboard; "?" for no name. */
    readonly initial: string;
    readonly hue: RepoHue;
}

/** "switchboard" for `JBlaak/switchboard`, `/Users/x/Development/switchboard/` or "Switchboard". */
export function repoKey(name: string): string {
    const parts = name.split(/[/\\]/).filter((part) => part.length > 0);
    return (parts[parts.length - 1] ?? '').trim().toLowerCase();
}

export function repoMark(name: string): RepoMarkFacts {
    const key = repoKey(name);
    const letter = key.match(/[\p{L}\p{N}]/u)?.[0];
    let hash = 0;
    for (const char of key) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
    return {initial: letter ? letter.toUpperCase() : '?', hue: REPO_HUES[hash % REPO_HUES.length]};
}
