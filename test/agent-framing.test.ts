import {test} from 'node:test';
import assert from 'node:assert/strict';

import {encodeMessageFrame, encodeOutputFrame, FrameDecoder, MAX_FRAME_BYTES} from '../src/domain/agent/framing';
import {linkPair} from './support/agent-link';
import type {AgentMessage, MacMessage, TerminalOutput} from '../src/domain/agent/protocol';

/**
 * The agent link's framing: messages and output survive the byte stream
 * however ssh happens to split or join it.
 */

const HELLO: MacMessage = {type: 'hello', protocol: 1, appVersion: '2.12.0'};
const OUTPUT: TerminalOutput = {
    sessionId: '3f2a9c1e-0b7d-4e5f-9a61-2c8d7e4b1a00',
    seq: 41,
    data: 'héllo ✳ \x1b[1mbold\x1b[0m',
};

test('a message and an output chunk come back as they were sent', () => {
    /* Given */
    const decoder = new FrameDecoder();

    /* When */
    const frames = decoder.push(Buffer.concat([encodeMessageFrame(HELLO), encodeOutputFrame(OUTPUT)]));

    /* Then */
    assert.deepEqual(frames, [
        {kind: 'message', message: HELLO},
        {kind: 'output', output: OUTPUT},
    ]);
});

test('frames split at every byte still decode once, whole', () => {
    /* Given */
    const bytes = Buffer.concat([encodeOutputFrame(OUTPUT), encodeMessageFrame(HELLO)]);
    const decoder = new FrameDecoder();

    /* When */
    const frames = [];
    for (let i = 0; i < bytes.length; i++) frames.push(...decoder.push(bytes.subarray(i, i + 1)));

    /* Then */
    assert.deepEqual(frames, [
        {kind: 'output', output: OUTPUT},
        {kind: 'message', message: HELLO},
    ]);
});

test('a length past the limit is refused rather than buffered', () => {
    /* Given */
    const header = Buffer.alloc(4);
    header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);

    /* When */
    const pushing = () => new FrameDecoder().push(header);

    /* Then */
    assert.throws(pushing, /too large/);
});

test('an unknown frame kind is refused', () => {
    /* Given */
    const frame = Buffer.from([0, 0, 0, 1, 7]);

    /* When */
    const pushing = () => new FrameDecoder().push(frame);

    /* Then */
    assert.throws(pushing, /unknown frame kind/);
});

test('the in-memory link carries both directions and closes both ends', () => {
    /* Given */
    const pair = linkPair();
    const atAgent: MacMessage[] = [];
    const atMac: (AgentMessage | TerminalOutput)[] = [];
    const closes: string[] = [];
    pair.agent.onMessage((m) => atAgent.push(m));
    pair.mac.onMessage((m) => atMac.push(m));
    pair.mac.onOutput((o) => atMac.push(o));
    pair.mac.onClose((r) => closes.push(r));

    /* When */
    pair.mac.send(HELLO);
    pair.agent.send({
        type: 'welcome',
        protocol: 1,
        agentVersion: '2.12.0',
        settings: {instructions: '', copyConfig: true, baseFolder: '~/projects'},
    });
    pair.agent.sendOutput(OUTPUT);
    pair.drop('lost');
    pair.mac.send(HELLO);

    /* Then */
    assert.deepEqual(atAgent, [HELLO]);
    assert.equal(atMac.length, 2);
    assert.deepEqual(atMac[1], OUTPUT);
    assert.deepEqual(closes, ['lost']);
    assert.equal(pair.agent.closed, true);
});
