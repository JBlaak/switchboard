/**
 * The host instructions a VM starts with (#276, Q25).
 *
 * Every Claude launch on the host gets them appended to its system prompt,
 * after the project's own appended prompt. The user edits them per host
 * afterwards; this is only what an install fills in.
 */

/** The text an install fills in; the sudo sentence only when setup confirmed sudo works. */
export function defaultHostInstructions({sudo}: {sudo: boolean}): string {
    return [
        "You're running on a self-contained Linux VM dedicated to this work.",
        sudo
            ? 'You may install any packages, SDKs or tools you need (sudo is available), run long builds, and use the network.'
            : 'You may install any packages, SDKs or tools you need in your home folder, run long builds, and use the network.',
        "Nobody is watching this machine's screen; ask in the session when you need a decision.",
        'Push branches and open pull requests as usual.',
        "Never assume files from the user's Mac exist here.",
    ].join(' ');
}

/** The settings a host has before anything was saved: no sudo assumed, config copy on. */
export const DEFAULT_BASE_FOLDER = '~/projects';

/**
 * What a launch's `--append-system-prompt` becomes on a host: the project's own
 * text, then the host's, separated by a blank line. Either may be empty.
 */
export function withHostInstructions(projectPrompt: string | undefined, hostInstructions: string): string | undefined {
    const parts = [projectPrompt?.trim(), hostInstructions.trim()].filter((part): part is string => !!part);
    return parts.length ? parts.join('\n\n') : undefined;
}
