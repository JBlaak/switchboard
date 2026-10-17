/**
 * The questions running sessions are blocked on, and answering them.
 *
 * A Claude session's AskUserQuestion call reaches us as a held hook request:
 * the CLI waits until we reply, and gives up (asking in its own terminal) if
 * the request goes away first. This service is the bookkeeping between that
 * request and the renderer — it does not know it is HTTP, only that it was
 * handed a way to reply and will be told if the request is withdrawn.
 *
 * Pending sets are keyed by the ActiveSession object rather than an id,
 * because a fork or plan-accept re-keys a running session while its question
 * is still on screen; the renderer always hears about it under the session's
 * current id, and may answer under any id the session has had.
 */
import {
  QUESTION_HOOK_TIMEOUT_SECONDS, questionHookResponse, questionHookSettings,
} from '../../domain/questions/question';
import type {
  Answers, AskedQuestions, PendingQuestions, QuestionsOutcome,
} from '../../domain/questions/question';
import type { ActiveSession } from '../model/active-session';
import type { SessionRegistry } from '../model/session-registry';
import type { Clock } from '../ports/clock';
import type { Logger } from '../ports/logger';
import type { QuestionHookEndpoint } from '../ports/question-hook';
import type { RendererGateway } from '../ports/renderer-gateway';

/** How the hook request is answered; called at most once per request. */
export type QuestionReply = (json: Record<string, unknown>) => void;

/** Given back to the transport so it can report the request going away. */
export interface PendingQuestionsHandle {
  /** The request closed before an answer. Idempotent; a no-op once answered. */
  withdraw(): void;
}

/**
 * The reply that makes no decision. The CLI treats it as "hook had nothing to
 * say" and asks in its own terminal, which is the right fallback whenever we
 * cannot show the question ourselves.
 */
const NO_DECISION: Record<string, unknown> = {};

const NO_OP_HANDLE: PendingQuestionsHandle = { withdraw() {} };

interface Entry {
  /** The registry key at the time of asking; the fallback when never re-keyed. */
  readonly key: string;
  readonly asked: AskedQuestions;
  readonly reply: QuestionReply;
  readonly askedAt: number;
  readonly deadline: number;
}

export interface QuestionServiceDeps {
  registry: SessionRegistry;
  renderer: RendererGateway;
  endpoint: QuestionHookEndpoint;
  clock: Clock;
  log: Logger;
}

export class QuestionService {
  readonly #pending = new Map<ActiveSession, Entry>();

  constructor(private readonly deps: QuestionServiceDeps) {}

  /**
   * A hook request arrived for the session launched as `launchId`.
   *
   * A session can only be blocked on one AskUserQuestion at a time, so a new
   * set for a session that already has one means the old request is stale
   * (the CLI moved on without us noticing the close): it is released with no
   * decision and withdrawn from the UI before the new one is shown.
   */
  receive(launchId: string, asked: AskedQuestions, reply: QuestionReply): PendingQuestionsHandle {
    const { registry, renderer, clock, log } = this.deps;

    const found = registry.find(launchId);
    if (!found) {
      log.warn(`[questions] no running session for ${launchId}; leaving it to the terminal`);
      reply(NO_DECISION);
      return NO_OP_HANDLE;
    }
    const { key, session } = found;

    const previous = this.#pending.get(session);
    if (previous) {
      this.#settle(session, previous, 'withdrawn');
      previous.reply(NO_DECISION);
    }

    const askedAt = clock.now();
    const entry: Entry = {
      key,
      asked,
      reply,
      askedAt,
      deadline: askedAt + QUESTION_HOOK_TIMEOUT_SECONDS * 1000,
    };
    this.#pending.set(session, entry);
    log.info(`[questions] session=${currentId(session, key)} tool=${toolUseLabel(asked.toolUseId)} asked ${asked.questions.length} question(s)`);
    renderer.questionsAsked(this.#toPending(session, entry));

    return {
      withdraw: () => {
        // Only this request's entry: a replacement may already sit in its place.
        if (this.#pending.get(session) !== entry) return;
        this.#settle(session, entry, 'withdrawn');
      },
    };
  }

  /** Answer a pending set; `sessionId` may be any id the session has had. */
  answer(sessionId: string, toolUseId: string, answers: Answers): { ok: boolean; error?: string } {
    const found = this.deps.registry.find(sessionId);
    const entry = found ? this.#pending.get(found.session) : undefined;
    if (!found || !entry || entry.asked.toolUseId !== toolUseId) {
      return { ok: false, error: 'These questions are no longer waiting' };
    }
    this.#settle(found.session, entry, 'answered');
    entry.reply(questionHookResponse(entry.asked.toolInput, answers));
    return { ok: true };
  }

  /** Every set still waiting, for a renderer that has just (re)loaded. */
  pending(): PendingQuestions[] {
    return [...this.#pending].map(([session, entry]) => this.#toPending(session, entry));
  }

  /**
   * The `--settings` value that installs the hook for a session launched as
   * `sessionId`, or null while the server is not listening.
   */
  settingsFor(sessionId: string): string | null {
    const { url, token } = this.deps.endpoint;
    if (!url) return null;
    return questionHookSettings(`${url}/ask/${encodeURIComponent(sessionId)}`, token);
  }

  #settle(session: ActiveSession, entry: Entry, outcome: QuestionsOutcome): void {
    this.#pending.delete(session);
    const sessionId = currentId(session, entry.key);
    this.deps.log.info(`[questions] session=${sessionId} tool=${toolUseLabel(entry.asked.toolUseId)} ${outcome}`);
    this.deps.renderer.questionsSettled({ sessionId, toolUseId: entry.asked.toolUseId, outcome });
  }

  #toPending(session: ActiveSession, entry: Entry): PendingQuestions {
    return {
      sessionId: currentId(session, entry.key),
      toolUseId: entry.asked.toolUseId,
      questions: entry.asked.questions,
      askedAt: entry.askedAt,
      deadline: entry.deadline,
    };
  }
}

/** A tool-use id for the log; a hook body without one parses to ''. */
function toolUseLabel(toolUseId: string): string {
  return toolUseId || '(none)';
}

/** The id the renderer knows a session by now — as the lifecycle computes it. */
function currentId(session: ActiveSession, key: string): string {
  return session.realSessionId || key;
}
