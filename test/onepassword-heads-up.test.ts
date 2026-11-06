import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {ActiveSession} from '../src/application/model/active-session';
import {SessionRegistry} from '../src/application/model/session-registry';
import {OnePasswordHeadsUpService} from '../src/application/services/onepassword-heads-up-service';
import {
    headsUpCopy,
    ONEPASSWORD_HOOK_STATUS,
    ONEPASSWORD_HOOK_TIMEOUT_SECONDS,
    onePasswordNeed,
    parseOnePasswordHookInput,
    STOPPED_REASON,
    type OnePasswordHeadsUp,
} from '../src/domain/onepassword/heads-up';
import {QUESTION_HOOK_TOKEN_HEADER, questionHookSettings} from '../src/domain/questions/question';
import {QuestionHookServer} from '../src/infrastructure/http/question-hook-server';
import {fakePty, silentLog} from './support/fakes';

/**
 * The 1Password heads-up: which commands get one, that the hook holds them
 * until the pop-up is answered (so the heads-up always comes first), and what
 * Enter and Escape tell the CLI.
 */

// ── Which commands reach 1Password ──

const access = [
    'op read op://Private/GitHub/token',
    'op item get "AWS" --fields password',
    'op run --env-file .env -- npm start',
    'cd infra && op inject -i config.tpl -o config.yml',
    'TOKEN=$(op read op://Work/npm/token) npm publish',
    'export X=`op read op://a/b/c`',
    'env OP_ACCOUNT=my op whoami',
    '/opt/homebrew/bin/op vault list',
    'echo op://Private/GitHub/token | op inject',
];
const unlock = [
    'ssh deploy@vm.example.com uptime',
    'scp build.zip me@host:/tmp/',
    'sftp me@host',
    'rsync -av dist/ me@host:/var/www/',
    'git clone git@github.com:JBlaak/Patch.git',
    'git push ssh://git@github.com/JBlaak/Patch.git main',
    'GIT_SSH_COMMAND="ssh -v" git fetch',
    'git remote add vm me@vm:repo.git && git push vm main',
];
const neither = [
    'git push origin main',
    'git log --oneline | grep op',
    'npm run build',
    'echo "the shop is open"',
    'grep -rn "ssh" src',
    'rsync -av dist/ build/',
    'cat ~/.ssh/config',
    'ls ./op-notes',
    'git commit -m "op is fine"',
];

for (const command of access) {
    test(`asks to access 1Password: ${command}`, () => assert.equal(onePasswordNeed(command), 'access'));
}
for (const command of unlock) {
    test(`asks 1Password to unlock the SSH key: ${command}`, () => assert.equal(onePasswordNeed(command), 'unlock'));
}
for (const command of neither) {
    test(`does not reach 1Password: ${command}`, () => assert.equal(onePasswordNeed(command), null));
}

test('a hook body parses only for a PreToolUse Bash call that reaches 1Password', () => {
    /* Given */
    const body = bash('op read op://Private/GitHub/token', 'read the GitHub token to open the PR');

    /* Then */
    assert.deepEqual(parseOnePasswordHookInput(body), {
        toolUseId: 'tu-1',
        need: 'access',
        command: 'op read op://Private/GitHub/token',
        description: 'read the GitHub token to open the PR',
    });
    assert.equal(parseOnePasswordHookInput(bash('npm test')), null);
    assert.equal(parseOnePasswordHookInput({...body, tool_name: 'Read'}), null);
    assert.equal(parseOnePasswordHookInput({...body, hook_event_name: 'PostToolUse'}), null);
});

test("the copy: Patch's line on top, and why in Claude's words", () => {
    /* When */
    const access = headsUpCopy({need: 'access', description: 'Read the npm token to publish', project: 'Patch'});
    const unlock = headsUpCopy({need: 'unlock', description: 'push the release branch.', project: 'switchboard'});
    const unsaid = headsUpCopy({need: 'unlock', description: '', project: 'switchboard'});

    /* Then */
    assert.deepEqual(access, {
        eyebrow: '1Password · Secret · Patch',
        line: 'Can I borrow a secret?',
        why: 'Claude wants to read the npm token to publish.',
        goLabel: 'Allow',
        then: 'Then 1Password asks for Touch ID.',
    });
    assert.equal(unlock.eyebrow, '1Password · SSH key · switchboard');
    assert.equal(unlock.line, 'I need your SSH key.');
    assert.equal(unlock.why, 'Claude wants to push the release branch.');
    assert.equal(unlock.goLabel, 'Unlock');
    assert.equal(unsaid.why, 'Claude didn’t say why. Check the command below.');
    assert.equal(
        headsUpCopy({need: 'unlock', description: 'SSH into the VM', project: 'p'}).why,
        'Claude wants to SSH into the VM.',
    );
});

test('the hook settings match Bash to the 1Password route, waiting for an answer', () => {
    /* When */
    const settings = JSON.parse(
        questionHookSettings(
            {ask: 'a', stop: 's', prompt: 'p', subagent: 'g', onePassword: 'http://x/onepassword/1'},
            't',
        ),
    );

    /* Then */
    const bashHook = settings.hooks.PreToolUse.find((entry: {matcher: string}) => entry.matcher === 'Bash');
    assert.deepEqual(bashHook.hooks, [
        {
            type: 'http',
            url: 'http://x/onepassword/1',
            headers: {[QUESTION_HOOK_TOKEN_HEADER]: 't'},
            statusMessage: ONEPASSWORD_HOOK_STATUS,
            timeout: ONEPASSWORD_HOOK_TIMEOUT_SECONDS,
        },
    ]);
});

test("a VM agent's hook settings, with no 1Password route, have no Bash hook", () => {
    /* When */
    const settings = JSON.parse(questionHookSettings({ask: 'a', stop: 's', prompt: 'p', subagent: 'g'}, 't'));

    /* Then */
    assert.deepEqual(
        settings.hooks.PreToolUse.map((entry: {matcher: string}) => entry.matcher),
        ['AskUserQuestion'],
    );
});

// ── The hook, held until the pop-up is answered ──

async function harness() {
    const registry = new SessionRegistry();
    const panel: {shown: OnePasswordHeadsUp[]; hides: number} = {shown: [], hides: 0};
    const service = new OnePasswordHeadsUpService({
        registry,
        clock: {now: () => 1000},
        log: silentLog,
        panel: {
            show: (headsUp) => panel.shown.push(headsUp),
            hide: () => panel.hides++,
        },
    });
    const server = new QuestionHookServer({
        receiver: {receive: () => ({withdraw() {}}), turnEnded() {}, promptSubmitted() {}, subagentChanged() {}},
        onePassword: service,
        log: silentLog,
    });
    await server.start();
    registry.add(
        's1',
        new ActiveSession({
            pty: fakePty(),
            projectPath: '/Users/me/Development/Patch',
            projectFolder: '-Users-me-Development-Patch',
            knownTranscriptIds: new Set(),
            sessionSlug: null,
            isPlainTerminal: false,
            remote: null,
            openedAt: 0,
        }),
    );
    return {server, service, panel};
}

function bash(command: string, description?: string): Record<string, unknown> {
    return {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_use_id: 'tu-1',
        tool_input: {command, ...(description ? {description} : {})},
    };
}

interface Posted {
    response: Promise<{status: number; json: unknown}>;
    request: http.ClientRequest;
}

function post(server: QuestionHookServer, launchId: string, body: unknown): Posted {
    const url = new URL(`${server.url}/onepassword/${launchId}`);
    let request!: http.ClientRequest;
    const response = new Promise<{status: number; json: unknown}>((resolve, reject) => {
        request = http.request(
            url,
            {method: 'POST', headers: {[QUESTION_HOOK_TOKEN_HEADER]: server.token, 'Content-Type': 'application/json'}},
            (res) => {
                let raw = '';
                res.on('data', (chunk) => (raw += chunk));
                res.on('end', () => resolve({status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null}));
            },
        );
        request.on('error', reject);
        request.end(JSON.stringify(body));
    });
    return {response, request};
}

/** True when the promise has not settled after the event loop has had a turn. */
async function stillPending(promise: Promise<unknown>): Promise<boolean> {
    const marker = Symbol('pending');
    const winner = await Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(marker), 50))]);
    return winner === marker;
}

test('a command that does not reach 1Password is let go at once, with no heads-up', async () => {
    /* Given */
    const {server, panel} = await harness();

    /* When */
    const {response} = post(server, 's1', bash('npm test', 'run the tests'));

    /* Then */
    assert.deepEqual(await response, {status: 200, json: {}});
    assert.equal(panel.shown.length, 0);
    server.stop();
});

test('access: the heads-up shows while the command is held, and Enter lets it go ahead', async () => {
    /* Given */
    const {server, service, panel} = await harness();

    /* When */
    const {response} = post(server, 's1', bash('op read op://Private/npm/token', 'read the npm token to publish'));
    await waitFor(() => panel.shown.length === 1);

    /* Then: shown before the command can run, which is still held */
    assert.equal(await stillPending(response), true);
    assert.equal(panel.shown[0].need, 'access');
    assert.equal(panel.shown[0].project, 'Patch');
    assert.equal(panel.shown[0].description, 'read the npm token to publish');

    /* When: Enter */
    assert.equal(service.answer(panel.shown[0].id, 'go'), true);

    /* Then: no decision, so the session's own permission rules apply and 1Password asks */
    assert.deepEqual(await response, {status: 200, json: {}});
    assert.equal(panel.hides, 1);
    server.stop();
});

test('unlock: the heads-up shows while the command is held, and Escape stops it', async () => {
    /* Given */
    const {server, service, panel} = await harness();

    /* When */
    const {response} = post(server, 's1', bash('git push git@github.com:JBlaak/Patch.git main', 'push the fix'));
    await waitFor(() => panel.shown.length === 1);

    /* Then */
    assert.equal(await stillPending(response), true);
    assert.equal(panel.shown[0].need, 'unlock');

    /* When: Escape */
    service.answer(panel.shown[0].id, 'stop');

    /* Then */
    assert.deepEqual(await response, {
        status: 200,
        json: {
            hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: STOPPED_REASON,
            },
        },
    });
    server.stop();
});

test('two at once queue: the second shows only once the first is answered, and each is answered once', async () => {
    /* Given */
    const {server, service, panel} = await harness();
    const first = post(server, 's1', bash('ssh vm uptime'));
    await waitFor(() => panel.shown.length === 1);
    const second = post(server, 's1', bash('op whoami'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    /* Then */
    assert.equal(panel.shown.length, 1);

    /* When */
    service.answer(panel.shown[0].id, 'go');
    await first.response;

    /* Then */
    assert.equal(panel.shown.length, 2);
    assert.equal(panel.shown[1].need, 'access');
    assert.equal(service.answer(panel.shown[0].id, 'stop'), false);
    service.answer(panel.shown[1].id, 'stop');
    await second.response;
    assert.equal(panel.hides, 1);
    server.stop();
});

test('a request the CLI gives up on takes its heads-up off screen', async () => {
    /* Given */
    const {server, service, panel} = await harness();
    const {request, response} = post(server, 's1', bash('ssh vm uptime'));
    response.catch(() => {});
    await waitFor(() => panel.shown.length === 1);

    /* When */
    request.destroy();
    await waitFor(() => panel.hides === 1);

    /* Then */
    assert.equal(service.current(), null);
    server.stop();
});

test('a session Switchboard does not know is let go at once', async () => {
    /* Given */
    const {server, panel} = await harness();

    /* When */
    const {response} = post(server, 'stranger', bash('op read op://a/b/c'));

    /* Then */
    assert.deepEqual(await response, {status: 200, json: {}});
    assert.equal(panel.shown.length, 0);
    server.stop();
});

async function waitFor(condition: () => boolean): Promise<void> {
    for (let i = 0; i < 100 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(condition(), 'timed out waiting');
}
