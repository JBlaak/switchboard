/**
 * whisper.cpp's `whisper-cli`, behind the Transcriber port.
 *
 * The audio goes to a WAV in a temporary directory of its own, which is gone
 * again however the run ends. Whisper prints the transcript on stdout and its
 * progress on stderr, which is only kept for the error.
 */
import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { whisperArgs, whisperCandidates, whisperFailure } from '../../domain/voice/whisper';
import type { Logger } from '../../application/ports/logger';
import type { Transcriber } from '../../application/ports/voice';

/** Ten minutes of audio takes well under a minute on Apple silicon; this is for a hung process. */
const WHISPER_TIMEOUT_MS = 5 * 60_000;

export class WhisperCliTranscriber implements Transcriber {
  constructor(private readonly deps: { log: Logger; pathEnv?: () => string | undefined }) {}

  async available(): Promise<boolean> {
    return this.#locate() !== null;
  }

  async transcribe(request: { wav: Uint8Array; modelPath: string; prompt: string }, signal: AbortSignal): Promise<string> {
    const whisper = this.#locate();
    if (!whisper) throw new Error('whisper-cli is not installed');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'switchboard-voice-'));
    try {
      const wav = path.join(dir, 'recording.wav');
      await fs.writeFile(wav, request.wav);
      return await new Promise<string>((resolve, reject) => {
        execFile(whisper, whisperArgs({ model: request.modelPath, wav, prompt: request.prompt }), {
          signal, timeout: WHISPER_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
        }, (err, stdout, stderr) => {
          if (err) {
            reject(new Error(whisperFailure(stderr, err.message)));
          } else {
            resolve(stdout);
          }
        });
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch((err: Error) => {
        this.deps.log.warn('[voice] could not remove', dir, err.message);
      });
    }
  }

  /** The first executable `whisper-cli` in Homebrew's directories or on PATH. */
  #locate(): string | null {
    const pathEnv = this.deps.pathEnv ? this.deps.pathEnv() : process.env.PATH;
    for (const candidate of whisperCandidates(pathEnv)) {
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Not here.
      }
    }
    return null;
  }
}
