/**
 * Asking a running session's questions, the way Claude's hook does.
 *
 * Each Claude session is launched with `--settings` holding a PreToolUse
 * `http` hook: a URL on the app's loopback server and the per-run token header
 * (src/domain/questions/question.ts). The fake `claude` records that argument,
 * so the test reads the hook from the launch and posts to it itself — exactly
 * the request the real CLI would make, held open until the user answers in
 * the question panel or the request is abandoned.
 */
import {fakeClaude} from './fake-cli';
import type {Locator, Page} from '@playwright/test';
import type {FixtureHome} from './fixture-home';
import type {HttpHook} from './fake-cli';

export interface QuestionOption {
    label: string;
    description?: string;
}

export interface AskedQuestion {
    question: string;
    /** A chip-sized label, 12 characters at most. */
    header?: string;
    options: QuestionOption[];
    multiSelect?: boolean;
}

export interface PendingAsk {
    /** The hook's reply: `{}` for no decision, or the answers in `updatedInput`. */
    response: Promise<Record<string, unknown>>;
    /** Drop the request, as the CLI does when it gives up or is interrupted. */
    abandon(): void;
    toolUseId: string;
}

/**
 * Post an AskUserQuestion to the session's hook and return without waiting
 * for the answer.
 *
 * The session must be running under the fake `claude` (it is the launch that
 * carries the hook's address).
 */
export async function askQuestions(
    home: FixtureHome,
    sessionId: string,
    questions: AskedQuestion[],
    {toolUseId = 'toolu_e2e_' + Math.random().toString(36).slice(2, 10)} = {},
): Promise<PendingAsk> {
    const launch = await fakeClaude(home, sessionId).launched();
    const hook = launch.settings?.hooks?.PreToolUse?.find((h) => h.matcher === 'AskUserQuestion')?.hooks[0];
    if (!hook) throw new Error(`session ${sessionId} was launched without a question hook`);

    const controller = new AbortController();
    const response = fetch(hook.url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', ...hook.headers},
        body: JSON.stringify({
            session_id: sessionId,
            hook_event_name: 'PreToolUse',
            tool_name: 'AskUserQuestion',
            tool_use_id: toolUseId,
            tool_input: {questions},
        }),
        signal: controller.signal,
    }).then(async (res) => {
        if (!res.ok) throw new Error(`question hook answered ${res.status}`);
        return (await res.json()) as Record<string, unknown>;
    });
    // An abandoned request rejects; that is the point of abandoning it.
    response.catch(() => {});

    return {response, abandon: () => controller.abort(), toolUseId};
}

/**
 * End the session's turn with `lastMessage`, as the CLI's Stop hook does; a
 * grilling round in it comes up as questions. Resolves once main has replied,
 * which it does at once.
 */
export async function endTurn(home: FixtureHome, sessionId: string, lastMessage: string): Promise<void> {
    const hook = await noticeHook(home, sessionId, 'Stop');
    await postHook(hook, {
        session_id: sessionId,
        hook_event_name: 'Stop',
        stop_hook_active: false,
        last_assistant_message: lastMessage,
    });
}

/** A prompt went in, as the CLI's UserPromptSubmit hook reports it. */
export async function submitPrompt(home: FixtureHome, sessionId: string, prompt: string): Promise<void> {
    const hook = await noticeHook(home, sessionId, 'UserPromptSubmit');
    await postHook(hook, {session_id: sessionId, hook_event_name: 'UserPromptSubmit', prompt});
}

async function noticeHook(home: FixtureHome, sessionId: string, event: 'Stop' | 'UserPromptSubmit'): Promise<HttpHook> {
    const launch = await fakeClaude(home, sessionId).launched();
    const hook = launch.settings?.hooks?.[event]?.[0]?.hooks[0];
    if (!hook) throw new Error(`session ${sessionId} was launched without a ${event} hook`);
    return hook;
}

async function postHook(hook: HttpHook, body: Record<string, unknown>): Promise<void> {
    const res = await fetch(hook.url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', ...hook.headers},
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`hook answered ${res.status}`);
}

/**
 * The question sheet, by its label. It is a `<section>` with an accessible
 * name, so it is a region while it is up — and out of the accessibility tree
 * (aria-hidden) while it is not, which makes this locator miss it then.
 */
export function questionPanel(page: Page): Locator {
    return page.getByRole('region', {name: 'Questions from Claude'});
}

/**
 * The sheet whether or not it is up, for asserting on how it hides itself.
 * Found by its label attribute, since the role is gone while it is hidden.
 */
export function questionSheet(page: Page): Locator {
    return page.locator('[aria-label="Questions from Claude"]');
}

/** An option on the question on screen, by (part of) its label. */
export function option(page: Page, label: string | RegExp): Locator {
    return questionPanel(page).getByRole('button', {name: label});
}

/** Where the keyboard is: in the question sheet, in a terminal, or elsewhere. */
export async function focusIsIn(page: Page): Promise<'panel' | 'terminal' | 'other'> {
    return await page.evaluate(() => {
        const active = document.activeElement;
        if (active?.closest('[aria-label="Questions from Claude"]')) return 'panel';
        if (active?.classList.contains('xterm-helper-textarea')) return 'terminal';
        return 'other';
    });
}
