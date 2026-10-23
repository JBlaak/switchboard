/**
 * One hold-to-talk recording from a phone, as it arrives.
 *
 * The phone streams 16 kHz mono signed 16-bit PCM in numbered chunks while
 * the mic is held. A WebSocket keeps order, so a chunk out of turn means the
 * phone lost one, and a transcript with a hole in it reads as if the user
 * said something they didn't: the recording is marked broken and comes out as
 * a failure rather than as text. Past `MAX_RECORDING_SECONDS` the audio is
 * dropped and what was kept is still transcribed.
 */

export const SAMPLE_RATE = 16_000;
/** Mono, two bytes a sample. */
export const BYTES_PER_SECOND = SAMPLE_RATE * 2;
export const MAX_RECORDING_SECONDS = 10 * 60;
export const MAX_RECORDING_BYTES = MAX_RECORDING_SECONDS * BYTES_PER_SECOND;

export const GAP_REASON = 'Some of the recording went missing on the way to the Mac.';

export class Recording {
  readonly #chunks: Uint8Array[] = [];
  #bytes = 0;
  #nextSeq = 0;
  #broken = false;

  constructor(readonly voiceId: string, readonly sessionId: string | null) {}

  /** A chunk's PCM. Ignored once the recording is broken or full. */
  add(seq: number, pcm: Uint8Array): void {
    if (this.#broken) return;
    if (seq !== this.#nextSeq) {
      this.#broken = true;
      this.#chunks.length = 0;
      this.#bytes = 0;
      return;
    }
    this.#nextSeq++;
    const room = MAX_RECORDING_BYTES - this.#bytes;
    if (room <= 0) return;
    const kept = pcm.length > room ? pcm.subarray(0, room) : pcm;
    this.#chunks.push(kept);
    this.#bytes += kept.length;
  }

  /** A chunk went missing, so the audio can't be trusted. */
  get broken(): boolean {
    return this.#broken;
  }

  /** Everything kept, as whole samples: a stray odd byte at the end is dropped. */
  pcm(): Uint8Array {
    const length = this.#bytes - (this.#bytes % 2);
    const out = new Uint8Array(length);
    let offset = 0;
    for (const chunk of this.#chunks) {
      const part = chunk.subarray(0, Math.min(chunk.length, length - offset));
      out.set(part, offset);
      offset += part.length;
      if (offset >= length) break;
    }
    return out;
  }
}
