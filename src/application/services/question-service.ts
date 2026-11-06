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
 * of a turn. Nothing is held for it, and it is not answered here: the
 * GrillService keeps the round and its drafts for the grilling card, and
 * opens and closes this set so that everything following pending questions
 * (the sidebar, the panel, the phone's attention) sees the round as well.
 *
 * Pending sets are keyed by the ActiveSession object rather than an id,
 * because a fork or plan-accept re-keys a running session while its question
 * is still on screen; the renderer always hears about it under the session's
 * current id, and may answer under any id the session has had.
 */
import {
    QUESTION_HOOK_TIMEOUT_SECONDS,
    questionHookResponse,
    questionHookSettings,
} from '../../domain/questions/question';
import type {
    Answers,
    AskedQuestions,
    PendingQuestions,
    Question,
    QuestionsOutcome,
} from '../../domain/questions/question';
import type {ActiveSession} from '../model/active-session';
import type {SessionRegistry} from '../model/session-registry';
import type {Clock} from '../ports/clock';
import type {Logger} from '../ports/logger';
import type {QuestionHookEndpoint} from '../ports/question-hook';
import type {RendererGateway} from '../ports/renderer-gateway';

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

const NO_OP_HANDLE: PendingQuestionsHandle = {withdraw() {}};

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

/** A grilling round open on the grilling card, which answers it by typing into the session. */
interface GrillEntry extends BaseEntry {
    readonly source: 'grill';
}

type Entry = AskEntry | GrillEntry;

export interface QuestionServiceDeps {
    registry: SessionRegistry;
    renderer: RendererGateway;
    endpoint: QuestionHookEndpoint;
    clock: Clock;
    log: Logger;
}

export class QuestionService {
    private readonly pendingBySession = new Map<ActiveSession, Entry>();

    constructor(private readonly deps: QuestionServiceDeps) {}

    /**
     * A hook request arrived for the session launched as `launchId`.
     *
     * A session can only be blocked on one AskUserQuestion at a time, so a new
     * set for a session that already has one means the old request is stale
     * (the CLI moved on without us noticing the close): it is released with no
     * decision and withdrawn from the UI before the new one is shown.
     */
    public receive(launchId: string, asked: AskedQuestions, reply: QuestionReply): PendingQuestionsHandle {
        const {registry, renderer, clock, log} = this.deps;

        const found = registry.find(launchId);
        if (!found) {
            log.warn(`[questions] no running session for ${launchId}; leaving it to the terminal`);
            reply(NO_DECISION);
            return NO_OP_HANDLE;
        }
        const {key, session} = found;

        this.replace(session);

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
        this.pendingBySession.set(session, entry);
        log.info(
            `[questions] session=${currentId(session, key)} tool=${toolUseLabel(asked.toolUseId)} asked ${asked.questions.length} question(s)`,
        );
        renderer.questionsAsked(this.toPending(session, entry));

        return {
            withdraw: () => {
                // Only this request's entry: a replacement may already sit in its place.
                if (this.pendingBySession.get(session) !== entry) return;
                this.settle(session, entry, 'withdrawn');
            },
        };
    }

    /**
     * The grilling card opened a round for the session launched as
     * `launchId`, or revised it. The round itself, its drafts
     * and its sending are the GrillService's; this keeps the pending set that
     * says a round is open, which the sidebar, the panel and the phone's
     * attention follow. Its `questions` summarise the round.
     *
     * A new round replaces whatever the session was still asking, as a new
     * AskUserQuestion does. The same round again (a revision) only updates the
     * set's questions: the renderer, which keeps a set it already has, carries
     * on; the phones get the fresh list.
     */
    public openRound(launchId: string, toolUseId: string, questions: Question[]): void {
        const {registry, renderer, clock, log} = this.deps;
        const found = registry.find(launchId);
        if (!found) return;
        const {key, session} = found;
        const previous = this.pendingBySession.get(session);
        if (previous?.source === 'grill' && previous.toolUseId === toolUseId) {
            const entry: GrillEntry = {...previous, questions};
            this.pendingBySession.set(session, entry);
            renderer.questionsAsked(this.toPending(session, entry));
            return;
        }
        this.replace(session);

        const entry: GrillEntry = {source: 'grill', key, toolUseId, questions, askedAt: clock.now()};
        this.pendingBySession.set(session, entry);
        log.info(
            `[questions] session=${currentId(session, key)} tool=${toolUseId} grilling round of ${questions.length} question(s)`,
        );
        renderer.questionsAsked(this.toPending(session, entry));
    }

    /**
     * The grilling round of the session launched as `launchId` closed: sent
     * (`answered`, from where), replied to in the terminal, or the session
     * ended (`withdrawn`). The session may be gone from the registry already
     * when it ended, so its set is also found by any id it has had.
     */
    public closeRound(launchId: string, outcome: QuestionsOutcome, answeredOn?: 'mac' | 'phone'): void {
        const found = this.deps.registry.find(launchId);
        let session: ActiveSession | undefined = found?.session;
        if (!session) {
            for (const [candidate, entry] of this.pendingBySession) {
                if (entry.source === 'grill' && answersTo(candidate, entry.key, launchId)) session = candidate;
            }
        }
        const entry = session ? this.pendingBySession.get(session) : undefined;
        if (!session || entry?.source !== 'grill') return;
        this.settle(session, entry, outcome, answeredOn);
    }

    /**
     * Answer a pending set; `sessionId` may be any id the session has had.
     * `answeredOn` is where the answer came from (#194), carried on the settled
     * set so the other device can say "Answered on phone" or "Answered on Mac".
     */
    public answer(
        sessionId: string,
        toolUseId: string,
        answers: Answers,
        answeredOn: 'mac' | 'phone' = 'mac',
    ): {ok: boolean; error?: string} {
        const found = this.deps.registry.find(sessionId);
        const entry = found ? this.pendingBySession.get(found.session) : undefined;
        if (!found || !entry || entry.toolUseId !== toolUseId) {
            return {ok: false, error: 'These questions are no longer waiting'};
        }
        // A round's drafts and sending are the grilling card's (GrillService).
        if (entry.source === 'grill') return {ok: false, error: 'Answer this round on the grilling card'};
        this.settle(found.session, entry, 'answered', answeredOn);
        entry.reply(questionHookResponse(entry.asked.toolInput, answers));
        return {ok: true};
    }

    /** Every set still waiting, for a renderer that has just (re)loaded. */
    public pending(): PendingQuestions[] {
        return [...this.pendingBySession].map(([session, entry]) => this.toPending(session, entry));
    }

    /**
     * The `--settings` value that installs the hook for a session launched as
     * `sessionId`, or null while the server is not listening.
     */
    public settingsFor(sessionId: string): string | null {
        const {url, token} = this.deps.endpoint;
        if (!url) return null;
        const id = encodeURIComponent(sessionId);
        return questionHookSettings(
            {
                ask: `${url}/ask/${id}`,
                stop: `${url}/stop/${id}`,
                prompt: `${url}/prompt/${id}`,
                subagent: `${url}/subagent/${id}`,
                onePassword: `${url}/onepassword/${id}`,
            },
            token,
        );
    }

    /**
     * A session is about to ask something new: whatever it was still asking is
     * stale. A held request is released with no decision.
     */
    private replace(session: ActiveSession): void {
        const previous = this.pendingBySession.get(session);
        if (!previous) return;
        this.settle(session, previous, 'withdrawn');
        if (previous.source === 'ask') previous.reply(NO_DECISION);
    }

    private settle(
        session: ActiveSession,
        entry: Entry,
        outcome: QuestionsOutcome,
        answeredOn?: 'mac' | 'phone',
    ): void {
        this.pendingBySession.delete(session);
        const sessionId = currentId(session, entry.key);
        this.deps.log.info(
            `[questions] session=${sessionId} tool=${toolUseLabel(entry.toolUseId)} ${outcome}${answeredOn ? ` on ${answeredOn}` : ''}`,
        );
        this.deps.renderer.questionsSettled({
            sessionId,
            toolUseId: entry.toolUseId,
            outcome,
            ...(answeredOn ? {answeredOn} : {}),
        });
    }

    private toPending(session: ActiveSession, entry: Entry): PendingQuestions {
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

/** Whether a session (perhaps gone from the registry) has answered to `id`. */
function answersTo(session: ActiveSession, key: string, id: string): boolean {
    return key === id || session.realSessionId === id || (session.priorIds?.has(id) ?? false);
}

/** The id the renderer knows a session by now — as the lifecycle computes it. */
function currentId(session: ActiveSession, key: string): string {
    return session.realSessionId || key;
}
