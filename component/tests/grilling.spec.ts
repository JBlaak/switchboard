/**
 * The grilling card: a round of questions Claude writes out at the end of a
 * turn, answered on the card.
 *
 * Main's side is the real thing, run in the test: a GrillService and a
 * QuestionService (src/application/services) behind the card's calls
 * (`grillViews`, `grillAnswer`, `grillAsk`, `grillSend`, …), whose
 * `grillChanged`, `questionsAsked` and `questionsSettled` reach the page as
 * `onGrillChanged`, `onQuestionsAsked` and `onQuestionsSettled`. The test
 * plays the hook server: it hands the services each ended turn and each
 * prompt that goes in, as the Stop and UserPromptSubmit hooks would, and
 * reads what the service typed into the session from its prompter.
 *
 * The hook round trip and what reaches the real terminal stay in
 * e2e/tests/grilling.spec.ts. What the card decides on its own is unit
 * tested: parsing the round (test/grill-round.test.ts,
 * test/grill-choices.test.ts), carrying answers across revisions
 * (test/grill-answering.test.ts), the service (test/grill-service.test.ts),
 * and the card's keys, banner and labels (test/grill-*.test.ts).
 */
import crypto from 'node:crypto';
import {test, expect} from '../support/test';
import {sidebar} from '../../e2e/support/app';
import {LABEL, S} from '../../e2e/fixtures/standard';
import {FIXTURE_NOW} from '../../e2e/support/fixture-home';
import {openSession} from '../support/running-session';
import {ActiveSession} from '../../src/application/model/active-session';
import {SessionRegistry} from '../../src/application/model/session-registry';
import {GrillService} from '../../src/application/services/grill-service';
import {QuestionService} from '../../src/application/services/question-service';
import {endedTurn} from '../../src/domain/grill/hook-input';
import {fakePty, fakeRenderer, silentLog} from '../../test/support/fakes';
import type {Page} from '@playwright/test';
import type {FakeApi} from '../support/fake-api';

/** A grilling round, as the grilling skill ends a turn with it. */
const ROUND = [
    'Settled: the cookie stays httpOnly.',
    '',
    '❓ **Q1** - **Keep the old login route?**: Two clients still call it.',
    '',
    '➡️ Keep it for one more release.',
    '',
    '---',
    '',
    '❓ **Q2** - **Where do sessions live?**: Pick a store: (a) SQLite, one file; (b) Redis, shared but needs a server.',
    '',
    '➡️ (a) SQLite.',
].join('\n');

/** The same round once Claude has revised its second question. */
const REVISED = ROUND.replace('➡️ (a) SQLite.', '➡️ (b) Redis: the load balancer needs shared sessions.');

function card(page: Page) {
    return page.getByRole('region', {name: 'Grilling round from Claude'});
}

function title(page: Page, name: string) {
    return card(page).getByRole('heading', {name});
}

/** Main's grilling side for one running session, with the hooks the test fires by hand. */
interface GrillMain {
    /** The turn ended on `lastMessage`, as the Stop hook reports it (no transcript to read). */
    endTurn(lastMessage: string): Promise<void>;
    /** A prompt went in, as the UserPromptSubmit hook reports it. */
    submitPrompt(prompt: string): Promise<void>;
    /** Every prompt the service typed into the session, in order. */
    typed: string[];
}

/**
 * Put the real GrillService and QuestionService behind the card's calls, for
 * `sessionId` running at its prompt. What they send the renderer is emitted to
 * the page in order; each hook resolves once its events are there.
 */
function grillMain(api: FakeApi, sessionId: string): GrillMain {
    let emitted = Promise.resolve();
    const send = (emit: () => Promise<void>): void => {
        emitted = emitted.then(emit);
    };
    const renderer = {
        ...fakeRenderer(),
        questionsAsked: (pending) => send(() => api.emit('onQuestionsAsked', pending)),
        questionsSettled: (settled) => send(() => api.emit('onQuestionsSettled', settled)),
        grillChanged: (changed) => send(() => api.emit('onGrillChanged', changed)),
    } satisfies ReturnType<typeof fakeRenderer>;
    const typed: string[] = [];
    const prompter = {
        isBusy: () => false,
        send: (_id: string, prompt: string) => void typed.push(prompt),
        onIdle: () => ({dispose() {}}),
        onExit: () => ({dispose() {}}),
    };
    const registry = new SessionRegistry();
    const questions = new QuestionService({
        registry,
        renderer,
        endpoint: {url: null, token: 'component'},
        clock: {now: () => FIXTURE_NOW},
        log: silentLog,
    });
    const grill = new GrillService({registry, renderer, prompter, questions, log: silentLog});
    registry.add(
        sessionId,
        new ActiveSession({
            pty: fakePty(),
            projectPath: '/repo',
            projectFolder: '-repo',
            knownTranscriptIds: new Set(),
            sessionSlug: null,
            isPlainTerminal: false,
            remote: null,
            openedAt: FIXTURE_NOW,
        }),
    );

    const settled = async <T>(result: T): Promise<T> => {
        await emitted;
        return result;
    };
    api.handle('getPendingQuestions', () => questions.pending());
    api.handle('answerQuestions', (id, toolUseId, answers) => settled(questions.answer(id, toolUseId, answers)));
    api.handle('grillViews', () => grill.views());
    api.handle('grillAnswer', (id, roundId, revision, place, answer) =>
        settled(grill.answer(id, roundId, revision, place, answer)),
    );
    api.handle('grillAsk', (id, roundId, revision, place, text) =>
        settled(grill.ask(id, roundId, revision, place, text)),
    );
    api.handle('grillSend', (id, roundId) => settled(grill.send(id, roundId)));
    api.handle('grillQueue', (id, roundId) => settled(grill.queue(id, roundId)));
    api.handle('grillCancelQueue', (id, roundId) => settled(grill.cancelQueue(id, roundId)));

    const hash = (text: string) => crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
    return {
        typed,
        endTurn: async (lastMessage) => {
            grill.turnEnded(sessionId, endedTurn(null, lastMessage, hash), null);
            await emitted;
        },
        submitPrompt: async (prompt) => {
            grill.promptSubmitted(sessionId, prompt);
            await emitted;
        },
    };
}

// Answered for the session tray, which the bar above the terminal opens on hover.

test.describe('grilling', () => {
    test('a prompt typed in the terminal takes the round away', async ({page, api}) => {
        /* Given */
        const main = grillMain(api, S.loginFix);
        await openSession(page, api, LABEL.loginFix, S.loginFix);
        await main.endTurn(ROUND);
        await expect(title(page, 'Keep the old login route?')).toBeVisible();

        /* When */
        await main.submitPrompt('Q1: yes');

        /* Then */
        await expect(card(page)).toHaveCount(0);
        await expect(sidebar(page).getByText('Asking 2 questions', {exact: true})).toHaveCount(0);
    });

    test('a revision keeps the unchanged answer and sets the changed one aside', async ({page, api}) => {
        /* Given */
        const main = grillMain(api, S.loginFix);
        await openSession(page, api, LABEL.loginFix, S.loginFix);
        await main.endTurn(ROUND);
        await expect(title(page, 'Keep the old login route?')).toBeVisible();
        await page.keyboard.press('y');
        await page.keyboard.press('y');
        await expect(card(page).getByRole('heading', {name: 'Review your answers'})).toBeVisible();

        /* When */
        await main.endTurn(REVISED);

        /* Then */
        await expect(card(page).getByText('Claude revised the round: 1 changed.')).toBeVisible();
        await expect(card(page).getByText('Changed, earlier answer set aside')).toBeVisible();
        await expect(card(page).getByText('Q1: yes', {exact: true})).toBeVisible();
    });

    test('asking about a question keeps the round open and shows the answer on it', async ({page, api}) => {
        /* Given */
        const main = grillMain(api, S.loginFix);
        await openSession(page, api, LABEL.loginFix, S.loginFix);
        await main.endTurn(ROUND);
        await expect(title(page, 'Keep the old login route?')).toBeVisible();

        /* When */
        await page.keyboard.press('?');
        await page.keyboard.type('Which two clients?');
        await page.keyboard.press('Enter');

        /* Then */
        const ask = 'Before I answer the round, about Q1: Which two clients?';
        await expect.poll(() => main.typed).toEqual([ask]);

        /* When */
        await main.submitPrompt(ask);
        await main.endTurn('The iOS app and the partner dashboard.');

        /* Then */
        await expect(card(page).getByText('The iOS app and the partner dashboard.')).toBeVisible();
        await expect(title(page, 'Keep the old login route?')).toBeVisible();
        await expect(sidebar(page).getByText('Asking 2 questions', {exact: true})).toBeVisible();
    });
});
