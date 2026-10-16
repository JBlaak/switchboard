import { test } from 'node:test';
import assert from 'node:assert';
import { EVENT } from '../src/ipc/channels';
import { installIpcBridge } from '../src/renderer/app/ipc-bridge';
import type { SwitchboardApi } from '../src/ipc/api';
import type { RendererEvent } from '../src/renderer/state/events';

/** `onX` for each `EVENT.x`, the naming the api follows. */
const subscriberFor = (key: string) => 'on' + key[0].toUpperCase() + key.slice(1);

/**
 * A fake api whose `on*` record their callback and count their unsubscribes;
 * `push(key, ...args)` plays main sending on that channel.
 */
function fakeApi() {
  const callbacks = new Map<string, (...args: unknown[]) => void>();
  let unsubscribed = 0;
  const api: Record<string, unknown> = {};
  for (const key of Object.keys(EVENT)) {
    api[subscriberFor(key)] = (cb: (...args: unknown[]) => void) => {
      callbacks.set(key, cb);
      return () => { unsubscribed++; callbacks.delete(key); };
    };
  }
  return {
    api: api as unknown as SwitchboardApi,
    push: (key: keyof typeof EVENT, ...args: unknown[]) => callbacks.get(key)!(...args),
    subscribed: () => [...callbacks.keys()].sort(),
    unsubscribed: () => unsubscribed,
  };
}

test('the bridge subscribes to every push channel, and unsubscribes from all of them', () => {
  const fake = fakeApi();
  const off = installIpcBridge(fake.api, () => {}, () => {});
  assert.deepStrictEqual(fake.subscribed(), Object.keys(EVENT).sort());
  off();
  assert.strictEqual(fake.unsubscribed(), Object.keys(EVENT).length);
});

test('terminal data goes to the terminal, never to the store', () => {
  const fake = fakeApi();
  const sent: RendererEvent[] = [];
  const data: [string, string][] = [];
  installIpcBridge(fake.api, e => sent.push(e), (id, chunk) => data.push([id, chunk]));
  fake.push('terminalData', 's1', 'hello');
  assert.deepStrictEqual(data, [['s1', 'hello']]);
  assert.deepStrictEqual(sent, []);
});

test('each other push becomes its event', () => {
  const fake = fakeApi();
  const sent: RendererEvent[] = [];
  installIpcBridge(fake.api, e => sent.push(e), () => {});

  fake.push('processExited', 's1', 1);
  fake.push('sessionForked', 'a', 'b');
  fake.push('cliBusyState', 's1', true);
  fake.push('terminalNotification', 's1', 'hi');
  fake.push('sessionNeedsAttention', 's1');
  fake.push('sessionAgents', 's1', []);
  fake.push('remoteStatus', 's1', { phase: 'connected' });
  fake.push('questionsAsked', { toolUseId: 't' });
  fake.push('questionsSettled', { toolUseId: 't' });
  fake.push('projectsChanged');
  fake.push('statusUpdate', 'Scanning', 'active');
  fake.push('fullscreenChanged', true);
  fake.push('updateAvailable', { version: '1' });

  const remote = sent.find(e => e.type === 'remoteStatus');
  assert.ok(remote && typeof remote.receivedAt === 'number', 'stamped on arrival');
  assert.deepStrictEqual(sent.map(e => (e.type === 'remoteStatus' ? { ...e, receivedAt: 0 } : e)), [
    { type: 'processExited', sessionId: 's1', exitCode: 1 },
    { type: 'sessionForked', oldId: 'a', newId: 'b' },
    { type: 'cliBusyState', sessionId: 's1', busy: true },
    { type: 'terminalNotification', sessionId: 's1', message: 'hi' },
    { type: 'sessionNeedsAttention', sessionId: 's1' },
    { type: 'sessionAgents', sessionId: 's1', agents: [] },
    { type: 'remoteStatus', sessionId: 's1', status: { phase: 'connected' }, receivedAt: 0 },
    { type: 'questionsAsked', pending: { toolUseId: 't' } },
    { type: 'questionsSettled', settled: { toolUseId: 't' } },
    { type: 'projectsChanged' },
    { type: 'statusUpdate', text: 'Scanning', kind: 'active' },
    { type: 'fullscreenChanged', isFullscreen: true },
    { type: 'updateAvailable', update: { version: '1' } },
  ]);
});
