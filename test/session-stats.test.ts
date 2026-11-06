import {test} from 'node:test';
import assert from 'node:assert';
import {
    LONG_CONTEXT_WINDOW,
    STANDARD_CONTEXT_WINDOW,
    contextFraction,
    contextWindowFor,
    lastContextUsage,
} from '../src/domain/session/stats';
import {SessionStatsService, type SessionStatsServiceDeps} from '../src/application/services/session-stats-service';
import {silentLog} from './support/fakes';

/** An assistant line reporting `usage`, as the CLI writes it. */
function assistant(usage: Record<string, number>, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
        type: 'assistant',
        cwd: '/repo',
        message: {model: 'claude-opus-5-5', role: 'assistant', usage, content: []},
        ...extra,
    });
}

const user = (cwd = '/repo') => JSON.stringify({type: 'user', cwd, message: {role: 'user', content: 'hi'}});

// ── The usage parse ──

test('the last assistant turn counts its input, cache-read and cache-creation tokens', () => {
    /* Given */
    const lines = [
        assistant({input_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 0, output_tokens: 5}),
        user(),
        assistant({
            input_tokens: 2,
            cache_read_input_tokens: 40_000,
            cache_creation_input_tokens: 8_000,
            output_tokens: 900,
        }),
    ];

    /* When */
    const usage = lastContextUsage(lines);

    /* Then */
    assert.deepStrictEqual(usage, {model: 'claude-opus-5-5', tokens: 48_002, peakTokens: 48_002});
});

test('a subagent turn and a turn the CLI made up are passed over', () => {
    /* Given */
    const lines = [
        assistant({input_tokens: 10, cache_read_input_tokens: 1000}),
        assistant({input_tokens: 99_000}, {isSidechain: true}),
        JSON.stringify({type: 'assistant', message: {model: '<synthetic>', usage: {input_tokens: 0}}}),
    ];

    /* When */
    const usage = lastContextUsage(lines);

    /* Then */
    assert.deepStrictEqual(usage, {model: 'claude-opus-5-5', tokens: 1010, peakTokens: 1010});
});

test('a transcript with no usage yet answers null, and a line cut off by the tail read is ignored', () => {
    /* Given */
    const lines = ['_tokens":12}}}', user()];

    /* When */
    const usage = lastContextUsage(lines);

    /* Then */
    assert.strictEqual(usage, null);
    assert.strictEqual(contextFraction(usage), null);
});

// ── The window choice ──

test('a model without [1m] is measured against 200k', () => {
    /* When */
    const window = contextWindowFor({model: 'claude-opus-5-5', tokens: 50_000, peakTokens: 50_000});

    /* Then */
    assert.strictEqual(window, STANDARD_CONTEXT_WINDOW);
});

test('a [1m] model is measured against 1M', () => {
    /* When */
    const window = contextWindowFor({model: 'claude-opus-5-5[1m]', tokens: 50_000, peakTokens: 50_000});

    /* Then */
    assert.strictEqual(window, LONG_CONTEXT_WINDOW);
});

test('a turn sent more than 200k tokens must have run in the 1M window', () => {
    /* When */
    const window = contextWindowFor({model: 'claude-opus-5-5', tokens: 229_123, peakTokens: 229_123});

    /* Then */
    assert.strictEqual(window, LONG_CONTEXT_WINDOW);
});

test('a session that once sent more than 200k stays in the 1M window after a compaction', () => {
    /* Given */
    const lines = [assistant({cache_read_input_tokens: 300_000}), assistant({cache_read_input_tokens: 40_000})];

    /* When */
    const fraction = contextFraction(lastContextUsage(lines));

    /* Then */
    assert.strictEqual(fraction, 0.04);
});

test('the context used is the turn tokens over the window', () => {
    /* When */
    const fraction = contextFraction({model: 'claude-sonnet-5[1m]', tokens: 250_000, peakTokens: 250_000});

    /* Then */
    assert.strictEqual(fraction, 0.25);
});

// ── The service ──

function harness(overrides: Partial<SessionStatsServiceDeps> & {tail?: string; branches?: Map<string, string>} = {}) {
    const branchAsks: string[] = [];
    const branches = overrides.branches ?? new Map([['/repo', 'main']]);
    const deps: SessionStatsServiceDeps = {
        locate: (id) => (id === 's1' ? {folder: '-repo', projectPath: '/repo'} : null),
        transcripts: {
            readTail: () => overrides.tail ?? '',
            readSession: () => null,
        },
        cached: () => ({messageCount: 12, created: '2026-11-06T09:00:00.000Z'}),
        openedAt: () => null,
        git: {
            currentBranch: async (dir) => {
                branchAsks.push(dir);
                return branches.get(dir) ?? null;
            },
        },
        shellName: () => null,
        agentlessRemote: () => false,
        log: silentLog,
        ...overrides,
    };
    return {service: new SessionStatsService(deps), branchAsks, branches};
}

test('a session with no usage yet answers null context, and its count and start from the session list', async () => {
    /* Given */
    const h = harness({tail: user()});

    /* When */
    const stats = await h.service.stats('s1');

    /* Then */
    assert.deepStrictEqual(stats, {
        contextUsed: null,
        messageCount: 12,
        startedAt: '2026-11-06T09:00:00.000Z',
        branch: 'main',
        shell: null,
    });
});

test('the context used comes from the last assistant turn in the transcript', async () => {
    /* Given */
    const h = harness({tail: [user(), assistant({input_tokens: 50_000})].join('\n')});

    /* When */
    const stats = await h.service.stats('s1');

    /* Then */
    assert.strictEqual(stats.contextUsed, 0.25);
});

test('a running session started when its terminal did', async () => {
    /* Given */
    const h = harness({openedAt: () => Date.parse('2026-11-06T10:30:00.000Z')});

    /* When */
    const stats = await h.service.stats('s1');

    /* Then */
    assert.strictEqual(stats.startedAt, '2026-11-06T10:30:00.000Z');
});

test('a session not indexed yet is counted from its transcript', async () => {
    /* Given */
    const h = harness({
        cached: () => null,
        transcripts: {
            readTail: () => '',
            readSession: () => ({messageCount: 3, created: '2026-11-06T08:00:00.000Z'}) as never,
        },
    });

    /* When */
    const stats = await h.service.stats('s1');

    /* Then */
    assert.strictEqual(stats.messageCount, 3);
    assert.strictEqual(stats.startedAt, '2026-11-06T08:00:00.000Z');
});

test('the branch is read where the transcript last wrote from, a worktree it moved into', async () => {
    /* Given */
    const h = harness({
        tail: [user('/repo'), user('/repo/.claude/worktrees/a')].join('\n'),
        branches: new Map([['/repo/.claude/worktrees/a', 'tray/session-stats']]),
    });

    /* When */
    const stats = await h.service.stats('s1');

    /* Then */
    assert.strictEqual(stats.branch, 'tray/session-stats');
    assert.deepStrictEqual(h.branchAsks, ['/repo/.claude/worktrees/a']);
});

test('a checkout shows on the next ask', async () => {
    /* Given */
    const h = harness();
    await h.service.stats('s1');
    h.branches.set('/repo', 'feature');

    /* When */
    const stats = await h.service.stats('s1');

    /* Then */
    assert.strictEqual(stats.branch, 'feature');
});

test('the shell is the profile the header names', async () => {
    /* Given */
    const h = harness({shellName: (projectPath) => (projectPath === '/repo' ? 'Fish' : null)});

    /* When */
    const stats = await h.service.stats('s1');

    /* Then */
    assert.strictEqual(stats.shell, 'Fish');
});

test('an agentless remote session answers what is known and null for the rest', async () => {
    /* Given */
    const h = harness({
        locate: () => ({folder: null, projectPath: 'ssh://me@box//srv/app'}),
        agentlessRemote: () => true,
        shellName: () => 'Fish',
    });

    /* When */
    const stats = await h.service.stats('s1');

    /* Then */
    assert.deepStrictEqual(stats, {
        contextUsed: null,
        messageCount: 12,
        startedAt: '2026-11-06T09:00:00.000Z',
        branch: null,
        shell: null,
    });
    assert.deepStrictEqual(h.branchAsks, []);
});

test('a read that fails leaves its field null and the rest answer', async () => {
    /* Given */
    const h = harness({
        transcripts: {
            readTail: () => {
                throw new Error('agent went away');
            },
            readSession: () => null,
        },
    });

    /* When */
    const stats = await h.service.stats('s1');

    /* Then */
    assert.strictEqual(stats.contextUsed, null);
    assert.strictEqual(stats.branch, 'main');
});

test('an unknown session answers all nulls', async () => {
    /* Given */
    const h = harness();

    /* When */
    const stats = await h.service.stats('nope');

    /* Then */
    assert.deepStrictEqual(stats, {contextUsed: null, messageCount: null, startedAt: null, branch: null, shell: null});
});
