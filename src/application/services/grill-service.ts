/**
 * The grilling card's main-process side: the open round of each running
 * session, its draft answers, and typing those answers in.
 *
 * A grilling session writes its questions out as a round at the end of a
 * turn (`domain/grill/round`). The hook server hands every ended turn, every
 * prompt that goes in and every subagent that starts or stops to this
 * service, and from those it keeps, per running session:
 *
 * - the open round: the id of the block that first posted it, every revision
 *   Claude posted of it, and the drafts (`domain/grill/answering`). A round
 *   posted while one is open revises it; a prompt that is not one of
 *   Switchboard's own asks, or the session ending, closes it.
 * - the asks under way: Ask about this and Wait, what? type a prompt that
 *   leaves the round open. Each is registered before it is typed, so when the
 *   prompt comes back through the hook it is known for an ask; the turn it
 *   starts becomes that question's explanation (or, when it posts a whole
 *   round, a revision).
 * - the background agents running, and whether Claude has stopped since the
 *   last of them did: Send when research is done waits for both.
 *
 * The drafts live here, in memory, so the Mac's card and the phone edit the
 * same ones: every change goes to the renderer gateway as `grillChanged`,
 * which the phone tee passes on. The QuestionService keeps the round's
 * pending set (`source: 'grill'`), the signal the sidebar, the panel and the
 * phone's attention already follow.
 *
 * State is keyed by the ActiveSession object, as QuestionService's is, since a
 * fork or plan-accept re-keys a running session; every call takes any id the
 * session has had.
 */
import {answerAgainst, answerAt, carry, matchQuestions, revise, startAnswering} from '../../domain/grill/answering';
import {answersPrompt, askPrompt, askedQuestionNumber, waitWhatPrompt} from '../../domain/grill/reply';
import {roundOfTurn} from '../../domain/grill/round';
import type {
    Answering,
    EndedTurn,
    GrillAnswer,
    GrillResult,
    GrillSendState,
    GrillView,
    Round,
} from '../../domain/grill/model';
import type {AskedQuestions, Question, QuestionsOutcome} from '../../domain/questions/question';
import type {ActiveSession} from '../model/active-session';
import type {SessionRegistry} from '../model/session-registry';
import type {Disposable} from '../ports/git-workspace';
import type {Logger} from '../ports/logger';
import type {HookReceiver} from '../ports/question-hook';
import type {RendererGateway} from '../ports/renderer-gateway';
import type {SessionPrompter} from '../ports/session-prompter';
import type {PendingQuestionsHandle, QuestionReply, QuestionService} from './question-service';

/** Where a call came from: the Mac's card or a paired phone. */
export type GrillFrom = 'mac' | 'phone';

export const ROUND_CLOSED = 'This round is no longer open';
export const ANSWER_FIRST = 'Answer a question first';
export const BUSY_SEND = 'Claude is busy; send once it stops';
export const BUSY_ASK = 'Claude is busy; ask once it stops';
export const QUESTION_GONE = 'Claude dropped this question from the round';

/** The label the old phone app shows as the recommended option of a round's question. */
export const GRILL_YES_LABEL = 'Yes (Recommended)';
export const WAIT_WHAT_LABEL = 'Wait, what?';

export interface GrillServiceDeps {
    registry: SessionRegistry;
    renderer: Pick<RendererGateway, 'grillChanged'>;
    prompter: Pick<SessionPrompter, 'send' | 'isBusy' | 'onIdle' | 'onExit'>;
    questions: Pick<QuestionService, 'receive' | 'openRound' | 'closeRound'>;
    log: Logger;
}

/** An ask typed (or about to be), its prompt not yet back through the hook. */
interface RegisteredAsk {
    /** The question it is about, in the current revision; null once a revision dropped it. */
    place: number | null;
    prompt: string;
}

interface OpenRound {
    /** The id of the block that first posted the round. */
    readonly id: string;
    /** The block that posted the latest revision: the same block again is no revision. */
    lastBlockId: string;
    /** Every revision as Claude posted it, by revision number, for answers given against an older one. */
    readonly revisions: Map<number, Round>;
    answering: Answering;
    asks: RegisteredAsk[];
    /** By place in the current revision. */
    asked: Set<number>;
    explanations: Map<number, string>;
    /** The place an ask is under way for: its prompt went in, its turn has not ended. */
    asking: number | null;
    send: GrillSendState;
}

/** What is kept per running session. */
interface Grilling {
    /** The registry key when first seen; the fallback id when it never re-keys. */
    readonly key: string;
    round: OpenRound | null;
    /** Background agents seen starting and not yet seen stopping. */
    readonly agents: Set<string>;
    /** Claude has stopped since the last agent did (or none ever ran). */
    stoppedSinceAgents: boolean;
    exitWatch: Disposable | null;
    idleWatch: Disposable | null;
}

export class GrillService implements HookReceiver {
    private readonly bySession = new Map<ActiveSession, Grilling>();

    constructor(private readonly deps: GrillServiceDeps) {}

    // ── The hooks ──

    /** AskUserQuestion is the QuestionService's. */
    public receive(launchId: string, asked: AskedQuestions, reply: QuestionReply): PendingQuestionsHandle {
        return this.deps.questions.receive(launchId, asked, reply);
    }

    /**
     * A turn ended. A round it posted opens, or revises the open one; the
     * turn of an ask explains its question. Then a queued send may be due.
     */
    public turnEnded(launchId: string, turn: EndedTurn, backgroundAgents: string[] | null): void {
        const found = this.deps.registry.find(launchId);
        if (!found) return;
        const {session, key} = found;
        const grilling = this.grilling(session, key);

        if (backgroundAgents !== null) {
            grilling.agents.clear();
            for (const id of backgroundAgents) grilling.agents.add(id);
        }
        grilling.stoppedSinceAgents = true;

        const posted = roundOfTurn(turn);
        const open = grilling.round;
        let posting = false;
        if (!open) {
            if (posted) posting = this.open(session, grilling, posted.id, posted.round);
        } else if (open.asking !== null) {
            const place = open.asking;
            open.asking = null;
            if (posted && posted.round.questions.length >= open.answering.questions.length) {
                posting = this.revise(open, posted.id, posted.round);
            } else {
                const text = turn.texts.map((block) => block.text.trim()).join('\n\n');
                if (text) open.explanations.set(place, text);
            }
        } else if (posted) {
            posting = this.revise(open, posted.id, posted.round);
        }
        // A Stop after an ask was typed means its prompt came back already, or never will.
        if (grilling.round) grilling.round.asks = [];

        // The card's view first, so the renderer has it when the pending set arrives.
        if (open || grilling.round) this.changed(session, grilling);
        if (posting) this.updatePending(grilling);
        this.checkQueue(session, grilling);
    }

    /**
     * A prompt went in. One of Switchboard's asks leaves the round open and
     * marks its question asked; anything else is the user's reply, typed in
     * the terminal, and closes the round.
     */
    public promptSubmitted(launchId: string, prompt: string): void {
        const found = this.deps.registry.find(launchId);
        if (!found) return;
        const grilling = this.bySession.get(found.session);
        const open = grilling?.round;
        if (!grilling || !open) return;

        const place = this.askOf(open, prompt);
        if (place === undefined) {
            this.deps.log.info(`[grill] session=${this.currentId(found.session, grilling)} replied in the terminal`);
            this.close(found.session, grilling, 'withdrawn');
            return;
        }
        if (place !== null) {
            open.asked.add(place);
            open.asking = place;
        }
        this.changed(found.session, grilling);
    }

    /** A background agent started or stopped; a stop counts only for an agent seen starting. */
    public subagentChanged(launchId: string, event: 'start' | 'stop', agentId: string): void {
        const found = this.deps.registry.find(launchId);
        if (!found) return;
        const grilling = this.grilling(found.session, found.key);
        if (event === 'start') {
            grilling.agents.add(agentId);
            grilling.stoppedSinceAgents = false;
        } else {
            if (!grilling.agents.delete(agentId)) return;
            if (grilling.agents.size === 0) grilling.stoppedSinceAgents = false;
        }
        if (grilling.round) this.changed(found.session, grilling);
        this.checkQueue(found.session, grilling);
    }

    // ── The card's calls (IPC and phone) ──

    /** Every open round, for a renderer or phone that has just (re)loaded. */
    public views(): GrillView[] {
        const views: GrillView[] = [];
        for (const [session, grilling] of this.bySession) {
            const view = this.view(session, grilling);
            if (view) views.push(view);
        }
        return views;
    }

    /**
     * Draft (or clear, for null) the answer to the question at `place` of
     * revision `revision`. An answer given against an older revision lands
     * on the question it became.
     */
    public answer(
        sessionId: string,
        roundId: string,
        revision: number,
        place: number,
        answer: GrillAnswer | null,
        from: GrillFrom = 'mac',
    ): GrillResult {
        const target = this.find(sessionId, roundId);
        if (!target) return {ok: false, error: ROUND_CLOSED};
        const {session, grilling, open} = target;
        const answering = open.answering;
        if (revision === answering.revision) {
            if (!answering.questions[place]) return {ok: false, error: QUESTION_GONE};
            open.answering = answerAt(answering, place, answer);
        } else {
            const older = open.revisions.get(revision);
            if (!older || !older.questions[place]) return {ok: false, error: ROUND_CLOSED};
            open.answering = answerAgainst(answering, older, place, answer);
        }
        this.deps.log.info(`[grill] session=${this.currentId(session, grilling)} answer on ${from}`);
        this.changed(session, grilling);
        return {ok: true};
    }

    /**
     * Ask about the question at `place`: `text` is the user's question, or
     * null for Wait, what?. The round stays open. Refused while Claude is busy,
     * since a prompt typed mid-turn waits in the input box.
     */
    public ask(sessionId: string, roundId: string, revision: number, place: number, text: string | null): GrillResult {
        const target = this.find(sessionId, roundId);
        if (!target) return {ok: false, error: ROUND_CLOSED};
        const {session, grilling, open} = target;
        const current = this.placeNow(open, revision, place);
        if (current === null) return {ok: false, error: QUESTION_GONE};
        if (this.deps.prompter.isBusy(grilling.key)) return {ok: false, error: BUSY_ASK};

        const number = open.answering.questions[current].question.number;
        const prompt = text === null ? waitWhatPrompt(number) : askPrompt(number, text);
        // Registered first: its echo through UserPromptSubmit must find it.
        open.asks.push({place: current, prompt});
        this.deps.log.info(`[grill] session=${this.currentId(session, grilling)} asks about Q${number}`);
        this.deps.prompter.send(grilling.key, prompt);
        return {ok: true};
    }

    /** Type the answers in now. The round closes as answered. */
    public send(sessionId: string, roundId: string, from: GrillFrom = 'mac'): GrillResult {
        const target = this.find(sessionId, roundId);
        if (!target) return {ok: false, error: ROUND_CLOSED};
        return this.sendNow(target.session, target.grilling, target.open, from);
    }

    /** Send when research is done: once no agent runs, no ask is under way, and Claude has stopped since. */
    public queue(sessionId: string, roundId: string): GrillResult {
        const target = this.find(sessionId, roundId);
        if (!target) return {ok: false, error: ROUND_CLOSED};
        const {session, grilling, open} = target;
        if (!this.prompt(open)) return {ok: false, error: ANSWER_FIRST};
        open.send = 'queued';
        this.changed(session, grilling);
        this.checkQueue(session, grilling);
        return {ok: true};
    }

    /** Take back a queued send (or dismiss the note that a revision cancelled one). */
    public cancelQueue(sessionId: string, roundId: string): GrillResult {
        const target = this.find(sessionId, roundId);
        if (!target) return {ok: false, error: ROUND_CLOSED};
        const {session, grilling, open} = target;
        open.send = 'idle';
        this.stopWaitingForIdle(grilling);
        this.changed(session, grilling);
        return {ok: true};
    }

    // ── The round ──

    private open(session: ActiveSession, grilling: Grilling, id: string, round: Round): true {
        grilling.round = {
            id,
            lastBlockId: id,
            revisions: new Map([[0, round]]),
            answering: startAnswering(round),
            asks: [],
            asked: new Set(),
            explanations: new Map(),
            asking: null,
            send: 'idle',
        };
        this.deps.log.info(
            `[grill] session=${this.currentId(session, grilling)} round ${id} of ${round.questions.length} question(s)`,
        );
        return true;
    }

    /**
     * Claude posted the round again: drafts, asks and explanations follow
     * their questions. False when it is the very block already shown.
     */
    private revise(open: OpenRound, blockId: string, round: Round): boolean {
        if (blockId === open.lastBlockId) return false;
        const before = open.answering;
        const matches = matchQuestions(before.round.questions, round.questions);
        const moved = (place: number | null): number | null => {
            if (place === null) return null;
            const target = matches.indexOf(place);
            return target < 0 ? null : target;
        };
        open.answering = revise(before, round);
        open.lastBlockId = blockId;
        open.revisions.set(open.answering.revision, round);
        open.asked = new Set([...open.asked].map(moved).filter((p): p is number => p !== null));
        open.explanations = new Map(
            [...open.explanations]
                .map(([place, text]) => [moved(place), text] as const)
                .filter((entry): entry is [number, string] => entry[0] !== null),
        );
        open.asks = open.asks.map((ask) => ({...ask, place: moved(ask.place)}));
        open.asking = moved(open.asking);
        if (open.send === 'queued') open.send = 'unsent';
        return true;
    }

    /**
     * Whether a prompt is one of the asks: the place it asks about (null when
     * a revision dropped it), or undefined when it is no ask at all. An ask
     * typed by hand is known by its wording.
     */
    private askOf(open: OpenRound, prompt: string): number | null | undefined {
        const text = prompt.trim();
        const index = open.asks.findIndex((ask) => ask.prompt.trim() === text);
        if (index >= 0) return open.asks.splice(index, 1)[0].place;
        const number = askedQuestionNumber(text);
        if (number === null) return undefined;
        const place = open.answering.questions.findIndex((q) => q.question.number === number);
        return place < 0 ? undefined : place;
    }

    /** Close the round: replied to, sent, or the session ended. */
    private close(session: ActiveSession, grilling: Grilling, outcome: QuestionsOutcome, answeredOn?: GrillFrom): void {
        if (!grilling.round) return;
        grilling.round = null;
        this.stopWaitingForIdle(grilling);
        this.changed(session, grilling);
        this.deps.questions.closeRound(grilling.key, outcome, answeredOn);
    }

    private sendNow(session: ActiveSession, grilling: Grilling, open: OpenRound, from: GrillFrom): GrillResult {
        const prompt = this.prompt(open);
        if (!prompt) return {ok: false, error: ANSWER_FIRST};
        if (this.deps.prompter.isBusy(grilling.key)) return {ok: false, error: BUSY_SEND};
        this.deps.log.info(`[grill] session=${this.currentId(session, grilling)} sends round ${open.id} from ${from}`);
        // Closed first: the prompt typed in comes back through UserPromptSubmit, which must find nothing open.
        this.close(session, grilling, 'answered', from);
        this.deps.prompter.send(grilling.key, prompt);
        return {ok: true};
    }

    private prompt(open: OpenRound): string {
        return answersPrompt(open.answering.questions.map((q) => ({number: q.question.number, answer: q.answer})));
    }

    /** The place in the current revision of the question at `place` of `revision`; null when gone. */
    private placeNow(open: OpenRound, revision: number, place: number): number | null {
        const answering = open.answering;
        if (revision === answering.revision) return answering.questions[place] ? place : null;
        const from = open.revisions.get(revision);
        if (!from || !from.questions[place]) return null;
        return carry(from, place, answering.round)?.place ?? null;
    }

    // ── Send when research is done ──

    /** Send a queued round once it is due; wait for the prompt when Claude is busy. */
    private checkQueue(session: ActiveSession, grilling: Grilling): void {
        const open = grilling.round;
        if (!open || open.send !== 'queued') return;
        const due =
            grilling.agents.size === 0 && open.asking === null && open.asks.length === 0 && grilling.stoppedSinceAgents;
        if (!due) return;
        if (this.deps.prompter.isBusy(grilling.key)) {
            grilling.idleWatch ??= this.deps.prompter.onIdle(grilling.key, () => {
                this.stopWaitingForIdle(grilling);
                if (this.bySession.get(session) === grilling) this.checkQueue(session, grilling);
            });
            return;
        }
        const result = this.sendNow(session, grilling, open, 'mac');
        if (!result.ok) {
            this.deps.log.info(`[grill] queued send not sent: ${result.error}`);
            open.send = 'idle';
            this.changed(session, grilling);
        }
    }

    private stopWaitingForIdle(grilling: Grilling): void {
        grilling.idleWatch?.dispose();
        grilling.idleWatch = null;
    }

    // ── Bookkeeping ──

    private grilling(session: ActiveSession, key: string): Grilling {
        const known = this.bySession.get(session);
        if (known) return known;
        const grilling: Grilling = {
            key,
            round: null,
            agents: new Set(),
            stoppedSinceAgents: true,
            exitWatch: null,
            idleWatch: null,
        };
        this.bySession.set(session, grilling);
        grilling.exitWatch = this.deps.prompter.onExit(key, () => {
            if (this.bySession.get(session) !== grilling) return;
            this.close(session, grilling, 'withdrawn');
            grilling.exitWatch?.dispose();
            this.stopWaitingForIdle(grilling);
            this.bySession.delete(session);
        });
        return grilling;
    }

    private find(
        sessionId: string,
        roundId: string,
    ): {session: ActiveSession; grilling: Grilling; open: OpenRound} | null {
        const found = this.deps.registry.find(sessionId);
        const grilling = found ? this.bySession.get(found.session) : undefined;
        const open = grilling?.round;
        if (!found || !grilling || !open || open.id !== roundId) return null;
        return {session: found.session, grilling, open};
    }

    /** Opens or refreshes the round's pending set, whose questions summarise the current revision. */
    private updatePending(grilling: Grilling): void {
        const open = grilling.round;
        if (!open) return;
        this.deps.questions.openRound(grilling.key, `grill-${open.id}`, summaryQuestions(open.answering.round));
    }

    private changed(session: ActiveSession, grilling: Grilling): void {
        this.deps.renderer.grillChanged({
            sessionId: this.currentId(session, grilling),
            view: this.view(session, grilling),
        });
    }

    private view(session: ActiveSession, grilling: Grilling): GrillView | null {
        const open = grilling.round;
        if (!open) return null;
        const {answering} = open;
        return {
            sessionId: this.currentId(session, grilling),
            roundId: open.id,
            revision: answering.revision,
            preamble: answering.round.preamble,
            questions: answering.questions.map((q, place) => ({
                ...q.question,
                answer: q.answer,
                setAside: q.setAside,
                mark: q.mark,
                asked: open.asked.has(place),
                explanation: open.explanations.get(place) ?? null,
            })),
            dropped: answering.dropped,
            agentsRunning: grilling.agents.size,
            send: open.send,
            asking: open.asking,
        };
    }

    /** The id the renderer knows a session by now, as QuestionService computes it. */
    private currentId(session: ActiveSession, grilling: Grilling): string {
        return session.realSessionId || grilling.key;
    }
}

/**
 * A round as a pending set of questions, for the sidebar's count and the old
 * phone app, which shows it as a question sheet: the title asked, the
 * recommendation as the recommended yes.
 */
export function summaryQuestions(round: Round): Question[] {
    return round.questions.map((q) => ({
        question: q.title,
        header: `Q${q.number}`,
        options: [
            {label: GRILL_YES_LABEL, description: q.recommendation},
            {label: WAIT_WHAT_LABEL, description: ''},
        ],
        multiSelect: false,
        detail: q.reason,
    }));
}
