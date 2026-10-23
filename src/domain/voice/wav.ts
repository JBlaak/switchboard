/**
 * A WAV file around raw PCM, which is what `whisper-cli` reads.
 *
 * The canonical 44-byte RIFF header for uncompressed PCM, little-endian
 * throughout: mono, 16-bit, at the phone's 16 kHz, which is also the rate
 * Whisper wants, so nothing is resampled.
 */
import { SAMPLE_RATE } from './recording';

const HEADER_BYTES = 44;

export function wavFile(pcm: Uint8Array, sampleRate = SAMPLE_RATE): Uint8Array {
  const channels = 1;
  const bitsPerSample = 16;
  const blockAlign = channels * bitsPerSample / 8;
  const out = new Uint8Array(HEADER_BYTES + pcm.length);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i);
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  ascii(36, 'data');
  view.setUint32(40, pcm.length, true);
  out.set(pcm, HEADER_BYTES);
  return out;
}
