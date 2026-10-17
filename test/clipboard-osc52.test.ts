import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decodeOsc52Payload } from '../src/renderer/features/terminal/terminal-input';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

test('decodes a normal OSC 52 write into clipboard text', () => {
  /* Given */
  // "c" = clipboard selection; this is the path Claude Code's copy takes.
  const payload = `c;${b64('hello world')}`;

  /* When */
  const text = decodeOsc52Payload(payload);

  /* Then */
  assert.equal(text, 'hello world');
});

test('decodes multi-byte UTF-8 rather than mangling it', () => {
  /* Given */
  const payload = `c;${b64('안녕하세요 — café 🎉')}`;

  /* When */
  const text = decodeOsc52Payload(payload);

  /* Then */
  assert.equal(text, '안녕하세요 — café 🎉');
});

test('a read-back query is REFUSED, not answered', () => {
  // Security property, not an unimplemented case: answering "?" would write the
  // user's clipboard back into the terminal, letting any program in the session
  // exfiltrate whatever they last copied. null means "consume and stay silent".
  //
  // If you are here because you are implementing the query response: don't.
  /* Given */
  const queries = ['c;?', 'p;?', '?'];

  /* When */
  const answers = queries.map(q => decodeOsc52Payload(q));

  /* Then */
  assert.deepEqual(answers, [null, null, null]);
});

test('empty payloads write nothing', () => {
  /* Given */
  const payloads = ['', 'c;'];

  /* When */
  const written = payloads.map(p => decodeOsc52Payload(p));

  /* Then */
  assert.deepEqual(written, [null, null]);
});

test('a payload with no selection separator is treated as base64', () => {
  /* When */
  const text = decodeOsc52Payload(b64('bare'));

  /* Then */
  assert.equal(text, 'bare');
});

test('malformed base64 throws so the caller can report the sequence unhandled', () => {
  /* When */
  const act = () => decodeOsc52Payload('c;@@@not base64@@@');

  /* Then */
  assert.throws(act);
});
