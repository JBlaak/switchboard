import { test } from 'node:test';
import assert from 'node:assert';
import { helloReply, isCompatibleProtocol } from '../src/domain/phone/compat';
import { CLOSE, PROTOCOL_VERSION } from '../src/domain/phone/protocol';

const MAC = { name: 'Joris MacBook', version: '2.9.0' };

test('an enrolled device on the same protocol is welcomed with its id', () => {
  /* When */
  const reply = helloReply(PROTOCOL_VERSION, { kind: 'device', deviceId: 'dev-1' }, MAC);

  /* Then */
  assert.deepStrictEqual(reply, {
    message: { type: 'welcome', protocol: PROTOCOL_VERSION, macName: 'Joris MacBook', deviceId: 'dev-1' },
    close: null,
  });
});

test('a pairing connection on the same protocol gets pairing', () => {
  /* When */
  const reply = helloReply(PROTOCOL_VERSION, { kind: 'pairing' }, MAC);

  /* Then */
  assert.deepStrictEqual(reply, {
    message: { type: 'pairing', protocol: PROTOCOL_VERSION, macName: 'Joris MacBook' },
    close: null,
  });
});

test('an older or newer app gets update-required and the update close, enrolled or pairing', () => {
  /* Given */
  const ours = 3;

  /* When */
  const older = helloReply(2, { kind: 'device', deviceId: 'dev-1' }, MAC, ours);
  const newer = helloReply(4, { kind: 'pairing' }, MAC, ours);

  /* Then */
  for (const reply of [older, newer]) {
    assert.deepStrictEqual(reply, {
      message: { type: 'update-required', protocol: 3, macVersion: '2.9.0' },
      close: CLOSE.updateRequired,
    });
  }
});

test('only the exact protocol number is compatible', () => {
  /* When */
  const results = [PROTOCOL_VERSION - 1, PROTOCOL_VERSION, PROTOCOL_VERSION + 1].map((v) => isCompatibleProtocol(v));

  /* Then */
  assert.deepStrictEqual(results, [false, true, false]);
});
