import { test } from 'node:test';
import assert from 'node:assert';
import {
  decodeTerminalFrame, encodeInvite, encodeTerminalFrame, MAX_MESSAGE_CHARS, parseClientMessage, parseInvite,
} from '../src/domain/phone/codec';
import type { ClientMessage, PairingInvite } from '../src/domain/phone/protocol';

/** One of every message, the way a well-behaved phone sends it. */
const EVERY_MESSAGE: ClientMessage[] = [
  { type: 'hello', protocol: 1, appVersion: '2.9.0' },
  { type: 'pair', code: '23456789', deviceName: 'Pixel 9 Pro' },
  { type: 'attach', sessionId: 's1', cols: 48, rows: 30 },
  { type: 'detach', sessionId: 's1' },
  { type: 'size', sessionId: 's1', cols: 80, rows: 24 },
  { type: 'use-here', sessionId: 's1' },
  { type: 'input', sessionId: 's1', data: 'fix the bug\r' },
  { type: 'answer', sessionId: 's1', toolUseId: 'tu1', answers: { 'Which one?': 'A, B', 'Anything else?': '' } },
  { type: 'ask', requestId: 'r1', text: 'add dark mode to the settings page' },
  { type: 'ask-cancel', requestId: 'r1' },
  { type: 'ask-start', requestId: 'r1', projectPath: '/Users/joris/Development/switchboard', prompt: 'Add dark mode' },
  { type: 'list-projects' },
];

/** Each message with one field broken, per field and per way it can break. */
const MALFORMED: Record<string, unknown[]> = {
  hello: [
    { type: 'hello', appVersion: '2.9.0' },
    { type: 'hello', protocol: '1', appVersion: '2.9.0' },
    { type: 'hello', protocol: 1.5, appVersion: '2.9.0' },
    { type: 'hello', protocol: 0, appVersion: '2.9.0' },
    { type: 'hello', protocol: 1 },
    { type: 'hello', protocol: 1, appVersion: '' },
    { type: 'hello', protocol: 1, appVersion: 'x'.repeat(65) },
  ],
  pair: [
    { type: 'pair', deviceName: 'Pixel' },
    { type: 'pair', code: 12345678, deviceName: 'Pixel' },
    { type: 'pair', code: 'x'.repeat(65), deviceName: 'Pixel' },
    { type: 'pair', code: '23456789' },
    { type: 'pair', code: '23456789', deviceName: '   ' },
    { type: 'pair', code: '23456789', deviceName: 'x'.repeat(101) },
  ],
  attach: [
    { type: 'attach', cols: 48, rows: 30 },
    { type: 'attach', sessionId: '', cols: 48, rows: 30 },
    { type: 'attach', sessionId: 'x'.repeat(257), cols: 48, rows: 30 },
    { type: 'attach', sessionId: 's1', rows: 30 },
    { type: 'attach', sessionId: 's1', cols: 0, rows: 30 },
    { type: 'attach', sessionId: 's1', cols: 48.5, rows: 30 },
    { type: 'attach', sessionId: 's1', cols: 48, rows: 1001 },
    { type: 'attach', sessionId: 's1', cols: 48, rows: '30' },
  ],
  detach: [{ type: 'detach' }, { type: 'detach', sessionId: 7 }],
  size: [
    { type: 'size', sessionId: 's1', cols: -1, rows: 24 },
    { type: 'size', sessionId: 's1', cols: 80 },
    { type: 'size', cols: 80, rows: 24 },
  ],
  'use-here': [{ type: 'use-here' }, { type: 'use-here', sessionId: null }],
  input: [
    { type: 'input', sessionId: 's1' },
    { type: 'input', sessionId: 's1', data: '' },
    { type: 'input', sessionId: 's1', data: ['a'] },
    { type: 'input', sessionId: 's1', data: 'x'.repeat(100_001) },
    { type: 'input', data: 'hi' },
  ],
  answer: [
    { type: 'answer', toolUseId: 'tu1', answers: { q: 'a' } },
    { type: 'answer', sessionId: 's1', answers: { q: 'a' } },
    { type: 'answer', sessionId: 's1', toolUseId: 'tu1' },
    { type: 'answer', sessionId: 's1', toolUseId: 'tu1', answers: {} },
    { type: 'answer', sessionId: 's1', toolUseId: 'tu1', answers: ['a'] },
    { type: 'answer', sessionId: 's1', toolUseId: 'tu1', answers: { q: 1 } },
    { type: 'answer', sessionId: 's1', toolUseId: 'tu1', answers: { q: ['a', 'b'] } },
    { type: 'answer', sessionId: 's1', toolUseId: 'tu1', answers: JSON.parse('{"__proto__": "a"}') },
    { type: 'answer', sessionId: 's1', toolUseId: 'tu1', answers: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`q${i}`, 'a'])) },
  ],
  ask: [
    { type: 'ask', text: 'hi' },
    { type: 'ask', requestId: 'r1' },
    { type: 'ask', requestId: 'r1', text: '  ' },
    { type: 'ask', requestId: 'r1', text: 'x'.repeat(100_001) },
  ],
  'ask-cancel': [{ type: 'ask-cancel' }, { type: 'ask-cancel', requestId: '' }],
  'ask-start': [
    { type: 'ask-start', projectPath: '/p', prompt: 'hi' },
    { type: 'ask-start', requestId: 'r1', prompt: 'hi' },
    { type: 'ask-start', requestId: 'r1', projectPath: '/p' },
    { type: 'ask-start', requestId: 'r1', projectPath: 'x'.repeat(4097), prompt: 'hi' },
  ],
};

test('every client message round-trips through JSON', () => {
  /* Given */
  const texts = EVERY_MESSAGE.map((message) => JSON.stringify(message));

  /* When */
  const parsed = texts.map(parseClientMessage);

  /* Then */
  assert.deepStrictEqual(parsed, EVERY_MESSAGE);
});

test('the malformed cases cover every message type', () => {
  /* Given */
  const types = EVERY_MESSAGE.map((message) => message.type).filter((type) => type !== 'list-projects');

  /* When */
  const covered = Object.keys(MALFORMED);

  /* Then */
  assert.deepStrictEqual(covered.sort(), types.sort());
});

for (const [type, cases] of Object.entries(MALFORMED)) {
  test(`a malformed ${type} is rejected`, () => {
    /* Given */
    const texts = cases.map((raw) => JSON.stringify(raw));

    /* When */
    const parsed = texts.map(parseClientMessage);

    /* Then */
    parsed.forEach((result, i) => assert.strictEqual(result, null, `case ${i}: ${texts[i].slice(0, 120)}`));
  });
}

test('anything that is not a known message object is rejected', () => {
  /* Given */
  const texts = [
    '', 'not json', '{', 'null', '42', '"hello"', '[]',
    JSON.stringify([{ type: 'hello', protocol: 1, appVersion: '1' }]),
    JSON.stringify({}),
    JSON.stringify({ type: 'welcome', protocol: 1, macName: 'm', deviceId: 'd' }),
    JSON.stringify({ type: 'HELLO', protocol: 1, appVersion: '1' }),
    JSON.stringify({ type: 7 }),
  ];

  /* When */
  const parsed = texts.map(parseClientMessage);

  /* Then */
  parsed.forEach((result, i) => assert.strictEqual(result, null, `case ${i}: ${texts[i]}`));
});

test('a frame larger than any real message is rejected before parsing', () => {
  /* Given */
  const text = JSON.stringify({ type: 'list-projects', padding: 'x'.repeat(MAX_MESSAGE_CHARS) });

  /* When */
  const parsed = parseClientMessage(text);

  /* Then */
  assert.strictEqual(parsed, null);
});

test('unknown fields are dropped, not passed on', () => {
  /* Given */
  const text = JSON.stringify({ type: 'use-here', sessionId: 's1', extra: 'ignored' });

  /* When */
  const parsed = parseClientMessage(text);

  /* Then */
  assert.deepStrictEqual(parsed, { type: 'use-here', sessionId: 's1' });
});

test('terminal frames round-trip, multi-byte session ids and output included', () => {
  /* Given */
  const cases = [
    { sessionId: 's1', data: 'plain output\r\n' },
    { sessionId: 'sessie-ü-日本-🚀', data: '\x1b[1;32m✔ klaar\x1b[0m — 👍 ünïcödé 中文\r\n' },
    { sessionId: 'x'.repeat(300), data: '' },
  ];

  /* When */
  const decoded = cases.map(({ sessionId, data }) => decodeTerminalFrame(encodeTerminalFrame(sessionId, data)));

  /* Then */
  assert.deepStrictEqual(decoded, cases);
});

test('a terminal frame starts with the session id byte length as a big-endian u16', () => {
  /* Given */
  const sessionId = 'é'.repeat(200);

  /* When */
  const frame = encodeTerminalFrame(sessionId, 'ab');

  /* Then */
  assert.strictEqual(frame[0], 400 >> 8);
  assert.strictEqual(frame[1], 400 & 0xff);
  assert.strictEqual(frame.length, 2 + 400 + 2);
  assert.deepStrictEqual([...frame.subarray(402)], [0x61, 0x62]);
});

test('a session id too long for the header is refused when encoding', () => {
  /* Given */
  const sessionId = 'x'.repeat(0x10000);

  /* When */
  const encode = () => encodeTerminalFrame(sessionId, 'a');

  /* Then */
  assert.throws(encode);
});

test('broken terminal frames decode to null', () => {
  /* Given */
  const frames = [
    new Uint8Array([]),
    new Uint8Array([0]),
    new Uint8Array([0, 0, 0x61]),
    new Uint8Array([0, 5, 0x61, 0x62]),
    new Uint8Array([0, 1, 0xff, 0x61]),
    new Uint8Array([0, 1, 0x61, 0xc3]),
  ];

  /* When */
  const decoded = frames.map(decodeTerminalFrame);

  /* Then */
  assert.deepStrictEqual(decoded, [null, null, null, null, null, null]);
});

const INVITE: PairingInvite = {
  protocol: 1,
  fingerprint: 'a'.repeat(32) + '0123456789abcdef'.repeat(2),
  code: 'K7M2Q9XZ',
  host: 'joris-mbp.local',
  port: 52817,
};

test('an invite round-trips through the QR code text', () => {
  /* When */
  const text = encodeInvite(INVITE);

  /* Then */
  assert.strictEqual(text, `switchboard://pair?v=1&fp=${INVITE.fingerprint}&code=K7M2Q9XZ&host=joris-mbp.local&port=52817`);
  assert.deepStrictEqual(parseInvite(text), INVITE);
});

test('an invite with any part missing or malformed is rejected', () => {
  /* Given */
  const good = encodeInvite(INVITE);
  const texts = [
    good.replace('switchboard://', 'https://'),
    good.replace('&port=52817', ''),
    good.replace('v=1&', ''),
    good.replace('v=1', 'v=one'),
    good.replace('v=1', 'v=0'),
    good.replace(INVITE.fingerprint, INVITE.fingerprint.slice(1)),
    good.replace(INVITE.fingerprint, INVITE.fingerprint.toUpperCase()),
    good.replace(INVITE.fingerprint, INVITE.fingerprint.replace(/(..)/g, '$1:').slice(0, -1)),
    good.replace('code=K7M2Q9XZ', 'code='),
    good.replace('joris-mbp.local', ''),
    good.replace('joris-mbp.local', 'evil.local%2Fpath'),
    good.replace('52817', '0'),
    good.replace('52817', '65536'),
    good.replace('52817', '52817.5'),
    good + '&port=1234',
    '',
  ];

  /* When */
  const parsed = texts.map(parseInvite);

  /* Then */
  parsed.forEach((result, i) => assert.strictEqual(result, null, `case ${i}: ${texts[i]}`));
});

test('an invite to an IPv4 address parses', () => {
  /* Given */
  const text = encodeInvite({ ...INVITE, host: '192.168.1.20' });

  /* When */
  const parsed = parseInvite(text);

  /* Then */
  assert.strictEqual(parsed?.host, '192.168.1.20');
});
