/**
 * Saved prompts (#339): requests typed into a session again and again ("where
 * are we?", "commit and open a PR"), sent from the session tray (#338) with a
 * click or ⌘1–9.
 *
 * A prompt is global or belongs to one project. Both lists are stored as
 * `savedPrompts` in their settings blob (`global`, `project:<path>`), and are
 * read and written through the `savedPrompts` / `setSavedPrompts` channels, so
 * nothing else needs to know where they live.
 *
 * Here: the model, reading a stored list, the order the tray shows them in
 * (global first, then the project's, the first nine on ⌘1–9), filling in the
 * session's `{branch}`, `{project}`, `{task}` and `{pr}`, and what gets typed.
 */
import {pasteBytes} from '../terminal/paste';

/**
 * What a prompt does once typed: `send` presses Enter after it, `input`
 * leaves it in the session's input box to finish by hand.
 */
export type SavedPromptMode = 'send' | 'input';

/** One saved prompt, as stored. */
export interface SavedPrompt {
    /** Stable, unique within its list; the editor makes one (`crypto.randomUUID()`). */
    readonly id: string;
    /** What the tray's row says. */
    readonly label: string;
    /** What is typed, with placeholders: `{branch}`, `{project}`, `{task}`, `{pr}`. */
    readonly text: string;
    readonly mode: SavedPromptMode;
}

/** Where a prompt is stored: everywhere, or one project. */
export type SavedPromptScope = 'global' | 'project';

/** Both stored lists for one project, as the Settings editor edits them. */
export interface SavedPromptLists {
    readonly global: readonly SavedPrompt[];
    /** Empty when asked without a project. */
    readonly project: readonly SavedPrompt[];
}

/** A prompt as the tray offers it: in order, with its scope and its ⌘ key. */
export interface ResolvedSavedPrompt extends SavedPrompt {
    readonly scope: SavedPromptScope;
    /** 1–9 for the first nine (⌘1–⌘9), null after that. */
    readonly key: number | null;
}

/**
 * What a session knows that a prompt can fill in. Each is the text typed in
 * the placeholder's place; the caller formats it (a PR as its URL or `#12`,
 * a task as its title). Absent, null or blank, the placeholder is left out.
 */
export interface SavedPromptFacts {
    readonly branch?: string | null;
    readonly project?: string | null;
    readonly task?: string | null;
    readonly pr?: string | null;
}

/** The placeholders a prompt can use, in the order the editor lists them. */
export const SAVED_PROMPT_PLACEHOLDERS = ['branch', 'project', 'task', 'pr'] as const;

/** How many prompts get a ⌘ key. */
export const SAVED_PROMPT_KEYS = 9;

/** The settings key both blobs store their list under. */
export const SAVED_PROMPTS_SETTING = 'savedPrompts';

/**
 * A stored list, as far as it can be read.
 *
 * The blob is JSON a newer or older build, or a hand edit, may have written,
 * so an entry without an id or text is skipped, an unknown mode is `send`,
 * and a blank label falls back to the text's first line.
 */
export function parseSavedPrompts(value: unknown): SavedPrompt[] {
    if (!Array.isArray(value)) return [];
    const prompts: SavedPrompt[] = [];
    for (const entry of value) {
        if (!entry || typeof entry !== 'object') continue;
        const {id, label, text, mode} = entry as Record<string, unknown>;
        if (typeof id !== 'string' || id === '' || typeof text !== 'string') continue;
        const ownLabel = typeof label === 'string' ? label.trim() : '';
        prompts.push({
            id,
            label: ownLabel || firstLine(text),
            text,
            mode: mode === 'input' ? 'input' : 'send',
        });
    }
    return prompts;
}

/** The order the tray shows: global first, then the project's; the first nine get ⌘1–9. */
export function resolveSavedPrompts(
    global: readonly SavedPrompt[],
    project: readonly SavedPrompt[],
): ResolvedSavedPrompt[] {
    const scoped = [
        ...global.map((prompt) => ({...prompt, scope: 'global' as const})),
        ...project.map((prompt) => ({...prompt, scope: 'project' as const})),
    ];
    return scoped.map((prompt, index) => ({...prompt, key: index < SAVED_PROMPT_KEYS ? index + 1 : null}));
}

/** The prompt ⌘`key` sends, if any. */
export function savedPromptForKey(prompts: readonly ResolvedSavedPrompt[], key: number): ResolvedSavedPrompt | null {
    return prompts.find((prompt) => prompt.key === key) ?? null;
}

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_-]*)\}/g;

/** Stands in for a dropped placeholder until the space around it is tidied. */
const DROPPED = '\uE000';

/**
 * The prompt's text with the session's facts filled in.
 *
 * A placeholder with no value, or one this build does not know, is left out
 * with the space it leaves: no stray braces, no double space, no space before
 * a comma, and a line that held nothing but placeholders goes altogether.
 * Placeholder names are case-insensitive; text in braces that is not a
 * placeholder name (`{"a": 1}`) is kept as written.
 */
export function fillSavedPrompt(text: string, facts: SavedPromptFacts): string {
    const marked = text
        .split(DROPPED)
        .join('')
        .replace(PLACEHOLDER, (_match, name: string) => {
            const value = factFor(name.toLowerCase(), facts);
            return value ?? DROPPED;
        });
    if (!marked.includes(DROPPED)) return marked;
    return marked
        .split('\n')
        .filter((line) => !/^[ \t]*\uE000[ \t\uE000]*$/.test(line))
        .map(tidyLine)
        .join('\n');
}

/**
 * What typing a prompt into a session's terminal writes: the filled text as a
 * bracketed paste, and whether Enter follows it (`send`). Null when nothing is
 * left to type.
 */
export function savedPromptInput(
    prompt: SavedPrompt,
    facts: SavedPromptFacts,
): {paste: string; submit: boolean} | null {
    const text = fillSavedPrompt(prompt.text, facts).trim();
    if (text === '') return null;
    return {paste: pasteBytes(text), submit: prompt.mode === 'send'};
}

function factFor(name: string, facts: SavedPromptFacts): string | null {
    if (!(SAVED_PROMPT_PLACEHOLDERS as readonly string[]).includes(name)) return null;
    const value = facts[name as keyof SavedPromptFacts];
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
}

/** One line with its dropped placeholders taken out, and the space around them with them. */
function tidyLine(line: string): string {
    return line.replace(/([ \t]*)\uE000[ \t\uE000]*/g, (run: string, leading: string, offset: number) => {
        const before = line.slice(0, offset);
        const after = line.slice(offset + run.length);
        if (before === '' || before.trim() === '') return leading;
        if (after === '' || /^[,.;:!?)\]]/.test(after)) return '';
        if (/[([]$/.test(before)) return '';
        return /[ \t]/.test(run) ? ' ' : '';
    });
}

function firstLine(text: string): string {
    return text.trim().split('\n')[0]!.trim();
}
