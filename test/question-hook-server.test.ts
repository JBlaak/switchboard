import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {ActiveSession} from '../src/application/model/active-session';
import {SessionRegistry} from '../src/application/model/session-registry';
import {QuestionService} from '../src/application/services/question-service';
import {legacyGrillReceiver} from '../src/application/services/legacy-grill-receiver';
import {QUESTION_HOOK_TOKEN_HEADER} from '../src/domain/questions/question';
import {QuestionHookServer} from '../src/infrastructure/http/question-hook-server';
import {NodeFileSystem} from '../src/infrastructure/fs/node-file-system';
import {FileTranscriptTail} from '../src/infrastructure/fs/transcript-tail-file';
import type {TranscriptTail} from '../src/application/ports/transcript-tail';
import type {EndedTurn} from '../src/domain/grill/model';
import {fakePty, fakeRenderer, silentLog} from './support/fakes';

/**
 * The hook server against real sockets: it has to turn away strangers, hold a
 * genuine question open until the service answers it, and notice when the CLI
 * gives up on the request.
 */

async function harness() {
    const registry = new SessionRegistry();
    const renderer = fakeRenderer();
    const server = new QuestionHookServer({
        receiver: legacyGrillReceiver(() => service),
        log: silentLog,
    });
    const sent: Array<[string, string]> = [];
    const prompter = {
        send: (sessionId: string, prompt: string) => {
            sent.push([sessionId, prompt]);
        },
        onExit: () => ({dispose() {}}),
    };
    const service = new QuestionService({
        registry,
        renderer,
        endpoint: server,
        prompter,
        log: silentLog,
        clock: {now: () => 0},
    });
    await server.start();

    registry.add(
        's1',
        new ActiveSession({
            pty: fakePty(),
            projectPath: '/repo',
            projectFolder: '-repo',
            knownTranscriptIds: new Set(),
            sessionSlug: null,
            isPlainTerminal: false,
            remote: null,
            openedAt: 0,
        }),
    );

    return {server, service, renderer, sent};
}

const hookBody = {
    session_id: 'claude-id',
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_use_id: 'tu-1',
    tool_input: {
        questions: [
            {
                question: 'Which database?',
                header: 'DB',
                options: [
                    {label: 'SQLite', description: 'small'},
                    {label: 'Postgres', description: 'big'},
                ],
                multiSelect: false,
            },
        ],
    },
};

function post(url: string, body: string, headers: Record<string, string> = {}) {
    return fetch(url, {method: 'POST', body, headers: {'Content-Type': 'application/json', ...headers}});
}

/** Resolves once `predicate` holds, polling briefly. */
async function until(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !predicate(); i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(predicate(), 'condition never became true');
}

test('the endpoint is only known once listening, and forgotten on stop', async () => {
    /* Given */
    const server = new QuestionHookServer({
        receiver: {
            receive: () => ({withdraw() {}}),
            turnEnded: () => {},
            promptSubmitted: () => {},
            subagentChanged: () => {},
        },
        log: silentLog,
    });

    /* Then */
    assert.equal(server.url, null);

    /* When */
    await server.start();

    /* Then */
    assert.match(server.url ?? '', /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(server.token.length, 64);

    /* When */
    server.stop();

    /* Then */
    assert.equal(server.url, null);
});

test('a request without a token is refused', async (t) => {
    /* Given */
    const h = await harness();
    t.after(() => h.server.stop());

    /* When */
    const res = await post(`${h.server.url}/ask/s1`, JSON.stringify(hookBody));

    /* Then */
    assert.equal(res.status, 401);
    assert.deepEqual(h.renderer.events, []);
});

test('a request with the wrong token is refused', async (t) => {
    /* Given */
    const h = await harness();
    t.after(() => h.server.stop());

    /* When */
    const wrong = await post(`${h.server.url}/ask/s1`, JSON.stringify(hookBody), {
        [QUESTION_HOOK_TOKEN_HEADER]: 'nope',
    });

    /* Then */
    assert.equal(wrong.status, 401);
    assert.deepEqual(h.renderer.events, []);
});

test('other paths and methods are not found', async (t) => {
    /* Given */
    const h = await harness();
    t.after(() => h.server.stop());
    const auth = {[QUESTION_HOOK_TOKEN_HEADER]: h.server.token};

    /* When */
    const other = await post(`${h.server.url}/other`, '{}', auth);
    const noSession = await post(`${h.server.url}/ask/`, '{}', auth);
    const get = await fetch(`${h.server.url}/ask/s1`, {headers: auth});

    /* Then */
    assert.equal(other.status, 404);
    assert.equal(noSession.status, 404);
    assert.equal(get.status, 404);
});

test('junk gets an empty decision', async (t) => {
    /* Given */
    const h = await harness();
    t.after(() => h.server.stop());
    // Header names are case-insensitive.
    const auth = {[QUESTION_HOOK_TOKEN_HEADER.toLowerCase()]: h.server.token};

    /* When */
    const junk = await post(`${h.server.url}/ask/s1`, 'not json', auth);

    /* Then */
    assert.equal(junk.status, 200);
    assert.deepEqual(await junk.json(), {});
    assert.deepEqual(h.renderer.events, []);
});

test('other tools get an empty decision', async (t) => {
    /* Given */
    const h = await harness();
    t.after(() => h.server.stop());
    // Header names are case-insensitive.
    const auth = {[QUESTION_HOOK_TOKEN_HEADER.toLowerCase()]: h.server.token};

    /* When */
    const bash = await post(`${h.server.url}/ask/s1`, JSON.stringify({...hookBody, tool_name: 'Bash'}), auth);

    /* Then */
    assert.deepEqual(await bash.json(), {});
    assert.deepEqual(h.renderer.events, []);
});

test('an oversized body is rejected', async (t) => {
    /* Given */
    const h = await harness();
    t.after(() => h.server.stop());

    /* When */
    const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
            `${h.server.url}/ask/s1`,
            {
                method: 'POST',
                headers: {[QUESTION_HOOK_TOKEN_HEADER]: h.server.token},
            },
            (res) => {
                res.resume();
                resolve(res.statusCode ?? 0);
            },
        );
        req.on('error', reject);
        req.end(Buffer.alloc(1024 * 1024 + 1, 'x'));
    });

    /* Then */
    assert.equal(status, 413);
});

test('a question is held until it is answered in Switchboard', async (t) => {
    /* Given */
    const h = await harness();
    t.after(() => h.server.stop());

    /* When */
    const response = post(`${h.server.url}/ask/s1`, JSON.stringify(hookBody), {
        [QUESTION_HOOK_TOKEN_HEADER]: h.server.token,
    });

    /* Then */
    await until(() => h.service.pending().length === 1);
    assert.equal(h.renderer.only('questionsAsked').length, 1);

    /* When */
    const answered = h.service.answer('s1', 'tu-1', {'Which database?': 'SQLite'});

    /* Then */
    assert.deepEqual(answered, {ok: true});
    const res = await response;
    assert.equal(res.status, 200);
    const json = (await res.json()) as {
        hookSpecificOutput: {permissionDecision: string; updatedInput: {answers: unknown}};
    };
    assert.equal(json.hookSpecificOutput.permissionDecision, 'allow');
    assert.deepEqual(json.hookSpecificOutput.updatedInput.answers, {'Which database?': 'SQLite'});
    assert.deepEqual(
        h.renderer.only('questionsSettled').map((e) => (e[1] as {outcome: string}).outcome),
        ['answered'],
    );
});

test('a question for an unknown session gets an empty decision', async (t) => {
    /* Given */
    const h = await harness();
    t.after(() => h.server.stop());

    /* When */
    const res = await post(`${h.server.url}/ask/ghost`, JSON.stringify(hookBody), {
        [QUESTION_HOOK_TOKEN_HEADER]: h.server.token,
    });

    /* Then */
    assert.deepEqual(await res.json(), {});
});

test('the CLI dropping the request withdraws the question', async (t) => {
    /* Given */
    const h = await harness();
    t.after(() => h.server.stop());
    const response = post(`${h.server.url}/ask/s1`, JSON.stringify(hookBody), {
        [QUESTION_HOOK_TOKEN_HEADER]: h.server.token,
    }).catch(() => null);
    await until(() => h.service.pending().length === 1);

    /* When */
    // A second set for the same session, then dropped from the client side as
    // the CLI does when its hook times out.
    const req = http.request(`${h.server.url}/ask/s1`, {
        method: 'POST',
        headers: {[QUESTION_HOOK_TOKEN_HEADER]: h.server.token},
    });
    req.on('error', () => {});
    req.end(JSON.stringify({...hookBody, tool_use_id: 'tu-2'}));

    /* Then */
    await until(() => h.service.pending()[0]?.toolUseId === 'tu-2');
    // The replacement released the first request with no decision.
    assert.deepEqual(await (await response)?.json(), {});

    /* When */
    req.destroy();

    /* Then */
    await until(() => h.service.pending().length === 0);
    const outcomes = h.renderer.only('questionsSettled').map((e) => e[1] as {toolUseId: string; outcome: string});
    assert.deepEqual(outcomes, [
        {sessionId: 's1', toolUseId: 'tu-1', outcome: 'withdrawn'},
        {sessionId: 's1', toolUseId: 'tu-2', outcome: 'withdrawn'},
    ]);
});

const ROUND_TEXT = [
    'Round 1.',
    '',
    '❓ **Q1** - **Keep the old API?**: It has two callers left.',
    '',
    '➡️ Keep it for one more release.',
].join('\n');

function stopBody(lastMessage: string | undefined) {
    return {
        session_id: 'claude-id',
        hook_event_name: 'Stop',
        stop_hook_active: false,
        last_assistant_message: lastMessage,
    };
}

test('a turn ending with a grilling round is answered at once and shows the round', async (t) => {
    /* Given */
    const h = await harness();
    t.after(() => h.server.stop());

    /* When */
    const res = await post(`${h.server.url}/stop/s1`, JSON.stringify(stopBody(ROUND_TEXT)), {
        [QUESTION_HOOK_TOKEN_HEADER]: h.server.token,
    });

    /* Then */
    assert.deepEqual(await res.json(), {});
    await until(() => h.service.pending().length === 1);
    const [pending] = h.service.pending();
    assert.equal(pending.source, 'grill');
    assert.deepEqual(
        pending.questions.map((q) => q.question),
        ['Keep the old API?'],
    );
});

test('a turn ending with anything else shows nothing', async (t) => {
    /* Given */
    const h = await harness();
    t.after(() => h.server.stop());

    /* When */
    const responses = await Promise.all([
        post(`${h.server.url}/stop/s1`, JSON.stringify(stopBody('All done, tests pass.')), {
            [QUESTION_HOOK_TOKEN_HEADER]: h.server.token,
        }),
        post(`${h.server.url}/stop/s1`, JSON.stringify(stopBody(undefined)), {
            [QUESTION_HOOK_TOKEN_HEADER]: h.server.token,
        }),
    ]);

    /* Then */
    for (const res of responses) assert.deepEqual(await res.json(), {});
    assert.deepEqual(h.service.pending(), []);
    assert.equal(h.renderer.only('questionsAsked').length, 0);
});

test('a prompt submitted withdraws the waiting round', async (t) => {
    /* Given */
    const h = await harness();
    t.after(() => h.server.stop());
    await post(`${h.server.url}/stop/s1`, JSON.stringify(stopBody(ROUND_TEXT)), {
        [QUESTION_HOOK_TOKEN_HEADER]: h.server.token,
    });
    await until(() => h.service.pending().length === 1);

    /* When */
    const res = await post(
        `${h.server.url}/prompt/s1`,
        JSON.stringify({hook_event_name: 'UserPromptSubmit', prompt: 'Q1: yes'}),
        {[QUESTION_HOOK_TOKEN_HEADER]: h.server.token},
    );

    /* Then */
    assert.deepEqual(await res.json(), {});
    assert.deepEqual(h.service.pending(), []);
    assert.deepEqual(
        h.renderer.only('questionsSettled').map((e) => (e[1] as {outcome: string}).outcome),
        ['withdrawn'],
    );
});

test('the notice routes need the token too', async (t) => {
    /* Given */
    const h = await harness();
    t.after(() => h.server.stop());

    /* When */
    const [stop, prompt, subagent] = await Promise.all([
        post(`${h.server.url}/stop/s1`, JSON.stringify(stopBody(ROUND_TEXT))),
        post(`${h.server.url}/prompt/s1`, '{}'),
        post(`${h.server.url}/subagent/s1`, '{}'),
    ]);

    /* Then */
    assert.equal(stop.status, 401);
    assert.equal(prompt.status, 401);
    assert.equal(subagent.status, 401);
    assert.deepEqual(h.service.pending(), []);
});

// ── The grilling card's notices, as the receiver gets them ──

/** A server whose receiver only records what it is handed. */
async function recordingServer(transcripts?: TranscriptTail) {
    const calls: unknown[][] = [];
    const server = new QuestionHookServer({
        receiver: {
            receive: () => ({withdraw() {}}),
            turnEnded: (launchId: string, turn: EndedTurn, agents: string[] | null) =>
                void calls.push(['turnEnded', launchId, turn, agents]),
            promptSubmitted: (launchId: string, prompt: string) =>
                void calls.push(['promptSubmitted', launchId, prompt]),
            subagentChanged: (launchId: string, event: string, agentId: string) =>
                void calls.push(['subagentChanged', launchId, event, agentId]),
        },
        transcripts,
        log: silentLog,
    });
    await server.start();
    const send = (route: string, body: unknown) =>
        post(`${server.url}/${route}/s1`, JSON.stringify(body), {[QUESTION_HOOK_TOKEN_HEADER]: server.token});
    return {server, calls, send};
}

const line = (entry: Record<string, unknown>) => JSON.stringify(entry);

test("a Stop hands on the turn read from the end of the session's transcript, with its background agents", async (t) => {
    /* Given */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grill-turn-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const transcript = path.join(dir, 's.jsonl');
    fs.writeFileSync(
        transcript,
        [
            line({type: 'user', uuid: 'u1', message: {role: 'user', content: 'grill me'}}),
            line({type: 'assistant', uuid: 'a1', message: {content: [{type: 'text', text: 'Researching.'}]}}),
            line({type: 'assistant', uuid: 'a2', message: {content: [{type: 'text', text: 'The round.'}]}}),
        ].join('\n') + '\n',
    );
    const h = await recordingServer(new FileTranscriptTail(new NodeFileSystem()));
    t.after(() => h.server.stop());

    /* When */
    const res = await h.send('stop', {
        ...stopBody('The round.'),
        transcript_path: transcript,
        background_tasks: [{id: 'ag1', type: 'subagent'}],
    });

    /* Then */
    assert.deepEqual(await res.json(), {});
    await until(() => h.calls.length === 1);
    assert.deepEqual(h.calls, [
        [
            'turnEnded',
            's1',
            {
                texts: [
                    {id: 'a1', text: 'Researching.'},
                    {id: 'a2', text: 'The round.'},
                ],
            },
            ['ag1'],
        ],
    ]);
});

test("a Stop whose transcript cannot be read hands on the Stop's last message alone", async (t) => {
    /* Given */
    const h = await recordingServer({read: () => null});
    t.after(() => h.server.stop());

    /* When */
    await h.send('stop', {...stopBody('All done.'), transcript_path: '/nowhere.jsonl'});
    await h.send('stop', stopBody(undefined));

    /* Then */
    await until(() => h.calls.length === 2);
    assert.deepEqual(h.calls, [
        ['turnEnded', 's1', {texts: [{id: 'stop-e6aa44429812', text: 'All done.'}]}, null],
        ['turnEnded', 's1', {texts: []}, null],
    ]);
});

test('a prompt hands on its text, and subagent starts and stops their agent', async (t) => {
    /* Given */
    const h = await recordingServer();
    t.after(() => h.server.stop());

    /* When */
    await h.send('prompt', {hook_event_name: 'UserPromptSubmit', prompt: 'Q1: yes'});
    await h.send('subagent', {hook_event_name: 'SubagentStart', agent_id: 'ag1', agent_type: 'Explore'});
    await h.send('subagent', {hook_event_name: 'SubagentStop', agent_id: 'ag1'});
    const junk = await h.send('subagent', {hook_event_name: 'SubagentStop'});

    /* Then */
    assert.deepEqual(await junk.json(), {});
    assert.deepEqual(h.calls, [
        ['promptSubmitted', 's1', 'Q1: yes'],
        ['subagentChanged', 's1', 'start', 'ag1'],
        ['subagentChanged', 's1', 'stop', 'ag1'],
    ]);
});
