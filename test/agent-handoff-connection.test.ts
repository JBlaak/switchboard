import {test} from 'node:test';
import assert from 'node:assert/strict';

import {AgentConnection} from '../src/application/services/agent-client/agent-connection';
import {fakeTimers, silentLog} from './support/fakes';
import {scriptedAgent, settle} from './support/scripted-agent';

/**
 * The link's stage 2 requests (#276): uploads in chunks, and a hand-off whose
 * progress lines arrive before its answer.
 */

function harness() {
    const agent = scriptedAgent();
    const timers = fakeTimers();
    const connection = new AgentConnection({
        host: {user: 'dev', host: 'vm.local', port: 22},
        dialer: agent.dialer,
        appVersion: '2.12.0',
        timers,
        clock: {now: () => 0},
        log: silentLog,
    });
    return {agent, timers, connection};
}

test('an upload sends begin, its chunks in order and end with the hash, and answers its id', async () => {
    /* Given */
    const h = harness();
    await h.connection.whenConnected();
    const bytes = Buffer.from('0123456789');

    /* When */
    const uploaded = h.connection.upload(bytes, {sha256: 'f'.repeat(64), chunkBytes: 4});
    await settle();
    const [end] = h.agent.sent('upload-end');
    h.agent.send({type: 'done', requestId: end.requestId, ok: true});
    const uploadId = await uploaded;

    /* Then */
    assert.deepEqual(h.agent.sent('upload-begin'), [{type: 'upload-begin', uploadId, size: 10}]);
    assert.deepEqual(
        h.agent.sent('upload-chunk').map((chunk) => Buffer.from(chunk.dataBase64, 'base64').toString()),
        ['0123', '4567', '89'],
    );
    assert.equal(end.uploadId, uploadId);
    assert.equal(end.sha256, 'f'.repeat(64));
});

test('an upload the agent refuses rejects with its reason', async () => {
    /* Given */
    const h = harness();
    await h.connection.whenConnected();

    /* When */
    const uploaded = h.connection.upload(Buffer.from('x'), {sha256: '0'.repeat(64)});
    await settle();
    const [end] = h.agent.sent('upload-end');
    h.agent.send({type: 'done', requestId: end.requestId, ok: false, error: 'hash mismatch'});

    /* Then */
    await assert.rejects(uploaded, /hash mismatch/);
});

test("a hand-off's progress lines go to its listener and its answer still settles it", async () => {
    /* Given */
    const h = harness();
    await h.connection.whenConnected();
    const lines: string[] = [];

    /* When */
    const done = h.connection.handoff(
        {repo: {name: 'site', origin: 'git@github.com:joris/site.git'}, branch: 'main', headOid: 'abc', files: []},
        (line) => lines.push(line),
    );
    await settle();
    const [handoff] = h.agent.sent('handoff');
    h.agent.send({type: 'handoff-progress', requestId: handoff.requestId, line: 'Cloning'});
    h.agent.send({type: 'handoff-progress', requestId: 'r999', line: 'someone else'});
    h.agent.send({type: 'handoff-progress', requestId: handoff.requestId, line: 'Applying'});
    h.agent.send({type: 'handoff-done', requestId: handoff.requestId, ok: true, dir: '~/projects/site'});

    /* Then */
    assert.deepEqual(await done, {
        type: 'handoff-done',
        requestId: handoff.requestId,
        ok: true,
        dir: '~/projects/site',
    });
    assert.deepEqual(lines, ['Cloning', 'Applying']);
});

test('a hand-off fails when the link drops before its answer', async () => {
    /* Given */
    const h = harness();
    await h.connection.whenConnected();
    const done = h.connection.handoff({repo: {name: 'site', origin: 'o'}, branch: 'main', headOid: 'abc', files: []});
    await settle();

    /* When */
    h.agent.current().drop('Connection reset by peer');

    /* Then */
    await assert.rejects(done, /dropped/);
});

test('copy status, push and remove are answered by request id', async () => {
    /* Given */
    const h = harness();
    await h.connection.whenConnected();

    /* When */
    const status = h.connection.copyStatus('~/projects/site');
    const pushed = h.connection.pushBranch('~/projects/site', 'feature');
    const removed = h.connection.removeCopy('~/projects/site');
    await settle();
    const [ask] = h.agent.sent('copy-status');
    const [push] = h.agent.sent('push-branch');
    const [remove] = h.agent.sent('remove-copy');
    h.agent.send({type: 'done', requestId: remove.requestId, ok: true});
    h.agent.send({type: 'done', requestId: push.requestId, ok: false, error: 'rejected'});
    h.agent.send({
        type: 'copy-state',
        requestId: ask.requestId,
        ok: true,
        branch: 'feature',
        unpushed: [],
        uncommitted: [],
    });

    /* Then */
    assert.equal((await status).branch, 'feature');
    assert.deepEqual(await pushed, {type: 'done', requestId: push.requestId, ok: false, error: 'rejected'});
    assert.equal((await removed).ok, true);
    assert.deepEqual(
        [ask.dir, push.dir, push.branch, remove.dir],
        ['~/projects/site', '~/projects/site', 'feature', '~/projects/site'],
    );
});
