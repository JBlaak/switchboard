/**
 * Noticing that a running session has become a different session.
 *
 * The CLI never says so. A fork or an accepted plan just starts writing a new
 * transcript, and the only evidence is a file appearing in the folder we are
 * watching. So on every write to a project folder, each session running in it
 * is asked whether one of the new transcripts is its own continuation — and if
 * it is, the session is re-keyed and everything holding the old id is told.
 */
import {
  extractNewSessionSignals, extractOldSessionTail, hasNoSignals, matchesFork,
  matchesPlanAccept, STALE_EMPTY_FILE_MS, transitionKind,
} from '../../domain/session/transitions';
import type { NewSessionSignals } from '../../domain/session/transitions';
import type { ActiveSession } from '../model/active-session';
import type { SessionRegistry } from '../model/session-registry';
import type { Clock } from '../ports/clock';
import type { Logger } from '../ports/logger';
import type { RendererGateway } from '../ports/renderer-gateway';
import type { TranscriptStore } from '../ports/transcript-store';

/**
 * How much of a new transcript is read looking for signals.
 *
 * Generous because file-history snapshots come first and can be tens of KB
 * each; the signals are on the first real entry after them.
 */
const SIGNAL_SCAN_BYTES = 524288;

/** How much of the old transcript's tail is read for the plan handover check. */
const TAIL_SCAN_BYTES = 8192;

export interface TransitionDetectorDeps {
  registry: SessionRegistry;
  transcripts: TranscriptStore;
  renderer: RendererGateway;
  clock: Clock;
  log: Logger;
}

export class SessionTransitionDetector {
  constructor(private readonly deps: TransitionDetectorDeps) {}

  /** Check every session running in this folder against its new transcripts. */
  detect(folder: string): void {
    const { registry, transcripts } = this.deps;

    let currentIds: string[];
    try {
      currentIds = transcripts.listSessionIds(folder);
    } catch {
      return;
    }

    for (const [sessionId, session] of registry.snapshot()) {
      if (!this.#isCandidate(session, folder)) continue;
      this.#checkSession(folder, sessionId, session, currentIds);
    }
  }

  /**
   * Is this session one a transition could apply to?
   *
   * A plain terminal writes no transcript, an exited session is not going to
   * fork, and a session running in another project's folder cannot be the
   * origin of a file in this one.
   */
  #isCandidate(session: ActiveSession, folder: string): boolean {
    return !session.exited && !session.isPlainTerminal
      && !!session.knownTranscriptIds && session.projectFolder === folder;
  }

  #checkSession(
    folder: string,
    sessionId: string,
    session: ActiveSession,
    currentIds: readonly string[],
  ): void {
    const known = session.knownTranscriptIds!;
    const newIds = currentIds.filter(id => !known.has(id));
    if (newIds.length === 0) return;

    this.deps.log.debug(
      `[detect] session=${sessionId} folder=${folder} ` +
      `new=${newIds.length} known=${known.size} current=${currentIds.length}`);

    // Transcripts that exist but have said nothing yet. They are excluded from
    // the updated snapshot so the next write rechecks them, rather than being
    // accepted as "already known" while still being written.
    const stillEmpty = new Set<string>();

    for (const newId of newIds) {
      const signals = extractNewSessionSignals(
        this.deps.transcripts.readHeadLines(folder, newId, SIGNAL_SCAN_BYTES));

      if (hasNoSignals(signals)) {
        if (this.#isStale(folder, newId)) {
          this.deps.log.info(`[detect] session=${sessionId} ignoring stale empty transcript=${newId}`);
        } else {
          stillEmpty.add(newId);
        }
        continue;
      }

      if (this.#matches(folder, sessionId, newId, signals)) {
        this.#applyTransition(sessionId, session, newId, signals, currentIds);
        // Only one transition per session per pass: a second would be re-keying
        // a session that has already moved.
        return;
      }
    }

    const updated = new Set(currentIds);
    for (const id of stillEmpty) updated.delete(id);
    session.knownTranscriptIds = updated;
  }

  /** A transcript untouched for an hour is not the one we are waiting for. */
  #isStale(folder: string, sessionId: string): boolean {
    const mtime = this.deps.transcripts.sessionMtimeMs(folder, sessionId);
    return mtime !== null && this.deps.clock.now() - mtime > STALE_EMPTY_FILE_MS;
  }

  #matches(
    folder: string,
    sessionId: string,
    newId: string,
    signals: NewSessionSignals,
  ): boolean {
    if (matchesFork(signals, { sessionId })) return true;

    const { transcripts } = this.deps;
    const oldMtime = transcripts.sessionMtimeMs(folder, sessionId);
    const newMtime = transcripts.sessionMtimeMs(folder, newId);
    if (oldMtime === null || newMtime === null) return false;

    return matchesPlanAccept(
      signals,
      extractOldSessionTail(transcripts.readTail(folder, sessionId, TAIL_SCAN_BYTES)),
      { oldMtimeMs: oldMtime, newMtimeMs: newMtime });
  }

  /**
   * Move the session onto its new id.
   *
   * Two things follow it: the registry (which remembers the old id so a stale
   * row can still stop the session) and the renderer.
   */
  #applyTransition(
    sessionId: string,
    session: ActiveSession,
    newId: string,
    signals: NewSessionSignals,
    currentIds: readonly string[],
  ): void {
    const { registry, renderer, log } = this.deps;

    log.info(`[session-transition] ${sessionId} → ${newId} (${transitionKind(signals)})`);

    session.knownTranscriptIds = new Set(currentIds);
    if (signals.slug) session.sessionSlug = signals.slug;

    registry.rekey(sessionId, newId);
    renderer.sessionForked(sessionId, newId);
  }
}
