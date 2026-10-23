/**
 * The questions running sessions are blocked on, and answering them.
 *
 * A Claude session's AskUserQuestion call reaches us as a held hook request:
 * the CLI waits until we reply, and gives up (asking in its own terminal) if
 * the request goes away first. This service is the bookkeeping between that
 * request and the renderer — it does not know it is HTTP, only that it was
 * handed a way to reply and will be told if the request is withdrawn.
 *
 * A grilling round is the other kind of set: questions written out at the end
 * of a turn, which the Stop hook hands us after the fact. Nothing is held for
 * it. It waits until it is answered — by typing the reply into the session —
 * or until the user replies in the terminal, or the session ends.
 *
 * Pending sets are keyed by the ActiveSession object rather than an id,
 * because a fork or plan-accept re-keys a running session while its question
 * is still on screen; the renderer always hears about it under the session's
 * current id, and may answer under any id the session has had.
 */
import {
  QUESTION_HOOK_TIMEOUT_SECONDS, questionHookResponse, questionHookSettings,
} from '../../domain/questions/question';
import { grillReply } from '../../domain/questions/grill';
import type {
  Answers, AskedQuestions, PendingQuestions, Question, QuestionsOutcome,
} from '../../domain/questions/question';
import type { ActiveSession } from '../model/active-session';
import type { SessionRegistry } from '../model/session-registry';
import type { Clock } from '../ports/clock';
import type { Logger } from '../ports/logger';
import type { QuestionHookEndpoint } from '../ports/question-hook';
import type { Disposable } from '../ports/git-workspace';
import type { RendererGateway } from '../ports/renderer-gateway';
import type { SessionPrompter } from '../ports/session-prompter';

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

interface BaseEntry {
  /** The registry key at the time of asking; the fallback when never re-keyed. */
  readonly key: string;
  readonly toolUseId: string;
  readonly questions: Question[];
  readonly askedAt: number;
}

/** An AskUserQuestion call, its hook request held open. */
interface AskEntry extends BaseEntry {
  readonly source: 'ask';
  readonly asked: AskedQuestions;
  readonly reply: QuestionReply;
  readonly deadline: number;
}

/** A grilling round, answered by typing into the session. */
interface GrillEntry extends BaseEntry {
  readonly source: 'grill';
  /** Withdraws the round if the session ends first. */
  exitWatch: Disposable | null;
}

type Entry = AskEntry | GrillEntry;

export interface QuestionServiceDeps {
  registry: SessionRegistry;
  renderer: RendererGateway;
  endpoint: QuestionHookEndpoint;
  /** Types a grilling round's answers in, and says when its session ends. */
  prompter: Pick<SessionPrompter, 'send' | 'onExit'>;
  clock: Clock;
  log: Logger;
}

export class QuestionService {
  readonly #pending = new Map<ActiveSession, Entry>();
  /** Numbers the made-up ids of grilling rounds. */
  #rounds = 0;

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

    this.#replace(session);

    const askedAt = clock.now();
    const entry: AskEntry = {
      source: 'ask',
      key,
      toolUseId: asked.toolUseId,
      questions: asked.questions,
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

  /**
   * A turn ended with a grilling round, for the session launched as
   * `launchId`. Like a new AskUserQuestion, it replaces whatever the session
   * was still asking: Claude has moved on from it.
   */
  receiveRound(launchId: string, questions: Question[]): void {
    const { registry, renderer, prompter, clock, log } = this.deps;
    const found = registry.find(launchId);
    if (!found) return;
    const { key, session } = found;
    this.#replace(session);

    const askedAt = clock.now();
    const entry: GrillEntry = {
      source: 'grill',
      key,
      toolUseId: `grill-${askedAt}-${++this.#rounds}`,
      questions,
      askedAt,
      exitWatch: null,
    };
    this.#pending.set(session, entry);
    entry.exitWatch = prompter.onExit(key, () => {
      if (this.#pending.get(session) === entry) this.#settle(session, entry, 'withdrawn');
    });
    log.info(`[questions] session=${currentId(session, key)} tool=${entry.toolUseId} grilling round of ${questions.length} question(s)`);
    renderer.questionsAsked(this.#toPending(session, entry));
  }

  /**
   * A prompt went in to the session launched as `launchId`. A grilling round
   * still waiting has been answered in the terminal, or passed over.
   */
  promptSubmitted(launchId: string): void {
    const found = this.deps.registry.find(launchId);
    const entry = found ? this.#pending.get(found.session) : undefined;
    if (found && entry?.source === 'grill') this.#settle(found.session, entry, 'withdrawn');
  }

  /** Answer a pending set; `sessionId` may be any id the session has had. */
  answer(sessionId: string, toolUseId: string, answers: Answers): { ok: boolean; error?: string } {
    const found = this.deps.registry.find(sessionId);
    const entry = found ? this.#pending.get(found.session) : undefined;
    if (!found || !entry || entry.toolUseId !== toolUseId) {
      return { ok: false, error: 'These questions are no longer waiting' };
    }
    // Settled first: the prompt typed in fires UserPromptSubmit, which must find nothing left to withdraw.
    this.#settle(found.session, entry, 'answered');
    if (entry.source === 'ask') entry.reply(questionHookResponse(entry.asked.toolInput, answers));
    else this.deps.prompter.send(found.key, grillReply(entry.questions, answers));
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
    const id = encodeURIComponent(sessionId);
    return questionHookSettings({ ask: `${url}/ask/${id}`, stop: `${url}/stop/${id}`, prompt: `${url}/prompt/${id}` }, token);
  }

  /**
   * A session is about to ask something new: whatever it was still asking is
   * stale. A held request is released with no decision.
   */
  #replace(session: ActiveSession): void {
    const previous = this.#pending.get(session);
    if (!previous) return;
    this.#settle(session, previous, 'withdrawn');
    if (previous.source === 'ask') previous.reply(NO_DECISION);
  }

  #settle(session: ActiveSession, entry: Entry, outcome: QuestionsOutcome): void {
    this.#pending.delete(session);
    if (entry.source === 'grill') entry.exitWatch?.dispose();
    const sessionId = currentId(session, entry.key);
    this.deps.log.info(`[questions] session=${sessionId} tool=${toolUseLabel(entry.toolUseId)} ${outcome}`);
    this.deps.renderer.questionsSettled({ sessionId, toolUseId: entry.toolUseId, outcome });
  }

  #toPending(session: ActiveSession, entry: Entry): PendingQuestions {
    return {
      sessionId: currentId(session, entry.key),
      toolUseId: entry.toolUseId,
      source: entry.source,
      questions: entry.questions,
      askedAt: entry.askedAt,
      deadline: entry.source === 'ask' ? entry.deadline : null,
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
