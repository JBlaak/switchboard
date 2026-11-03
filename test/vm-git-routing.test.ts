/**
 * Routing git by path (#276 stage 4), and the connection's stage 4 requests:
 * local paths and agentless remotes stay local, agent hosts go to the VM.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {AGENT_PROTOCOL_VERSION} from '../src/domain/agent/protocol';
import type {VmHost} from '../src/domain/agent/vm-paths';
import {AgentConnection} from '../src/application/services/agent-client/agent-connection';
import type {Disposable, GitWorkspace, GitWorktrees} from '../src/application/ports/git-workspace';
import type {GitRemotes} from '../src/application/ports/git-remotes';
import {RoutingGitRemotes, RoutingGitWorkspace} from '../src/infrastructure/git/routing-git';
import type {VmGitRouting} from '../src/infrastructure/git/routing-git';
import {VmGitRunner} from '../src/infrastructure/git/vm-git-runner';
import type {AgentTools} from '../src/infrastructure/git/vm-git-runner';
import {fakeTimers, silentLog} from './support/fakes';
import {HOST_SETTINGS, scriptedAgent, settle} from './support/scripted-agent';

type Workspace = GitWorkspace & GitWorktrees;

/** A local workspace that only says which paths it was asked about. */
function recordingLocal(): {local: Workspace; asked: string[]} {
    const asked: string[] = [];
    const local = new Proxy({} as Workspace, {
        get: (_target, method) => async (first: string) => {
            asked.push(`${String(method)} ${first}`);
            return method === 'worktreeRoot' ? first : null;
        },
    });
    return {local, asked};
}

/** An agent that answers every `git` with `stdout`, recording each run's folder and args. */
function fakeTools(stdout: string, {home = '/home/dev', truncated = false} = {}) {
    const runs: {cwd: string; args: readonly string[]}[] = [];
    const tools: AgentTools = {
        home,
        whenConnected: async () => {},
        async runTool(_tool, cwd, args) {
            runs.push({cwd, args});
            return {code: 0, stdout: Buffer.from(stdout), stderr: '', truncated};
        },
        readFile: async () => null,
        statFiles: async () => new Map(),
        watchDir: (): Disposable => ({dispose() {}}),
    };
    return {tools, runs};
}

function routing(tools: AgentTools, agentHosts: string[]): VmGitRouting & {asked: VmHost[]} {
    const asked: VmHost[] = [];
    return {
        asked,
        isAgentHost: (host) => agentHosts.includes(host.host),
        tools: (host) => {
            asked.push(host);
            return tools;
        },
    };
}

test('a local path goes to the local workspace, untouched', async () => {
    /* Given */
    const {local, asked} = recordingLocal();
    const {tools, runs} = fakeTools('');
    const git = new RoutingGitWorkspace(local, routing(tools, ['vm.test']));

    /* When */
    const root = await git.worktreeRoot('/Users/me/site');

    /* Then */
    assert.equal(root, '/Users/me/site');
    assert.deepEqual(asked, ['worktreeRoot /Users/me/site']);
    assert.equal(runs.length, 0);
});

test('a path on an agentless remote goes to the local workspace, answering as before', async () => {
    /* Given */
    const {local, asked} = recordingLocal();
    const {tools, runs} = fakeTools('');
    const git = new RoutingGitWorkspace(local, routing(tools, ['vm.test']));

    /* When */
    await git.status('ssh://dev@old-box//srv/site');

    /* Then */
    assert.deepEqual(asked, ['status ssh://dev@old-box//srv/site']);
    assert.equal(runs.length, 0);
});

test("a path on an agent host runs on that host's agent and comes back VM-named", async () => {
    /* Given */
    const {local, asked} = recordingLocal();
    const {tools, runs} = fakeTools('/home/dev/site\n');
    const route = routing(tools, ['vm.test']);
    const git = new RoutingGitWorkspace(local, route);

    /* When */
    const root = await git.worktreeRoot('ssh://dev@vm.test:2222/~/site');

    /* Then */
    assert.equal(root, 'ssh://dev@vm.test:2222//home/dev/site');
    assert.deepEqual(runs, [{cwd: '/home/dev/site', args: ['--no-optional-locks', 'rev-parse', '--show-toplevel']}]);
    assert.deepEqual(new Set(route.asked.map((h) => `${h.user}@${h.host}:${h.port}`)), new Set(['dev@vm.test:2222']));
    assert.deepEqual(asked, []);
});

test('the origin of a VM project is read on the VM; a local one locally', async () => {
    /* Given */
    const localAsked: string[] = [];
    const local: GitRemotes = {
        originUrl: async (p) => {
            localAsked.push(p);
            return 'git@github.com:me/local.git';
        },
    };
    const {tools, runs} = fakeTools('git@github.com:acme/web.git\n');
    const remotes = new RoutingGitRemotes(local, routing(tools, ['vm.test']));

    /* When */
    const onVm = await remotes.originUrl('ssh://dev@vm.test//home/dev/web');
    const onMac = await remotes.originUrl('/Users/me/local');

    /* Then */
    assert.equal(onVm, 'git@github.com:acme/web.git');
    assert.equal(onMac, 'git@github.com:me/local.git');
    assert.deepEqual(
        runs.map((r) => r.cwd),
        ['/home/dev/web'],
    );
    assert.deepEqual(localAsked, ['/Users/me/local']);
});

test('output the agent had to cut counts as a failed run, not a short diff', async () => {
    /* Given */
    const {tools} = fakeTools('diff --git a/x b/x\n', {truncated: true});
    const runner = new VmGitRunner({user: 'dev', host: 'vm.test', port: 22}, () => tools);

    /* When */
    const run = await runner.git('ssh://dev@vm.test//home/dev/site', ['diff'], {timeoutMs: 1000});

    /* Then */
    assert.equal(run.code, null);
    assert.equal(run.stdout.length, 0);
});

test('a VM runner refuses a path on another host instead of running it', async () => {
    /* Given */
    const {tools, runs} = fakeTools('');
    const runner = new VmGitRunner({user: 'dev', host: 'vm.test', port: 22}, () => tools);

    /* When */
    const run = await runner.git('ssh://dev@other.test//home/dev/site', ['status'], {timeoutMs: 1000});
    const local = runner.toHost('/Users/me/site');

    /* Then */
    assert.equal(run.code, null);
    assert.match(run.error ?? '', /not a path on dev@vm\.test:22/);
    assert.equal(local, null);
    assert.equal(runs.length, 0);
});

function connectionHarness() {
    const agent = scriptedAgent();
    const connection = new AgentConnection({
        host: {user: 'dev', host: 'vm.test', port: 22},
        dialer: agent.dialer,
        appVersion: '2.12.0',
        timers: fakeTimers(),
        clock: {now: () => 0},
        log: silentLog,
    });
    return {agent, connection};
}

test('a folder watch is asked for on connect, again after a reconnect, and dropped when disposed', async () => {
    /* Given */
    const {agent, connection} = connectionHarness();
    let changes = 0;
    const watch = connection.watchDir('/home/dev/site', () => changes++);
    await connection.whenConnected();
    const [first] = agent.sent('watch-dir');

    /* When */
    agent.send({type: 'dir-changed', watchId: first.watchId});
    agent.current().drop();
    connection.retryNow();
    await connection.whenConnected();
    await settle();
    watch.dispose();
    agent.send({type: 'dir-changed', watchId: first.watchId});

    /* Then */
    assert.deepEqual(
        agent.sent('watch-dir').map((m) => [m.watchId, m.dir]),
        [
            [first.watchId, '/home/dev/site'],
            [first.watchId, '/home/dev/site'],
        ],
    );
    assert.deepEqual(agent.sent('unwatch-dir'), [{type: 'unwatch-dir', watchId: first.watchId}]);
    assert.equal(changes, 1);
    connection.close();
});

test("the connection keeps the home a welcome says, and null from an agent that doesn't", async () => {
    /* Given */
    const {agent, connection} = connectionHarness();
    agent.greet = 'silent';
    const {connection: older} = connectionHarness();

    /* When */
    const connected = connection.whenConnected();
    await settle();
    agent.send({
        type: 'welcome',
        protocol: AGENT_PROTOCOL_VERSION,
        agentVersion: '2.12.0',
        settings: HOST_SETTINGS,
        home: '/home/dev',
    });
    await connected;
    await older.whenConnected();

    /* Then */
    assert.equal(connection.home, '/home/dev');
    assert.equal(older.home, null);
    connection.close();
    older.close();
});

test('run-tool, read-file, stat-files and transcript-query answers come back decoded', async () => {
    /* Given */
    const {agent, connection} = connectionHarness();
    await connection.whenConnected();
    agent.current().agent.onMessage((m) => {
        if (m.type === 'run-tool')
            agent.send({
                type: 'tool-result',
                requestId: m.requestId,
                code: 0,
                stdoutBase64: Buffer.from(Buffer.from(m.stdinBase64 ?? '', 'base64').toString() + '!').toString(
                    'base64',
                ),
                stderr: '',
            });
        if (m.type === 'read-file')
            agent.send({
                type: 'file-content',
                requestId: m.requestId,
                found: m.path === '/a',
                contentBase64: Buffer.from('A').toString('base64'),
            });
        if (m.type === 'stat-files') agent.send({type: 'file-stats', requestId: m.requestId, sizes: {'/a': 1}});
        if (m.type === 'transcript-query')
            agent.send(
                m.method === 'locations'
                    ? {type: 'transcript-answer', requestId: m.requestId, ok: true, result: ['x']}
                    : {type: 'transcript-answer', requestId: m.requestId, ok: false, error: 'nope'},
            );
    });

    /* When */
    const ran = await connection.runTool('git', '/repo', ['hash-object', '--stdin'], {stdin: 'in', timeoutMs: 1000});
    const found = await connection.readFile('/a', 10);
    const missing = await connection.readFile('/b', 10);
    const sizes = await connection.statFiles(['/a', '/b']);
    const locations = await connection.transcriptQuery('locations', []);
    const refused = connection.transcriptQuery('readTail', ['s', 10]);

    /* Then */
    assert.deepEqual({...ran, stdout: ran.stdout.toString()}, {code: 0, stdout: 'in!', stderr: '', truncated: false});
    assert.equal(found?.toString(), 'A');
    assert.equal(missing, null);
    assert.deepEqual([...sizes], [['/a', 1]]);
    assert.deepEqual(locations, ['x']);
    await assert.rejects(refused, /nope/);
    connection.close();
});
