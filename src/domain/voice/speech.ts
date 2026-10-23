/**
 * Whether a recording has anything in it loud enough to be speech.
 *
 * Whisper never answers silence with nothing: a held mic in a quiet room
 * comes back as "you", "." or "Thank you." (seen on a real run), and the
 * cleanup then tidies that into the prompt box. So a recording is only
 * transcribed when some of it stands out as speech.
 *
 * The phone records from the raw voice-recognition mic, without gain, so
 * speech at screen distance can be as quiet as −50 dBFS: a fixed loudness
 * threshold turned that away as "Didn't catch that" while Whisper reads it
 * fine. Speech is what stands well above the recording's own background, or
 * anything at a plainly speaking level.
 */

/** 30 ms at 16 kHz. */
const WINDOW_SAMPLES = 480;
/** −40 dBFS: speech close to the phone, whatever the background. */
const LOUD_RMS = 32768 * 10 ** (-40 / 20);
/** Speech stands at least this far above the room; a room on its own wanders a few dB. */
const ABOVE_BACKGROUND = 10 ** (12 / 20);
/** −70 dBFS: below this nothing counts, however still the room. */
const MIN_SPEECH_RMS = 32768 * 10 ** (-70 / 20);
/** The background is the level only a tenth of the recording is quieter than. */
const BACKGROUND_PERCENTILE = 0.1;
/** About 150 ms of it, so a click or a bump of the phone doesn't count. */
const MIN_SPEECH_WINDOWS = 5;

/** `pcm` is 16-bit little-endian mono, as the phone sends it. */
export function hasSpeech(pcm: Uint8Array): boolean {
  const levels = windowLevels(pcm);
  // Digital silence, as some mics hand over while they start, is not the room.
  const sounding = levels.filter(level => level >= 1).sort((a, b) => a - b);
  if (sounding.length === 0) return false;
  const background = sounding[Math.floor(sounding.length * BACKGROUND_PERCENTILE)];
  const speaking = Math.min(LOUD_RMS, Math.max(MIN_SPEECH_RMS, background * ABOVE_BACKGROUND));
  return levels.filter(level => level >= speaking).length >= MIN_SPEECH_WINDOWS;
}

/** The RMS of each whole window. */
function windowLevels(pcm: Uint8Array): number[] {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const samples = Math.floor(pcm.byteLength / 2);
  const levels: number[] = [];
  for (let start = 0; start + WINDOW_SAMPLES <= samples; start += WINDOW_SAMPLES) {
    let sum = 0;
    for (let i = start; i < start + WINDOW_SAMPLES; i++) {
      const sample = view.getInt16(i * 2, true);
      sum += sample * sample;
    }
    levels.push(Math.sqrt(sum / WINDOW_SAMPLES));
  }
  return levels;
}
