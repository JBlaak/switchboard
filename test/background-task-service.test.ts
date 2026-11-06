import {test} from 'node:test';
import assert from 'node:assert';
import {BackgroundTaskService} from '../src/application/services/background-task-service';
import {ActiveSession} from '../src/application/model/active-session';
import {fakePty, fakeRenderer, silentLog} from './support/fakes';

const AT = '2026-11-06T10:00:00.000Z';

/** A transcript tail in which Claude started `command` in the background as task `id`. */
function launched(id: string, command: string): string {
    return [
        JSON.stringify({
            type: 'assistant',
            timestamp: AT,
            message: {content: [{type: 'tool_use', id: 'tu-' + id, name: 'Bash', input: {command, description: id}}]},
        }),
        JSON.stringify({
            type: 'user',
            timestamp: AT,
            message: {content: [{type: 'tool_result', tool_use_id: 'tu-' + id}]},
            toolUseResult: {backgroundTaskId: id},
        }),
    ].join('\n');
}

function harness(tail = '', extra: Partial<ActiveSession> = {}) {
    const renderer = fakeRenderer();
    const reads: [string, string][] = [];
    const transcripts = {
        tail,
        readTail(folder: string, sessionId: string): string {
            reads.push([folder, sessionId]);
            return this.tail;
        },
    };
    const service = new BackgroundTaskService({transcripts, renderer, log: silentLog});
    const session = new ActiveSession({
        pty: fakePty(),
        projectPath: '/repo',
        projectFolder: '-repo',
        knownTranscriptIds: new Set(),
        sessionSlug: null,
        isPlainTerminal: false,
        remote: null,
        openedAt: 0,
    });
    Object.assign(session, extra);
    const pushed = () => renderer.only('sessionBackgroundTasks').map(([, id, tasks]) => [id, tasks]);
    return {service, session, transcripts, reads, pushed};
}

test('a turn that ends with a background shell running pushes it, a watch by its command', () => {
    /* Given */
    const h = harness(launched('b1', 'gh pr checks 7 --watch'));

    /* When */
    h.service.cliStateChanged('s1', h.session, {kind: 'busy', busy: false});

    /* Then */
    assert.deepStrictEqual(h.reads, [['-repo', 's1']]);
    assert.deepStrictEqual(h.pushed(), [['s1', [{id: 'b1', description: 'b1', watch: true}]]]);
});

test('a turn that ends with nothing in the background pushes nothing', () => {
    /* Given */
    const h = harness('');

    /* When */
    h.service.cliStateChanged('s1', h.session, {kind: 'busy', busy: false});

    /* Then */
    assert.deepStrictEqual(h.pushed(), []);
});

test('the same tasks at the next turn end are not pushed again', () => {
    /* Given */
    const h = harness(launched('b1', 'npm test'));
    h.service.cliStateChanged('s1', h.session, {kind: 'busy', busy: false});

    /* When */
    h.service.cliStateChanged('s1', h.session, {kind: 'busy', busy: false});

    /* Then */
    assert.strictEqual(h.pushed().length, 1);
});

test('a turn starting clears the tasks', () => {
    /* Given */
    const h = harness(launched('b1', 'npm test'));
    h.service.cliStateChanged('s1', h.session, {kind: 'busy', busy: false});

    /* When */
    h.service.cliStateChanged('s1', h.session, {kind: 'busy', busy: true});

    /* Then */
    assert.deepStrictEqual(h.pushed().at(-1), ['s1', []]);
});

test('a plain terminal has no transcript to read', () => {
    /* Given */
    const h = harness(launched('b1', 'npm test'), {isPlainTerminal: true});

    /* When */
    h.service.cliStateChanged('s1', h.session, {kind: 'busy', busy: false});

    /* Then */
    assert.deepStrictEqual(h.reads, []);
    assert.deepStrictEqual(h.pushed(), []);
});

test('a block on the user reads nothing', () => {
    /* Given */
    const h = harness(launched('b1', 'npm test'));

    /* When */
    h.service.cliStateChanged('s1', h.session, {kind: 'needs-attention'});

    /* Then */
    assert.deepStrictEqual(h.reads, []);
});
