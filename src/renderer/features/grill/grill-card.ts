/**
 * What the grilling card shows and does, from a round's view alone.
 *
 * The card reads a `GrillView` (main's draft answers, with the renderer's own
 * answers in flight laid over it) and draws one question at a time, a tab per
 * question, a review page after the last one, and a footer with the ways to
 * send. Every rule about what those say — a tab's state, an answer in words,
 * which answer a choice makes, what Accept the rest answers, the text Claude
 * will receive — lives here, so the components only draw it.
 */
import {answersPrompt} from '../../../domain/grill/reply';
import {questionLabel} from '../../../domain/grill/model';
import type {GrillAnswer, GrillQuestionView, GrillView, Mark} from '../../../domain/grill/model';

/** How a question's tab is drawn: its answer's kind, asked about, or still open. */
export type QuestionState = 'open' | 'accepted' | 'overridden' | 'noted' | 'asked';

/** A question's tab: its state, and whether a revision changed or added it. */
export interface TabState {
    state: QuestionState;
    mark: Mark | null;
}

/**
 * The tab of one question. An answer wins over having asked about it: once
 * answered, the ask is history.
 */
export function tabState(question: GrillQuestionView): TabState {
    const state: QuestionState = question.answer ? question.answer.kind : question.asked ? 'asked' : 'open';
    return {state, mark: question.mark};
}

/** An answer in words, as the card and the review show it. */
export function answerLabel(answer: GrillAnswer | null): string {
    if (!answer) return 'Not answered';
    switch (answer.kind) {
        case 'accepted':
            return 'Accepted';
        case 'noted':
            return `Accepted, note: ${answer.note}`;
        case 'overridden':
            return `Your answer: ${answer.text}`;
    }
}

/** How many questions have a draft answer. */
export function answeredCount(view: Pick<GrillView, 'questions'>): number {
    return view.questions.filter((q) => q.answer !== null).length;
}

/**
 * The answer picking one of a question's inline choices makes: the
 * recommended letter accepts the recommendation, any other answers instead
 * with that choice spelled out (`(b) 30 days`). Null for a letter the
 * question does not offer.
 */
export function choiceAnswer(question: GrillQuestionView, letter: string): GrillAnswer | null {
    const choice = question.choices?.list.find((c) => c.letter === letter);
    if (!choice) return null;
    if (letter === question.recommendedChoice) return {kind: 'accepted'};
    return {kind: 'overridden', text: `(${choice.letter}) ${choice.text}`};
}

/**
 * The letter of the choice the question's answer amounts to, to mark it
 * picked: the recommended one when accepted (with or without a note), the one
 * an answer-instead opens with when it names a choice. Null otherwise.
 */
export function pickedChoice(question: GrillQuestionView): string | null {
    const answer = question.answer;
    if (!answer || !question.choices) return null;
    if (answer.kind !== 'overridden') return question.recommendedChoice ?? null;
    const letter = /^\((\w)\) /.exec(answer.text)?.[1];
    return letter && question.choices.list.some((c) => c.letter === letter) ? letter : null;
}

/** One draft answer to set, by the question's place. */
export interface PlacedAnswer {
    place: number;
    answer: GrillAnswer;
}

/**
 * Accept the rest: every question without an answer, a set-aside one
 * included, takes the recommendation. Answered questions keep theirs.
 */
export function acceptRest(view: Pick<GrillView, 'questions'>): PlacedAnswer[] {
    return view.questions.flatMap((q, place) =>
        q.answer === null ? [{place, answer: {kind: 'accepted'} as const}] : [],
    );
}

/**
 * The prompt Claude will receive, as the review previews it: one line per
 * answered question in the round's own numbering. A set-aside answer is shown
 * on its question but never sent.
 */
export function reviewPreview(view: Pick<GrillView, 'questions'>): string {
    return answersPrompt(view.questions);
}

/** What a question's flag on the review says about a revision; '' when it has none. */
export function reviewFlag(question: GrillQuestionView): string {
    if (question.mark === 'new') return 'New';
    if (question.mark === 'changed') return question.setAside ? 'Changed, earlier answer set aside' : 'Changed';
    return '';
}

/** The line under a question's title saying what a revision did to it; null when nothing. */
export function revisionNote(question: GrillQuestionView): string | null {
    if (question.mark === 'new') return 'Claude added this question.';
    if (question.mark === 'changed')
        return question.setAside
            ? 'Claude changed this question since you answered it.'
            : 'Claude changed this question.';
    return null;
}

/** The counter over a question's title: `Question 3 · 2 of 6`. */
export function questionCounter(view: Pick<GrillView, 'questions'>, place: number): string {
    const question = view.questions[place];
    return question ? `Question ${questionLabel(question)} · ${place + 1} of ${view.questions.length}` : '';
}

/**
 * The send buttons as they stand.
 *
 * - `queued`: Send when research is done is waiting; offer Cancel and Send now.
 * - `research`: agents are still running; offer to send when they are done, or now.
 * - `send`: nothing to wait for; plain Send.
 */
export type SendGroup = 'queued' | 'research' | 'send';

export function sendGroup(view: Pick<GrillView, 'send' | 'agentsRunning'>): SendGroup {
    if (view.send === 'queued') return 'queued';
    return view.agentsRunning > 0 ? 'research' : 'send';
}

/** One step through the round: → past the last question lands on the review, ← stops at the first. */
export function stepPlace(view: Pick<GrillView, 'questions'>, place: number, by: 1 | -1): number {
    return Math.max(0, Math.min(place + by, view.questions.length));
}

/** The place is the review page, after the last question. */
export function onReview(view: Pick<GrillView, 'questions'>, place: number): boolean {
    return place >= view.questions.length;
}
