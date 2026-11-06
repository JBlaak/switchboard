import {test} from 'node:test';
import assert from 'node:assert/strict';

import {ActiveSession} from '../src/application/model/active-session';
import {SessionRegistry} from '../src/application/model/session-registry';
import {
    CHAT_FIRST_READ_BYTES,
    MAX_CHAT_MESSAGES,
    PhoneChatService,
} from '../src/application/services/phone-chat-service';
import {fakeDeviceConnection, fakePty, fakeTimers, silentLog} from './support/fakes';
import type {TranscriptStore} from '../src/application/ports/transcript-store';

/**
 * The phone's chat view: a subscribed session's transcript sent as messages,
 * whole on subscribe and then as it grows, read from where the last read
 * stopped. Driven against transcripts held in memory as bytes, as the file
 * store reads them.
 */

const FOLDER = '-code-app';

const prompt = (uuid: string, text: string): string =>
    JSON.stringify({type: 'user', uuid, message: {role: 'user', content: text}}) + '\n';
const reply = (uuid: string, text: string): string =>
    JSON.stringify({type: 'assistant', uuid, message: {role: 'assistant', content: [{type: 'text', text}]}}) + '\n';

function harness() {
    const registry = new SessionRegistry();
    const timers = fakeTimers();
    const files = new Map<string, Buffer>();
    const transcripts: Pick<TranscriptStore, 'readFrom'> = {
        readFrom(folder, sessionId, start, byteLimit) {
            const file = files.get(`${folder}/${sessionId}`);
            if (!file) return null;
            const from = Math.min(start, file.length);
            return {text: file.subarray(from, from + byteLimit).toString('utf8'), size: file.length};
        },
    };
    const service = new PhoneChatService({registry, transcripts, timers, log: silentLog});

    const addSession = (id: string, fields: {folder?: string | null; plain?: boolean} = {}): void => {
        registry.add(
            id,
            new ActiveSession({
                pty: fakePty(),
                projectPath: '/code/app',
                projectFolder: fields.folder === undefined ? FOLDER : fields.folder,
                knownTranscriptIds: new Set(),
                sessionSlug: null,
                isPlainTerminal: fields.plain ?? false,
                remote: null,
                openedAt: 0,
            }),
        );
    };
    const write = (sessionId: string, text: string): void => {
        const key = `${FOLDER}/${sessionId}`;
        files.set(key, Buffer.concat([files.get(key) ?? Buffer.alloc(0), Buffer.from(text)]));
    };
    const replace = (sessionId: string, text: string): void => {
        files.set(`${FOLDER}/${sessionId}`, Buffer.from(text));
    };
    return {service, registry, timers, addSession, write, replace};
}

test('subscribing sends the conversation so far', () => {
    /* Given */
    const h = harness();
    h.addSession('s1');
    h.write('s1', prompt('u1', 'Fix the login') + reply('a1', 'Done.'));
    const phone = fakeDeviceConnection();

    /* When */
    h.service.message(phone, {type: 'chat-subscribe', sessionId: 's1'});

    /* Then */
    assert.deepEqual(phone.sent, [
        {
            type: 'chat',
            sessionId: 's1',
            available: true,
            messages: [
                {id: 'u1:0', role: 'user', text: 'Fix the login'},
                {id: 'a1:0', role: 'assistant', text: 'Done.'},
            ],
        },
    ]);
});

test('what the transcript gains is appended, once', () => {
    /* Given */
    const h = harness();
    h.addSession('s1');
    h.write('s1', prompt('u1', 'Fix the login'));
    const phone = fakeDeviceConnection();
    h.service.message(phone, {type: 'chat-subscribe', sessionId: 's1'});
    phone.clear();

    /* When */
    h.write('s1', reply('a1', 'Done.'));
    h.timers.tick();
    h.timers.tick();

    /* Then */
    assert.deepEqual(phone.sent, [
        {type: 'chat-append', sessionId: 's1', messages: [{id: 'a1:0', role: 'assistant', text: 'Done.'}]},
    ]);
});

test('a line still being written is appended once it is whole', () => {
    /* Given */
    const h = harness();
    h.addSession('s1');
    const phone = fakeDeviceConnection();
    h.service.message(phone, {type: 'chat-subscribe', sessionId: 's1'});
    const whole = reply('a1', 'Café ✓');
    h.write('s1', whole.slice(0, 20));
    h.timers.tick();
    phone.clear();

    /* When */
    h.write('s1', whole.slice(20));
    h.timers.tick();

    /* Then */
    assert.deepEqual(phone.of('chat-append'), [
        {type: 'chat-append', sessionId: 's1', messages: [{id: 'a1:0', role: 'assistant', text: 'Café ✓'}]},
    ]);
});

test('a long transcript is read from its end, and only its latest messages are sent', () => {
    /* Given */
    const h = harness();
    h.addSession('s1');
    const padding = 'x'.repeat(1000);
    let text = '';
    let count = 0;
    while (text.length < CHAT_FIRST_READ_BYTES + 100_000) text += reply(`a${count}`, `${count++} ${padding}`);
    h.write('s1', text);
    const phone = fakeDeviceConnection();

    /* When */
    h.service.message(phone, {type: 'chat-subscribe', sessionId: 's1'});

    /* Then */
    const [chat] = phone.of('chat');
    assert.equal(chat.messages.length, MAX_CHAT_MESSAGES);
    assert.equal(chat.messages.at(-1)?.id, `a${count - 1}:0`);
});

test('a session without a transcript on this Mac has no chat', () => {
    /* Given */
    const h = harness();
    h.addSession('vm', {folder: null});
    h.addSession('term', {plain: true});
    const phone = fakeDeviceConnection();

    /* When */
    h.service.message(phone, {type: 'chat-subscribe', sessionId: 'vm'});
    h.service.message(phone, {type: 'chat-subscribe', sessionId: 'term'});
    h.service.message(phone, {type: 'chat-subscribe', sessionId: 'gone'});

    /* Then */
    assert.deepEqual(
        phone.sent.map((message) => message.type === 'chat' && [message.sessionId, message.available]),
        [
            ['vm', false],
            ['term', false],
            ['gone', false],
        ],
    );
    assert.equal(h.timers.pending, 0);
});

test('a session not written yet starts empty and fills in', () => {
    /* Given */
    const h = harness();
    h.addSession('s1');
    const phone = fakeDeviceConnection();
    h.service.message(phone, {type: 'chat-subscribe', sessionId: 's1'});

    /* When */
    h.write('s1', prompt('u1', 'Hello'));
    h.timers.tick();

    /* Then */
    assert.deepEqual(phone.sent, [
        {type: 'chat', sessionId: 's1', available: true, messages: []},
        {type: 'chat-append', sessionId: 's1', messages: [{id: 'u1:0', role: 'user', text: 'Hello'}]},
    ]);
});

test('a transcript that shrank is sent whole again', () => {
    /* Given */
    const h = harness();
    h.addSession('s1');
    h.write('s1', prompt('u1', 'One') + prompt('u2', 'Two'));
    const phone = fakeDeviceConnection();
    h.service.message(phone, {type: 'chat-subscribe', sessionId: 's1'});
    phone.clear();

    /* When */
    h.replace('s1', prompt('u3', 'Three'));
    h.timers.tick();

    /* Then */
    assert.deepEqual(phone.sent, [
        {type: 'chat', sessionId: 's1', available: true, messages: [{id: 'u3:0', role: 'user', text: 'Three'}]},
    ]);
});

test('a re-keyed session starts over from its new transcript, under its new id', () => {
    /* Given */
    const h = harness();
    h.addSession('old');
    h.write('old', prompt('u1', 'Plan it'));
    h.write('new', prompt('u2', 'Build the plan'));
    const phone = fakeDeviceConnection();
    h.service.message(phone, {type: 'chat-subscribe', sessionId: 'old'});
    phone.clear();

    /* When */
    h.service.sessionForked('old', 'new');

    /* Then */
    assert.deepEqual(phone.sent, [
        {
            type: 'chat',
            sessionId: 'new',
            available: true,
            messages: [{id: 'u2:0', role: 'user', text: 'Build the plan'}],
        },
    ]);
});

test('nothing is read once the phone unsubscribes or goes', () => {
    /* Given */
    const h = harness();
    h.addSession('s1');
    h.addSession('s2');
    const phone = fakeDeviceConnection('conn-1');
    const other = fakeDeviceConnection('conn-2', 'phone-2');
    h.service.message(phone, {type: 'chat-subscribe', sessionId: 's1'});
    h.service.message(other, {type: 'chat-subscribe', sessionId: 's2'});

    /* When */
    h.service.message(phone, {type: 'chat-unsubscribe', sessionId: 's1'});
    h.service.disconnected(other);

    /* Then */
    assert.equal(h.timers.pending, 0);
});
