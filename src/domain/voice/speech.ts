/**
 * Whether a recording has anything in it loud enough to be speech.
 *
 * Whisper never answers silence with nothing: a held mic in a quiet room
 * comes back as "you", "." or "Thank you." (seen on a real run), and the
 * cleanup then tidies that into the prompt box. So a recording is only
 * transcribed when some of it is at speaking level.
 */

/** 30 ms at 16 kHz. */
const WINDOW_SAMPLES = 480;
/** −40 dBFS: a quiet room sits around −60, speech near the phone at −30 to −10. */
const SPEECH_RMS = 32768 * 10 ** (-40 / 20);
/** About 90 ms of it, so a single click or bump doesn't count. */
const MIN_SPEECH_WINDOWS = 3;

/** `pcm` is 16-bit little-endian mono, as the phone sends it. */
export function hasSpeech(pcm: Uint8Array): boolean {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const samples = Math.floor(pcm.byteLength / 2);
  let loud = 0;
  for (let start = 0; start + WINDOW_SAMPLES <= samples; start += WINDOW_SAMPLES) {
    let sum = 0;
    for (let i = start; i < start + WINDOW_SAMPLES; i++) {
      const sample = view.getInt16(i * 2, true);
      sum += sample * sample;
    }
    if (Math.sqrt(sum / WINDOW_SAMPLES) >= SPEECH_RMS && ++loud >= MIN_SPEECH_WINDOWS) return true;
  }
  return false;
}
