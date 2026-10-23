import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { WHISPER_MODEL_FILE, WhisperModelStore } from '../src/infrastructure/voice/whisper-model-store';
import { silentLog } from './support/fakes';

/**
 * Fetching Whisper's model, against a local server: the file only appears
 * once it is whole, with progress on the way.
 */

async function server(handler: http.RequestListener): Promise<{ url: string; close(): void }> {
  const listening = http.createServer(handler);
  await new Promise<void>(resolve => listening.listen(0, '127.0.0.1', resolve));
  const { port } = listening.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/model.bin`, close: () => listening.close() };
}

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'voice-model-'));

test('the model is downloaded with progress and renamed into place once whole', async (t) => {
  /* Given */
  const body = Buffer.alloc(200_000, 7);
  const s = await server((_req, res) => {
    res.writeHead(200, { 'content-length': String(body.length) });
    res.end(body);
  });
  t.after(() => s.close());
  const directory = path.join(tempDir(), 'voice');
  const store = new WhisperModelStore({ directory, log: silentLog, url: s.url });
  const progress: (number | null)[] = [];
  const before = await store.present();

  /* When */
  await store.download(value => progress.push(value));

  /* Then */
  assert.equal(before, false);
  assert.equal(await store.present(), true);
  assert.equal(store.path, path.join(directory, WHISPER_MODEL_FILE));
  assert.deepEqual(fs.readFileSync(store.path), body);
  assert.deepEqual(fs.readdirSync(directory), [WHISPER_MODEL_FILE]);
  assert.equal(progress[0], 0);
  assert.equal(progress.at(-1), 1);
});

test('a failed download rejects and leaves nothing behind', async (t) => {
  /* Given */
  const s = await server((_req, res) => {
    res.writeHead(200, { 'content-length': '100000' });
    res.write(Buffer.alloc(1000));
    res.destroy();
  });
  t.after(() => s.close());
  const directory = tempDir();
  const store = new WhisperModelStore({ directory, log: silentLog, url: s.url });

  /* When */
  const failed = await store.download(() => {}).then(() => null, (err: Error) => err);

  /* Then */
  assert.ok(failed instanceof Error);
  assert.equal(await store.present(), false);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('an error status rejects with it', async (t) => {
  /* Given */
  const s = await server((_req, res) => {
    res.writeHead(503);
    res.end();
  });
  t.after(() => s.close());
  const store = new WhisperModelStore({ directory: tempDir(), log: silentLog, url: s.url });

  /* When */
  const failed = await store.download(() => {}).then(() => null, (err: Error) => err);

  /* Then */
  assert.equal(failed?.message, 'the download answered 503');
  assert.equal(await store.present(), false);
});
