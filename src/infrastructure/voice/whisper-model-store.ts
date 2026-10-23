/**
 * Whisper's model in the app's user data, fetched from Hugging Face on first
 * use, behind the VoiceModelStore port.
 *
 * The download goes to a `.part` file next to the model and is renamed into
 * place only once every byte is there, so a model at `path` is always whole:
 * a quit or a dropped connection halfway leaves the next try to start over.
 */
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { Logger } from '../../application/ports/logger';
import type { VoiceModelStore } from '../../application/ports/voice';

export const WHISPER_MODEL_FILE = 'ggml-large-v3-turbo.bin';
export const WHISPER_MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${WHISPER_MODEL_FILE}`;

export class WhisperModelStore implements VoiceModelStore {
  readonly path: string;

  constructor(private readonly deps: { directory: string; log: Logger; url?: string }) {
    this.path = path.join(deps.directory, WHISPER_MODEL_FILE);
  }

  async present(): Promise<boolean> {
    try {
      const stat = await fs.stat(this.path);
      return stat.isFile() && stat.size > 0;
    } catch {
      return false;
    }
  }

  async download(onProgress: (progress: number | null) => void): Promise<void> {
    const url = this.deps.url ?? WHISPER_MODEL_URL;
    const part = `${this.path}.part`;
    await fs.mkdir(this.deps.directory, { recursive: true });
    try {
      const response = await fetch(url);
      if (!response.ok || !response.body) throw new Error(`the download answered ${response.status}`);
      const length = Number(response.headers.get('content-length'));
      const total = Number.isFinite(length) && length > 0 ? length : null;
      let received = 0;
      onProgress(total === null ? null : 0);
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          received += chunk.length;
          onProgress(total === null ? null : received / total);
          done(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(response.body as unknown as WebReadableStream),
        counter,
        createWriteStream(part),
      );
      if (total !== null && received !== total) throw new Error(`the download stopped at ${received} of ${total} bytes`);
      await fs.rename(part, this.path);
    } catch (err) {
      await fs.rm(part, { force: true }).catch(() => {});
      throw err;
    }
  }
}
