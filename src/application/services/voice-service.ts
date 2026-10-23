/**
 * Hold-to-talk from the phone (#194): the phone streams audio while the mic
 * is held, and gets back text to put in its prompt box.
 *
 * Whisper (`whisper-cli`) transcribes on the Mac, then one Haiku call tidies
 * the transcript (`domain/voice/cleanup`); a cleanup that fails or takes too
 * long leaves the raw transcript, which is still what the user said. Both are
 * primed with the project names the user is likely to say.
 *
 * Each connection has one recording at a time: a new `voice-start` drops the
 * one being received. One already let go of is still transcribed, and its
 * result goes out under its own id. Every `voice-start` gets exactly one
 * `voice-result` unless it was cancelled, dropped or its phone went away.
 *
 * Whisper's model is fetched the first time someone talks, not up front: it
 * is 1.6 GB, and a user who never dictates should never download it. The
 * recording that finds it missing is answered `unavailable` straight away,
 * and every phone follows the download through `voice-status`.
 */
import { CLEANUP_TIMEOUT_MS, cleanupArgs, keepsToTranscript, readCleanupRun } from '../../domain/voice/cleanup';
import { GAP_REASON, Recording } from '../../domain/voice/recording';
import { hasSpeech } from '../../domain/voice/speech';
import { voiceVocabulary } from '../../domain/voice/vocabulary';
import { wavFile } from '../../domain/voice/wav';
import { readTranscript, whisperPrompt } from '../../domain/voice/whisper';
import { folderName, routeCandidates } from '../../domain/ask/route';
import type { ClientMessage, VoiceResult, VoiceStatus } from '../../domain/phone/protocol';
import type { Project } from '../../domain/project/project';
import type { SessionRegistry } from '../model/session-registry';
import type { ClaudeCaller } from '../ports/claude-cli';
import type { TimerHandle, Timers } from '../ports/clock';
import type { Logger } from '../ports/logger';
import type { DeviceConnection } from '../ports/phone-access';
import type { Transcriber, VoiceModelStore } from '../ports/voice';

export type VoiceMessage = Extract<ClientMessage, { type: 'voice-start' | 'voice-chunk' | 'voice-end' | 'voice-cancel' }>;

type Unavailable = Exclude<VoiceStatus, { kind: 'ready' }>;

/** How long a reason line may be; the phone shows it in a snackbar. */
const MAX_REASON = 160;

export interface VoiceServiceDeps {
  transcriber: Transcriber;
  model: VoiceModelStore;
  /** For the cleanup call. */
  cli: ClaudeCaller;
  /** The session a recording is made in, for its project's name. */
  registry: Pick<SessionRegistry, 'find'>;
  /** The local projects, whose names prime Whisper. */
  projects: { list(showArchived: boolean): Project[] };
  timers: Timers;
  log: Logger;
  /** Whether the audio is loud enough to be speech; `hasSpeech` unless a test says otherwise. */
  heard?: (pcm: Uint8Array) => boolean;
}

/** A recording, from `voice-start` until it is let go of, cancelled or dropped. */
interface Take {
  readonly recording: Recording;
  /** Whether the Mac can transcribe it; when it can't, the phone has been told. */
  readonly usable: Promise<boolean>;
  dropped: boolean;
}

interface Phone {
  readonly connection: DeviceConnection;
  take: Take | null;
  /** Recordings let go of and being transcribed, by voice id. */
  readonly jobs: Map<string, AbortController>;
}

export class VoiceService {
  readonly #phones = new Map<string, Phone>();
  /** As of the last look; looked at again on every `voice-start`. */
  #whisperMissing = false;
  /** The model download in progress, in whole percents. */
  #download: { percent: number | null } | null = null;
  /** Why the last download failed, until the next one starts or the model turns up. */
  #failed: string | null = null;

  constructor(private readonly deps: VoiceServiceDeps) {}

  /**
   * A phone was welcomed: it gets the status. A model that is missing but not
   * downloading counts as ready, because the first `voice-start` is what
   * fetches it; Whisper itself is looked for now, so a Mac without it says so
   * before anyone holds the mic.
   */
  connected(connection: DeviceConnection): void {
    this.#phones.set(connection.id, { connection, take: null, jobs: new Map() });
    connection.send({ type: 'voice-status', status: this.status() });
    void this.#lookForWhisper();
  }

  message(connection: DeviceConnection, message: VoiceMessage): void {
    const phone = this.#phones.get(connection.id);
    if (!phone) return;
    switch (message.type) {
      case 'voice-start':
        return this.#start(phone, message.voiceId, message.sessionId ?? null);
      case 'voice-chunk':
        if (phone.take?.recording.voiceId === message.voiceId) {
          phone.take.recording.add(message.seq, Buffer.from(message.audio, 'base64'));
        }
        return;
      case 'voice-end':
        return this.#end(phone, message.voiceId);
      case 'voice-cancel':
        if (phone.take?.recording.voiceId === message.voiceId) this.#drop(phone);
        phone.jobs.get(message.voiceId)?.abort();
        return;
    }
  }

  /** The connection closed: what it was recording is dropped, and nothing more is transcribed for it. */
  disconnected(connection: DeviceConnection): void {
    const phone = this.#phones.get(connection.id);
    if (!phone) return;
    this.#phones.delete(connection.id);
    this.#drop(phone);
    for (const job of phone.jobs.values()) job.abort();
  }

  /** A running download first, since it ends in one of the others; then a missing Whisper; then a failed download. */
  status(): VoiceStatus {
    if (this.#download) return { kind: 'preparing', progress: this.#download.percent === null ? null : this.#download.percent / 100 };
    if (this.#whisperMissing) return { kind: 'no-whisper' };
    if (this.#failed !== null) return { kind: 'prepare-failed', reason: this.#failed };
    return { kind: 'ready' };
  }

  // ── A recording ──

  #start(phone: Phone, voiceId: string, sessionId: string | null): void {
    this.#drop(phone);
    const recording = new Recording(voiceId, sessionId);
    const take: Take = {
      recording,
      dropped: false,
      usable: this.#readiness().then((unavailable) => {
        if (!unavailable) return true;
        if (phone.take === take) phone.take = null;
        if (!take.dropped && this.#phones.get(phone.connection.id) === phone) {
          phone.connection.send({ type: 'voice-result', voiceId, result: { kind: 'unavailable', status: unavailable } });
        }
        return false;
      }),
    };
    phone.take = take;
  }

  #drop(phone: Phone): void {
    if (!phone.take) return;
    phone.take.dropped = true;
    phone.take = null;
  }

  #end(phone: Phone, voiceId: string): void {
    const take = phone.take;
    if (!take || take.recording.voiceId !== voiceId) return;
    phone.take = null;
    const job = new AbortController();
    phone.jobs.set(voiceId, job);
    void this.#finish(phone, take, job.signal).finally(() => {
      if (phone.jobs.get(voiceId) === job) phone.jobs.delete(voiceId);
    });
  }

  async #finish(phone: Phone, take: Take, signal: AbortSignal): Promise<void> {
    if (!(await take.usable) || signal.aborted) return;
    const result = await this.#transcribe(take.recording, signal);
    if (signal.aborted || this.#phones.get(phone.connection.id) !== phone) return;
    phone.connection.send({ type: 'voice-result', voiceId: take.recording.voiceId, result });
  }

  async #transcribe(recording: Recording, signal: AbortSignal): Promise<VoiceResult> {
    const { transcriber, model, log } = this.deps;
    if (recording.broken) return { kind: 'failed', reason: GAP_REASON };
    const pcm = recording.pcm();
    // Whisper makes words up out of silence ("you", "."), so silence never reaches it.
    if (pcm.length === 0 || !(this.deps.heard ?? hasSpeech)(pcm)) return { kind: 'empty' };

    const vocabulary = this.#vocabulary(recording.sessionId);
    let printed: string;
    try {
      printed = await transcriber.transcribe({ wav: wavFile(pcm), modelPath: model.path, prompt: whisperPrompt(vocabulary) }, signal);
    } catch (err) {
      const message = (err as Error).message;
      log.warn('[voice] whisper failed:', message);
      return { kind: 'failed', reason: reasonLine(`Whisper couldn’t transcribe that: ${message}`) };
    }
    const transcript = readTranscript(printed);
    if (transcript === '') return { kind: 'empty' };
    const cleaned = await this.#cleanUp(transcript, vocabulary, signal);
    return { kind: 'text', text: cleaned ?? transcript };
  }

  /** Haiku's tidy version, or null when it failed or took too long; the call is killed either way. */
  async #cleanUp(transcript: string, vocabulary: string[], signal: AbortSignal): Promise<string | null> {
    const { cli, timers, log } = this.deps;
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    let timer: TimerHandle = null;
    const timedOut = new Promise<null>((resolve) => {
      timer = timers.setTimeout(() => {
        log.warn('[voice] cleanup timed out; sending the raw transcript');
        resolve(null);
      }, CLEANUP_TIMEOUT_MS);
    });
    const answered = cli.call(cleanupArgs(transcript, vocabulary), controller.signal).then(
      (run) => {
        const text = readCleanupRun(run);
        if (text === null) log.warn('[voice] cleanup failed; sending the raw transcript');
        else if (!keepsToTranscript(transcript, text)) {
          log.warn('[voice] cleanup came back longer than the transcript; sending the raw transcript');
          return null;
        }
        return text;
      },
      (err: Error) => {
        log.warn('[voice] could not run the cleanup:', err.message);
        return null;
      },
    );
    try {
      return await Promise.race([answered, timedOut]);
    } finally {
      timers.clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      controller.abort();
    }
  }

  /** The session's project, the local projects, and the fixed words. */
  #vocabulary(sessionId: string | null): string[] {
    const session = sessionId ? this.deps.registry.find(sessionId)?.session : undefined;
    const projects = routeCandidates(this.deps.projects.list(false)).map(candidate => folderName(candidate.projectPath));
    return voiceVocabulary(session ? folderName(session.projectPath) : null, projects);
  }

  // ── Whisper and its model ──

  /** Null when a recording can go ahead; otherwise why not, having started the download if that is why. */
  async #readiness(): Promise<Unavailable | null> {
    if (!(await this.#lookForWhisper())) return { kind: 'no-whisper' };
    if (this.#download) return this.#preparing();
    let present: boolean;
    try {
      present = await this.deps.model.present();
    } catch {
      present = false;
    }
    // Another recording may have started the download while this one looked.
    if (this.#download) return this.#preparing();
    if (present) {
      this.#update(() => { this.#failed = null; });
      return null;
    }
    this.#startDownload();
    return this.#preparing();
  }

  async #lookForWhisper(): Promise<boolean> {
    let found: boolean;
    try {
      found = await this.deps.transcriber.available();
    } catch {
      found = false;
    }
    this.#update(() => { this.#whisperMissing = !found; });
    return found;
  }

  #preparing(): Unavailable {
    return { kind: 'preparing', progress: this.#download?.percent == null ? null : this.#download.percent / 100 };
  }

  #startDownload(): void {
    const { model, log } = this.deps;
    log.info('[voice] downloading the Whisper model to', model.path);
    this.#update(() => {
      this.#download = { percent: null };
      this.#failed = null;
    });
    model.download((progress) => {
      const percent = progress === null ? null : Math.max(0, Math.min(100, Math.floor(progress * 100)));
      this.#update(() => { if (this.#download) this.#download.percent = percent; });
    }).then(
      () => {
        log.info('[voice] the Whisper model is in place');
        this.#update(() => { this.#download = null; });
      },
      (err: Error) => {
        log.error('[voice] the Whisper model download failed:', err.message);
        this.#update(() => {
          this.#download = null;
          this.#failed = reasonLine(`The speech model couldn’t be downloaded: ${err.message}`);
        });
      },
    );
  }

  /** Make a change, and tell every phone when the status it gives is different. */
  #update(change: () => void): void {
    const before = JSON.stringify(this.status());
    change();
    const status = this.status();
    if (JSON.stringify(status) === before) return;
    for (const phone of this.#phones.values()) phone.connection.send({ type: 'voice-status', status });
  }
}

function reasonLine(text: string): string {
  const first = text.split('\n').map(line => line.trim()).find(line => line !== '') ?? text;
  return first.length > MAX_REASON ? first.slice(0, MAX_REASON - 1).trimEnd() + '…' : first;
}
