/**
 * Saved prompts from the renderer (#339): reading and writing the stored
 * lists, and typing one into a session.
 *
 * The session tray (#343) loads a session's prompts with `loadSavedPrompts`
 * and sends one with `sendSavedPrompt`; the Settings editor (#344) edits the
 * stored lists with `window.api.savedPrompts` / `setSavedPrompts` directly.
 * The rules (order, ⌘ keys, placeholders) are in `domain/settings/saved-prompts`.
 */
import {SUBMIT_DELAY_MS} from '../../../domain/terminal/paste';
import {resolveSavedPrompts, savedPromptInput} from '../../../domain/settings/saved-prompts';
import type {ResolvedSavedPrompt, SavedPrompt, SavedPromptFacts} from '../../../domain/settings/saved-prompts';
import {getState} from '../../state/app-store';
import {deviceOwnerIn} from '../../state/phone-access-slice';

/** What sending needs from the world, so it can be tested without a window. */
export interface SendSavedPromptSteps {
    /** Write to the session's pty. */
    write(sessionId: string, data: string): void;
    /** Run `fn` after `ms`. */
    later(fn: () => void, ms: number): void;
    /** Whether this window has the session's terminal (a paired phone may have it, #194). */
    hasTerminal(sessionId: string): boolean;
}

const windowSteps: SendSavedPromptSteps = {
    write: (sessionId, data) => window.api.sendInput(sessionId, data),
    later: (fn, ms) => void setTimeout(fn, ms),
    hasTerminal: (sessionId) => deviceOwnerIn(getState().phoneAccess, sessionId) === null,
};

/**
 * The prompts a session's tray offers, in order with their ⌘ keys: the global
 * ones, then its project's.
 */
export async function loadSavedPrompts(projectPath: string | null): Promise<ResolvedSavedPrompt[]> {
    const lists = await window.api.savedPrompts(projectPath);
    return resolveSavedPrompts(lists.global, lists.project);
}

/**
 * Type a saved prompt into a session, its placeholders filled from `facts`,
 * and press Enter after it for a `send` prompt; an `input` prompt is left in
 * the input box. False when nothing was typed: the prompt filled to nothing,
 * or a phone has the session's terminal.
 */
export function sendSavedPrompt(sessionId: string, prompt: SavedPrompt, facts: SavedPromptFacts): boolean {
    return sendSavedPromptWith(windowSteps, sessionId, prompt, facts);
}

/** `sendSavedPrompt` against given steps. */
export function sendSavedPromptWith(
    steps: SendSavedPromptSteps,
    sessionId: string,
    prompt: SavedPrompt,
    facts: SavedPromptFacts,
): boolean {
    if (!steps.hasTerminal(sessionId)) return false;
    const input = savedPromptInput(prompt, facts);
    if (!input) return false;
    steps.write(sessionId, input.paste);
    if (input.submit) {
        // After the paste has landed, as the session prompter does: see `domain/terminal/paste`.
        steps.later(() => {
            if (steps.hasTerminal(sessionId)) steps.write(sessionId, '\r');
        }, SUBMIT_DELAY_MS);
    }
    return true;
}
