/**
 * Speech to text on the Mac, for the phone's hold-to-talk (#194): whisper.cpp
 * and the model it runs.
 *
 * Neither is bundled. `whisper-cli` is the user's to install from Homebrew,
 * and the model is 1.6 GB, fetched the first time someone talks.
 */

export interface Transcriber {
  /** Whether `whisper-cli` can be found. Looked for afresh each time: it may be installed while the app runs. */
  available(): Promise<boolean>;
  /**
   * What `whisper-cli` printed for this audio: a 16 kHz mono 16-bit WAV.
   * Rejects when it can't be run or fails; aborting kills it.
   */
  transcribe(request: { wav: Uint8Array; modelPath: string; prompt: string }, signal: AbortSignal): Promise<string>;
}

/** Whisper's model file, kept in the app's user data. */
export interface VoiceModelStore {
  /** Where the model is, once it is there. */
  readonly path: string;
  /** Whether the whole model is there; a download in progress doesn't count. */
  present(): Promise<boolean>;
  /**
   * Fetch it. `onProgress` gets 0–1, or null while the size is unknown.
   * Rejects when the download fails, leaving nothing at `path`.
   */
  download(onProgress: (progress: number | null) => void): Promise<void>;
}
