/**
 * What the question panel's actions do with main's reply when the answers go:
 * a set main had already withdrawn settles without Patch's send-off; a real
 * answer gets it. Main's side (a withdrawn set answers `ok: false`) is in
 * test/question-service.test.ts.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dispatch, onEvent} from '../src/renderer/state/app-store';
import {answer} from '../src/renderer/ui/questions/actions';
import type {PendingQuestions, QuestionsSettled} from '../src/domain/questions/question';

/** A main whose `answerQuestions` answers `reply`, recording each call. */
function installMain(reply: unknown): {answered: unknown[][]} {
    const answered: unknown[][] = [];
    const api = {
        answerQuestions: async (...args: unknown[]) => {
            answered.push(args);
            return reply;
        },
    };
    Object.assign(globalThis, {window: {api}});
    return {answered};
}

function asked(sessionId: string, toolUseId: string): PendingQuestions {
    return {
        sessionId,
        toolUseId,
        source: 'ask',
        questions: [
            {
                question: 'Scope?',
                header: 'Scope',
                multiSelect: false,
                options: [
                    {label: 'Site', description: ''},
                    {label: 'App', description: ''},
                ],
            },
        ],
        askedAt: 0,
        deadline: 600_000,
    };
}

/** Pick the first option and send; resolves with how the set settled and whether Patch said goodbye. */
async function pickAndSend(toolUseId: string): Promise<{settled: QuestionsSettled; delivered: boolean}> {
    let delivered = false;
    const stopDelivered = onEvent('answersDelivered', (event) => {
        if (event.toolUseId === toolUseId) delivered = true;
    });
    const settled = new Promise<QuestionsSettled>((resolve) => {
        const stop = onEvent('questionsSettled', (event) => {
            if (event.settled.toolUseId !== toolUseId) return;
            stop();
            resolve(event.settled);
        });
    });
    answer(toolUseId, {kind: 'press', row: 0});
    answer(toolUseId, {kind: 'next'});
    const outcome = await settled;
    // The send-off, if any, is dispatched in the same task as the settle.
    await new Promise((resolve) => setImmediate(resolve));
    stopDelivered();
    return {settled: outcome, delivered};
}

test('a set main has already withdrawn settles without a farewell', async () => {
    /* Given */
    const main = installMain({ok: false, error: 'not pending'});
    dispatch({type: 'questionsAsked', pending: asked('s-withdrawn', 't-withdrawn')});
    const warn = console.warn;
    console.warn = () => {};

    /* When */
    const sent = await pickAndSend('t-withdrawn').finally(() => (console.warn = warn));

    /* Then */
    assert.equal(main.answered.length, 1);
    assert.equal(sent.settled.outcome, 'withdrawn');
    assert.equal(sent.delivered, false);
});

test('an answered set settles with a farewell', async () => {
    /* Given */
    installMain({ok: true});
    dispatch({type: 'questionsAsked', pending: asked('s-answered', 't-answered')});

    /* When */
    const sent = await pickAndSend('t-answered');

    /* Then */
    assert.equal(sent.settled.outcome, 'answered');
    assert.equal(sent.delivered, true);
});
