/**
 * The grilling card's own working state for one round, and the answers it has
 * in flight to main.
 *
 * The draft answers are main's (they arrive in every `GrillView`); what is the
 * card's is where the user is in the round, which fields are open and what is
 * typed in them, whether the context is folded away, what became of the
 * revision banner, and the last error. It is kept per session and round
 * outside the component, so switching sessions and coming back finds it as it
 * was left.
 *
 * A revision can add, drop and reorder questions, so the place and the open
 * fields follow their questions by number and title, the way main matches
 * them.
 *
 * An answer shows as soon as it is given: it is laid over main's view until
 * its call has settled, so a snapshot main sent before it had the answer
 * cannot take it away again.
 */
import {bannerSeenFor} from './grill-banner';
import type {BannerSeen} from './grill-banner';
import {questionLabel} from '../../../domain/grill/model';
import type {GrillAnswer, GrillQuestionView, GrillView, RoundQuestion} from '../../../domain/grill/model';

export type FieldKind = 'note' | 'override' | 'ask';

/** An open field: a note, an answer of one's own, or a question about the question. */
export interface GrillField {
    kind: FieldKind;
    text: string;
}

export interface GrillCardUi {
    roundId: string;
    /** The question on screen; `questions.length` is the review. */
    place: number;
    /** Open fields by place: a field stays open, with its text, while the user looks at another question. */
    fields: Readonly<Record<number, GrillField>>;
    /** The context (the round's preamble) is unfolded; once folded, it stays so for the round. */
    contextOpen: boolean;
    banner: BannerSeen;
    /** The last call's error, shown in the footer until the next one goes through. */
    error: string | null;
}

/** The working state of a round the card has not touched yet. */
export function freshUi(roundId: string, revision: number): GrillCardUi {
    return {roundId, place: 0, fields: {}, contextOpen: true, banner: bannerSeenFor(null, revision), error: null};
}

/** A title as revisions compare it: lower case, punctuation and symbols as spaces, spaces collapsed. */
export function normalisedTitle(title: string): string {
    return title
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

/**
 * Where a question of the old round went in the new one: by number and title
 * first, then by title alone. Null when the revision dropped it.
 */
export function followQuestion(
    before: readonly Pick<RoundQuestion, 'number' | 'suffix' | 'title'>[],
    after: readonly Pick<RoundQuestion, 'number' | 'suffix' | 'title'>[],
    place: number,
): number | null {
    const question = before[place];
    if (!question) return null;
    const title = normalisedTitle(question.title);
    const both = after.findIndex(
        (q) => questionLabel(q) === questionLabel(question) && normalisedTitle(q.title) === title,
    );
    if (both >= 0) return both;
    const byTitle = after.findIndex((q) => normalisedTitle(q.title) === title);
    return byTitle >= 0 ? byTitle : null;
}

/**
 * The working state after a revision: the place follows its question (or
 * stays as near as the new round allows when it was dropped; the review stays
 * the review), and each open field follows its question or goes with it.
 */
export function reviseUi(
    ui: GrillCardUi,
    before: readonly GrillQuestionView[],
    after: readonly GrillQuestionView[],
): GrillCardUi {
    const place =
        ui.place >= before.length
            ? after.length
            : (followQuestion(before, after, ui.place) ?? Math.min(ui.place, Math.max(after.length - 1, 0)));
    const fields: Record<number, GrillField> = {};
    for (const [at, field] of Object.entries(ui.fields)) {
        const moved = followQuestion(before, after, Number(at));
        if (moved !== null) fields[moved] = field;
    }
    return {...ui, place, fields};
}

/** The text a field opens with: the answer it would edit, or what was already typed in it. */
export function fieldText(question: GrillQuestionView, kind: FieldKind, open: GrillField | undefined): string {
    if (open && open.kind === kind) return open.text;
    const answer = question.answer;
    if (kind === 'note' && answer?.kind === 'noted') return answer.note;
    if (kind === 'override' && answer?.kind === 'overridden') return answer.text;
    return '';
}

/** What Enter (or the field's button) does with a field. */
export interface FieldCommit {
    /** The answer to give the question, if any. */
    answer: GrillAnswer | null;
    /** The text to ask Claude about the question, if any. */
    ask: string | null;
    /** Go on to the next question. */
    advance: boolean;
}

/**
 * Committing a field. A note answers (an empty one is a plain accept); an
 * answer of one's own answers when there is text; an ask asks when there is
 * text and leaves the user where they are. The field closes either way.
 */
export function commitField(field: GrillField): FieldCommit {
    const text = field.text.trim();
    switch (field.kind) {
        case 'note':
            return {answer: text ? {kind: 'noted', note: text} : {kind: 'accepted'}, ask: null, advance: true};
        case 'override':
            return text
                ? {answer: {kind: 'overridden', text}, ask: null, advance: true}
                : {answer: null, ask: null, advance: false};
        case 'ask':
            return {answer: null, ask: text || null, advance: false};
    }
}

/** An answer given here and not yet settled by main. */
export interface InFlightAnswer {
    /** Orders the calls; a later one for the same place wins. */
    seq: number;
    roundId: string;
    /** The revision it was given against. */
    revision: number;
    place: number;
    answer: GrillAnswer | null;
    /** Main answered ok, but no snapshot has come since that could show it. */
    settled: boolean;
}

/**
 * The view as the card shows it: each place's latest answer in flight laid
 * over main's, for the revision it was given against. The view itself when
 * nothing applies.
 */
export function withInFlight(view: GrillView, inFlight: readonly InFlightAnswer[]): GrillView {
    const latest = new Map<number, InFlightAnswer>();
    for (const entry of inFlight) {
        if (entry.roundId !== view.roundId || entry.revision !== view.revision) continue;
        if (entry.place >= view.questions.length) continue;
        const other = latest.get(entry.place);
        if (!other || other.seq < entry.seq) latest.set(entry.place, entry);
    }
    if (latest.size === 0) return view;
    const questions = view.questions.map((q, place) => {
        const entry = latest.get(place);
        return entry ? {...q, answer: entry.answer} : q;
    });
    return {...view, questions};
}

/** Two answers say the same. */
export function sameAnswer(a: GrillAnswer | null, b: GrillAnswer | null): boolean {
    if (a === null || b === null) return a === b;
    if (a.kind !== b.kind) return false;
    if (a.kind === 'noted' && b.kind === 'noted') return a.note === b.note;
    if (a.kind === 'overridden' && b.kind === 'overridden') return a.text === b.text;
    return true;
}
