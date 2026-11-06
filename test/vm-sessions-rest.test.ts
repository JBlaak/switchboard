import {test} from 'node:test';
import assert from 'node:assert/strict';

import {SessionRegistry} from '../src/application/model/session-registry';
import {AgentAwareTerminals} from '../src/application/services/agent-client/agent-aware-terminals';
import {AgentClient} from '../src/application/services/agent-client/agent-client';
import {IssueSessionService} from '../src/application/services/issue-session-service';
import {PhoneSessionsService} from '../src/application/services/phone-sessions-service';
import {RemoteConnectionSupervisor} from '../src/application/services/remote-connection-supervisor';
import {SessionLauncher} from '../src/application/services/session-launcher';
import {SessionLifecycle} from '../src/application/services/session-lifecycle';
import {SettingsService} from '../src/application/services/settings-service';
import {addRemotesRegisteringVms} from './support/vm-registry';
import {TaskLinkService} from '../src/application/services/task-link-service';
import {TaskSessionService} from '../src/application/services/task-session-service';
import {TasksService, type TaskServices} from '../src/application/services/tasks-service';
import {VmTranscripts} from '../src/application/services/vm-transcripts';
import {routeCandidates} from '../src/domain/ask/route';
import {AGENT_PROTOCOL_VERSION} from '../src/domain/agent/protocol';
import {vmFolder} from '../src/domain/agent/vm-paths';
import {agentlessRemoteGuard} from '../src/domain/project/agentless-remote';
import {
    FakeStartGit,
    MemoryTaskLinkStore,
    fakeDeviceConnection,
    fakeRenderer,
    fakeRouter,
    fakeTerminals,
    fakeTimers,
    silentLog,
} from './support/fakes';
import {HOST_SETTINGS, scriptedAgent, settle} from './support/scripted-agent';
import type {AgentDialer} from '../src/application/ports/agent-link';
import type {SettingsStore} from '../src/application/ports/settings-store';
import type {PhoneSessionsServiceDeps} from '../src/application/services/phone-sessions-service';
import type {SessionLauncherDeps} from '../src/application/services/session-launcher';
import type {TaskWritesService} from '../src/application/services/task-writes-service';
import type {SessionOptions} from '../src/domain/launch/session-options';
import type {Plan} from '../src/domain/plan/model';
import type {Project} from '../src/domain/project/project';
import type {RemoteProjectSetting} from '../src/domain/settings/settings';

/**
 * The Mac side of the rest of #276 stage 5: issue and task sessions start in
 * new worktrees on a VM, which the launcher records as projects of their own;
 * task detection reads a VM session's tail over its link; Quick Ask may route
 * to a VM project; and the phone labels a VM session with its host. Agentless
 * remotes keep every rule they had.
 */

const HOME = '/home/dev';
const HOST = {user: 'dev', host: 'vm.local', port: 22};
const AGENT = {version: '2.12.0', installedAt: '2026-11-03T00:00:00Z'};
const LOCAL_SITE = '/Users/joris/code/site';
/** The VM project, a hand-off's copy of the local site, stored in its `~` form. */
const VM_SITE = 'ssh://dev@vm.local/~/projects/site';
/** Its main checkout as git on the VM names it: absolute. */
const VM_ROOT = 'ssh://dev@vm.local//home/dev/projects/site';
const ORIGIN = 'git@github.com:JBlaak/site.git';

class MemoryStore implements SettingsStore {
    private readonly values = new Map<string, unknown>();
    public get<T = unknown>(key: string): T | null {
        return (this.values.get(key) as T) ?? null;
    }
    public set(key: string, value: unknown): void {
        this.values.set(key, structuredClone(value));
    }
    public delete(key: string): void {
        this.values.delete(key);
    }
}

function vmSite(fields: Partial<RemoteProjectSetting> = {}): RemoteProjectSetting {
    return {...HOST, dir: '~/projects/site', agent: AGENT, copyOf: LOCAL_SITE, ...fields};
}

/**
 * A VM's agent behind the scripted dialer: it welcomes with its home, and
 * answers the transcript reads the Mac makes.
 */
function vmAgent() {
    const agent = scriptedAgent();
    agent.greet = 'silent';
    const tails = new Map<string, string[]>();
    const dialer: AgentDialer = {
        async dial(host) {
            const mac = await agent.dialer.dial(host);
            const pair = agent.current();
            pair.agent.onMessage((message) => {
                if (message.type === 'hello') {
                    pair.agent.send({
                        type: 'welcome',
                        protocol: AGENT_PROTOCOL_VERSION,
                        agentVersion: message.appVersion,
                        settings: HOST_SETTINGS,
                        home: HOME,
                    });
                } else if (message.type === 'transcript-tail') {
                    const lines = tails.get(message.sessionId) ?? [];
                    pair.agent.send({type: 'transcript-tail', requestId: message.requestId, lines});
                } else if (message.type === 'get-transcript') {
                    pair.agent.send({type: 'transcript', requestId: message.requestId, transcript: null});
                }
            });
            return mac;
        },
    };
    return {agent, dialer, tails};
}

/** The launcher as the app wires it, over a scripted VM agent and real settings. */
function harness({remotes = [vmSite()]}: {remotes?: RemoteProjectSetting[]} = {}) {
    const vm = vmAgent();
    const timers = fakeTimers();
    const clock = {now: () => Date.parse('2026-11-03T10:00:00Z')};
    const registry = new SessionRegistry();
    const renderer = fakeRenderer();
    const local = fakeTerminals();
    const terminals = new AgentAwareTerminals(local);
    const remote = new RemoteConnectionSupervisor({
        registry,
        terminals,
        renderer,
        timers,
        clock,
        log: silentLog,
        homeDir: '/Users/joris',
    });
    const lifecycle = new SessionLifecycle({registry, terminals, renderer, remote, timers, log: silentLog});
    remote.attach(lifecycle);
    const client = new AgentClient({
        dialer: vm.dialer,
        appVersion: '2.12.0',
        registry,
        renderer,
        hooks: {receive: () => ({withdraw() {}}), turnEnded() {}, promptSubmitted() {}, subagentChanged() {}},
        archiveTool: {request: () => ({ok: true, message: ''}), turnEnded() {}},
        timers,
        clock,
        log: silentLog,
    });
    const settings = new SettingsService(new MemoryStore());
    addRemotesRegisteringVms(settings, remotes);

    const launcher = new SessionLauncher({
        registry,
        terminals,
        shells: {list: () => [], resolve: () => ({id: 'zsh', name: 'zsh', path: '/bin/zsh'})},
        transcripts: {listSessionIds: () => [], readSlug: () => null},
        settings,
        lifecycle,
        remote,
        renderer,
        questions: {settingsFor: () => null},
        git: {worktreeRoot: async () => null},
        clock,
        timers,
        log: silentLog,
        fileExists: () => true,
        agents: client,
    } as unknown as SessionLauncherDeps);

    const open = (projectPath: string, sessionId = 's1', options?: SessionOptions) =>
        launcher.open({sessionId, projectPath, isNew: true, options});
    /** Bring the host's link up, as the git that made a worktree there has. */
    const connect = () => client.connection(HOST).whenConnected();
    const agentlessRemote = agentlessRemoteGuard(() => settings.vmHosts());

    return {...vm, registry, renderer, local, client, settings, launcher, open, connect, agentlessRemote, clock};
}

function plan(): Plan {
    return {
        repository: 'JBlaak/site',
        number: 40,
        title: 'Pages',
        parent: null,
        issues: [
            {
                repository: 'JBlaak/site',
                number: 42,
                title: 'Fix the header',
                state: 'open',
                closedAs: null,
                updatedAt: '2026-11-01T00:00:00Z',
                blockedBy: [],
                pullRequests: [],
                summary: '',
                acceptance: [],
            },
        ],
        outside: [],
    };
}

// ── Launching in any folder on an agent host ──

test('a launch in a new VM worktree opens on the agent and records the folder as a copy of the local project', async () => {
    /* Given */
    const h = harness();
    await h.connect();
    const worktree = VM_ROOT + '/.claude/worktrees/fix-42';

    /* When */
    const result = await h.open(worktree, 's1', {initialPrompt: 'Fix #42.'});

    /* Then */
    assert.deepEqual(result, {ok: true, reattached: false});
    const open = h.agent.sent('open');
    assert.equal(open.length, 1);
    assert.equal(open[0].dir, '/home/dev/projects/site/.claude/worktrees/fix-42');
    assert.equal(open[0].options?.initialPrompt, 'Fix #42.');
    assert.deepEqual(h.settings.findRemoteProject(worktree), {
        ...HOST,
        dir: '/home/dev/projects/site/.claude/worktrees/fix-42',
        agent: AGENT,
        copyOf: LOCAL_SITE,
        sessions: [
            {
                sessionId: 's1',
                kind: 'claude',
                created: '2026-11-03T10:00:00.000Z',
                lastOpened: '2026-11-03T10:00:00.000Z',
            },
        ],
    });
    assert.equal(h.local.spawns.length, 0, 'no ssh');
});

test('a VM folder under no copy is recorded with the host agent and no copyOf', async () => {
    /* Given */
    const h = harness({remotes: [vmSite({copyOf: undefined})]});
    const folder = 'ssh://dev@vm.local//srv/scratch';

    /* When */
    await h.open(folder);

    /* Then */
    const record = h.settings.findRemoteProject(folder);
    assert.deepEqual(record?.agent, AGENT);
    assert.equal(record?.copyOf, undefined);
    assert.equal(h.agent.sent('open')[0].dir, '/srv/scratch');
});

test('an unrecorded folder on an agentless host is refused as before, and nothing is recorded', async () => {
    /* Given */
    const h = harness({remotes: [vmSite(), {user: 'dev', host: 'box', port: 22, dir: 'srv'}]});
    const folder = 'ssh://dev@box//srv/.claude/worktrees/fix-42';

    /* When */
    const result = await h.open(folder);

    /* Then */
    assert.deepEqual(result, {ok: false, error: `remote project no longer exists: ${folder}`});
    assert.equal(h.settings.findRemoteProject(folder), null);
    assert.equal(h.agent.dials.length, 0);
});

test('a stored agentless remote still dials ssh+tmux', async () => {
    /* Given */
    const h = harness({remotes: [{user: 'dev', host: 'box', port: 22, dir: 'srv'}]});

    /* When */
    const result = await h.open('ssh://dev@box/srv');

    /* Then */
    assert.deepEqual(result, {ok: true, reattached: false});
    assert.equal(h.local.spawns.length, 1, 'ssh spawned');
    assert.equal(h.agent.dials.length, 0, 'no agent dialled');
    assert.equal(h.settings.remoteProjects().length, 1, 'nothing recorded');
});

// ── Issue sessions ──

test('an issue session on a VM project gets its worktree on the VM and starts there', async () => {
    /* Given */
    const h = harness();
    await h.connect();
    const git = new FakeStartGit(VM_ROOT);
    const issues = new IssueSessionService({
        sessions: () => [],
        transcripts: {locations: () => []},
        agentlessRemote: h.agentlessRemote,
        git: git.port,
        remotes: {originUrl: async () => ORIGIN},
        github: {available: async () => 'ok', closingIssues: async () => []},
        clock: h.clock,
        log: silentLog,
    });
    const prepared = await issues.prepareIssueWorktree({
        projectPath: VM_SITE,
        issue: {repository: 'JBlaak/site', number: 42},
        plan: plan(),
    });
    if (!prepared.ok) throw new Error(prepared.reason);

    /* When */
    const result = await h.open(prepared.worktreePath, 's1', {initialPrompt: prepared.prompt});

    /* Then */
    assert.equal(prepared.worktreePath, VM_ROOT + '/.claude/worktrees/42-fix-the-header');
    assert.deepEqual(git.writes, [
        'fetch main',
        `worktree add -b 42-fix-the-header ${VM_ROOT}/.claude/worktrees/42-fix-the-header origin/main`,
    ]);
    assert.deepEqual(result, {ok: true, reattached: false});
    assert.equal(h.agent.sent('open')[0].dir, '/home/dev/projects/site/.claude/worktrees/42-fix-the-header');
    assert.equal(h.settings.findRemoteProject(prepared.worktreePath)?.copyOf, LOCAL_SITE);
});

// ── Task sessions ──

test('a task session on a VM project gets its worktree on the VM and starts there', async () => {
    /* Given */
    const h = harness();
    await h.connect();
    const git = new FakeStartGit(VM_ROOT);
    const starts = new TaskSessionService({
        sessions: () => [],
        transcripts: {locations: () => []},
        agentlessRemote: h.agentlessRemote,
        git: git.port,
        repoOf: () => null,
        candidates: () => [],
        router: fakeRouter({kind: 'noMatch', reason: 'unused'}),
    });
    const prepared = await starts.prepare({id: 'task-7', title: 'Tidy the footer', brief: ''}, {projectPath: VM_SITE});
    if (prepared.kind !== 'ready') throw new Error('not ready: ' + prepared.kind);

    /* When */
    const result = await h.open(prepared.worktreePath, 's1', {initialPrompt: prepared.prompt});

    /* Then */
    assert.equal(prepared.projectPath, VM_ROOT);
    assert.equal(prepared.worktreePath, VM_ROOT + '/.claude/worktrees/tidy-the-footer');
    assert.deepEqual(result, {ok: true, reattached: false});
    assert.equal(h.agent.sent('open')[0].dir, '/home/dev/projects/site/.claude/worktrees/tidy-the-footer');
    assert.ok(h.settings.findRemoteProject(prepared.worktreePath), 'recorded');
});

test('a task session on an agentless remote is still refused', async () => {
    /* Given */
    const h = harness({remotes: [{user: 'dev', host: 'box', port: 22, dir: 'srv'}]});
    const git = new FakeStartGit('ssh://dev@box/srv');
    const starts = new TaskSessionService({
        sessions: () => [],
        transcripts: {locations: () => []},
        agentlessRemote: h.agentlessRemote,
        git: git.port,
        repoOf: () => null,
        candidates: () => [],
        router: fakeRouter({kind: 'noMatch', reason: 'unused'}),
    });

    /* When */
    const result = await starts.prepare({id: 'task-7', title: 'Tidy', brief: ''}, {projectPath: 'ssh://dev@box/srv'});

    /* Then */
    assert.deepEqual(result, {
        kind: 'failed',
        reason: 'A session on a task can only start in a local project or on a VM',
    });
    assert.deepEqual(git.writes, []);
});

// ── Task detection over a VM tail ──

test("a VM session's tail, read over its link, links it to the task it names", async () => {
    /* Given */
    const TASK = '1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9';
    const worktree = VM_ROOT + '/.claude/worktrees/tidy';
    const h = harness();
    await h.open(worktree, 'vm-1');
    await settle();
    h.tails.set('vm-1', [
        JSON.stringify({
            type: 'assistant',
            timestamp: '2026-11-03T10:00:00.000Z',
            message: {
                role: 'assistant',
                content: [
                    {type: 'tool_use', id: 't1', name: 'mcp__blaaktasks__progress', input: {id: TASK, text: 'Go'}},
                ],
            },
        }),
    ]);
    const vmTranscripts = new VmTranscripts({
        agents: h.client,
        remoteProjects: () => h.settings.remoteProjects(),
        store: {all: () => [], put() {}, delete() {}},
        searchIndex: {upsert() {}, deleteSession() {}},
        names: {getMeta: () => null, setName() {}},
        renderer: h.renderer,
        log: silentLog,
    } as unknown as ConstructorParameters<typeof VmTranscripts>[0]);
    const folder = vmFolder(HOST, '-home-dev-projects-site--claude-worktrees-tidy');
    const store = new MemoryTaskLinkStore();
    const renderer = fakeRenderer();
    const clock = {now: () => 1_000};
    const tasks = new TasksService({
        url: () => 'https://tasks.example.com/mcp',
        build: (): TaskServices => ({
            tasks: {} as TaskServices['tasks'],
            links: new TaskLinkService({store, sessions: () => [], clock}),
            starts: {prepare: async () => ({kind: 'cancelled'})},
            writes: {pullRequestOpened: async () => undefined} as unknown as TaskWritesService,
        }),
        renderer,
        sessionsIn: (asked) => (asked === folder ? [{sessionId: 'vm-1', projectPath: worktree}] : []),
        transcript: (_folder, sessionId) => vmTranscripts.tail(sessionId, 64 * 1024),
        modifiedAt: () => 5,
        pullRequests: () => [],
        archived: () => false,
        sessionProject: () => worktree,
        repoRoot: async () => VM_ROOT,
        clock,
        timers: fakeTimers(),
        log: silentLog,
    });

    /* When */
    await tasks.transcriptsChanged(folder);

    /* Then */
    assert.equal(tasks.sessionTask('vm-1'), TASK);
    assert.equal(store.forSession('vm-1')?.projectPath, VM_ROOT);
    assert.deepEqual(renderer.only('sessionTaskChanged'), [['sessionTaskChanged', 'vm-1', TASK]]);
    assert.equal(h.agent.sent('transcript-tail').length, 1);
});

// ── Quick Ask ──

test('Quick Ask may route to VM projects, but not to agentless remotes or any worktree', () => {
    /* Given */
    const projects: Project[] = [
        {projectPath: LOCAL_SITE, folder: '-Users-joris-code-site', sessions: []},
        {projectPath: LOCAL_SITE + '/.claude/worktrees/x', folder: 'wt', sessions: []},
        {projectPath: VM_SITE, folder: 'site', sessions: [], remote: true, agent: true},
        {projectPath: VM_ROOT + '/.claude/worktrees/fix-42', folder: 'fix-42', sessions: [], remote: true, agent: true},
        {projectPath: 'ssh://dev@box/srv', folder: 'srv', sessions: [], remote: true},
    ];

    /* When */
    const candidates = routeCandidates(projects);

    /* Then */
    assert.deepEqual(
        candidates.map((candidate) => candidate.projectPath),
        [LOCAL_SITE, VM_SITE],
    );
});

// ── The phone ──

test("the phone's row of a VM session is labelled with its host", async () => {
    /* Given */
    const h = harness();
    await h.open(VM_SITE, 'vm-1');
    const phones = new PhoneSessionsService({
        registry: h.registry,
        running: {runningSessionIds: () => ['vm-1']},
        projects: {list: () => []},
        questions: {pending: () => [], answer: () => ({ok: true})},
        grill: {views: () => []},
        voice: {connected() {}, message() {}, disconnected() {}},
        battery: {connected() {}, disconnected() {}},
        clock: h.clock,
        timers: fakeTimers(),
        log: silentLog,
    } as unknown as PhoneSessionsServiceDeps);
    const phone = fakeDeviceConnection();

    /* When */
    phones.connected(phone, {id: 'phone-1', name: 'Pixel'});

    /* Then */
    const list = phone.sent.find((message) => message.type === 'sessions');
    assert.ok(list && list.type === 'sessions');
    assert.equal(list.sessions[0].remote, 'dev@vm.local');
});
