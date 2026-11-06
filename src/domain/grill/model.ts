/**
 * A grilling round: the numbered questions a session running a grilling skill
 * writes out at the end of a turn, each with a reason and a recommendation,
 * which the user answers together.
 *
 * Claude writes a round as plain text in the skill's own format: a `❓` line
 * with a number per question, the reason after it, and a `➡️` line with the
 * recommendation. Switchboard reads it from the turn that posted it, shows it
 * on the grilling card one question at a time, and types the answers into the
 * session as one prompt.
 *
 * A round may be revised before the user replies, typically once its research
 * agents have reported back. A revision keeps the draft answer of every
 * question it left unchanged, sets aside the answer of a question it changed,
 * marks the questions it added, and drops the ones it no longer asks.
 *
 * These are the shapes shared by the parser, the main-process GrillService,
 * the renderer's grilling card and the phone. Everything here is plain JSON.
 */

/** One lettered choice a question's reason offers inline: `(a) Forever; (b) 30 days`. */
export interface Choice {
    /** `a`, `b`, … in order. */
    letter: string;
    text: string;
}

/** A reason split around its inline choices. */
export interface Choices {
    /** The reason's text before the first choice. */
    lead: string;
    list: Choice[];
    /** The reason's text after the last choice's sentence. */
    after: string;
}

export interface RoundQuestion {
    /** The number as the round printed it; may restart or repeat across rounds. */
    number: number;
    /** Inline Markdown. */
    title: string;
    /** Markdown: the rest of the header line and every line up to the recommendation. */
    reason: string;
    /** Markdown: the `➡️` line and what follows it, without the mark. */
    recommendation: string;
    /** Present only when the reason offers two or more inline lettered choices. */
    choices?: Choices;
    /** The letter the recommendation opens with, when it names one of the choices. */
    recommendedChoice?: string;
}

export interface Round {
    /** Markdown the round's text block opens with before its first question; '' when none. */
    preamble: string;
    questions: RoundQuestion[];
}

/** A draft answer to one question. */
export type GrillAnswer = {kind: 'accepted'} | {kind: 'noted'; note: string} | {kind: 'overridden'; text: string};

/** How a revision touched a question. */
export type Mark = 'changed' | 'new';

export interface AnsweringQuestion {
    question: RoundQuestion;
    answer: GrillAnswer | null;
    /** The answer given before a revision changed the question: shown, never sent. */
    setAside: GrillAnswer | null;
    mark: Mark | null;
}

/** The open round with its draft answers, as revisions leave it. */
export interface Answering {
    round: Round;
    questions: AnsweringQuestion[];
    /** Questions revisions dropped, counted across revisions; one added and dropped again is not counted. */
    dropped: number;
    /** 0 for the round as first posted, +1 per revision. */
    revision: number;
}

/**
 * The text blocks of the turn that just ended, in order, as the hook server
 * read them from the transcript (or, failing that, the Stop hook's last
 * message alone). A turn starts at a prompt or at Claude being woken by a
 * background task. The last block is the round's candidate: text written
 * after a round means the turn has no round. `id` identifies the block (the
 * transcript line's uuid), and so the round it posts.
 */
export interface EndedTurn {
    texts: {id: string; text: string}[];
}

// ── What the renderer and the phone see ──

export interface GrillQuestionView extends RoundQuestion {
    answer: GrillAnswer | null;
    setAside: GrillAnswer | null;
    mark: Mark | null;
    /** The user asked about this question (Ask about this, or Wait, what?) and the session has seen it. */
    asked: boolean;
    /** The text of the turn that answered the ask, once it has ended. */
    explanation: string | null;
}

/**
 * idle: nothing queued. queued: Send when research is done, waiting. unsent:
 * a revision cancelled a queued send; the card says so until the user acts.
 */
export type GrillSendState = 'idle' | 'queued' | 'unsent';

export interface GrillView {
    /** The session's current id (what the renderer knows it as). */
    sessionId: string;
    /** The id of the text block that first posted the round; stable across revisions. */
    roundId: string;
    /** Bumped by each revision; answers name the revision they were given against. */
    revision: number;
    preamble: string;
    questions: GrillQuestionView[];
    /** Questions revisions dropped, as in Answering. */
    dropped: number;
    /** Background agents of the session still running. */
    agentsRunning: number;
    send: GrillSendState;
    /** The question (by place) an ask is under way for: typed, its turn not ended yet. */
    asking: number | null;
}

/** A round opened, changed or closed; `view` is null once it closed (sent, replied to, or the session ended). */
export interface GrillChanged {
    sessionId: string;
    view: GrillView | null;
}

/** Every call the renderer or the phone makes answers with this. */
export interface GrillResult {
    ok: boolean;
    /** Why not, in words for the card: "Answer a question first", "Claude is busy; send once it stops". */
    error?: string;
}
