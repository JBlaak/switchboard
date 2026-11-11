/**
 * The draft answers to an open grilling round, and how a revision of the
 * round carries them over.
 *
 * Claude often posts a round, sends agents off to research, and posts it
 * again once they report back, with some questions reworded, some new and
 * some gone. The user may have started answering in between. A revision
 * keeps what still holds and shows what moved:
 *
 * - Questions are matched new to old, first by label (`2`, `2a`) and title, then by
 *   title alone, since a revision often renumbers. Titles compare loosely:
 *   case, punctuation and spacing aside. A number reused with another title
 *   is a new question.
 * - A question whose reason and recommendation are unchanged (whitespace
 *   aside) keeps its answer, set-aside answer and mark.
 * - A changed question is marked `changed` (or stays `new` if a revision
 *   added it), and its answer is set aside: shown, but no longer sent, since
 *   it answered something else.
 * - A question no older one matches is `new`; an old one nothing matches is
 *   dropped with its answer and counted, unless a revision had added it.
 *
 * Everything here returns new objects; nothing is changed in place.
 */
import {questionLabel} from './model';
import type {Answering, AnsweringQuestion, GrillAnswer, Round, RoundQuestion} from './model';

/** A round as first posted: nothing answered, nothing marked. */
export function startAnswering(round: Round): Answering {
    return {
        round,
        questions: round.questions.map((question) => ({question, answer: null, setAside: null, mark: null})),
        dropped: 0,
        revision: 0,
    };
}

/** The drafts after Claude posted `round` as a revision of the open one. */
export function revise(answering: Answering, round: Round): Answering {
    const matches = matchQuestions(answering.round.questions, round.questions);
    const questions = round.questions.map((question, place): AnsweringQuestion => {
        const from = matches[place];
        if (from === null) return {question, answer: null, setAside: null, mark: 'new'};
        const old = answering.questions[from];
        if (sameQuestion(old.question, question)) return {...old, question};
        return {
            question,
            answer: null,
            setAside: old.answer ?? old.setAside,
            mark: old.mark === 'new' ? 'new' : 'changed',
        };
    });
    const kept = new Set(matches);
    const dropped = answering.questions.filter((old, place) => !kept.has(place) && old.mark !== 'new').length;
    return {round, questions, dropped: answering.dropped + dropped, revision: answering.revision + 1};
}

/**
 * The drafts with the question at `place` answered (or cleared, for null).
 * A fresh answer replaces whatever was set aside.
 */
export function answerAt(answering: Answering, place: number, answer: GrillAnswer | null): Answering {
    if (!answering.questions[place]) return answering;
    return {
        ...answering,
        questions: answering.questions.map((q, i) => (i === place ? {...q, answer, setAside: null} : q)),
    };
}

/**
 * The drafts with an answer the user gave against an older revision `from`,
 * to its question at `place`, carried to the question it became: answered
 * there when that question is unchanged, set aside when it changed, and let
 * go when the question was dropped.
 */
export function answerAgainst(answering: Answering, from: Round, place: number, answer: GrillAnswer | null): Answering {
    const target = carry(from, place, answering.round);
    if (!target) return answering;
    if (target.same) return answerAt(answering, target.place, answer);
    return {
        ...answering,
        questions: answering.questions.map((q, i) => (i === target.place ? {...q, setAside: answer} : q)),
    };
}

/**
 * For each question of `to`, the place of the question of `from` it
 * continues, or null when it is new. Pass one matches number and title, pass
 * two title alone; each old question matches at most once.
 */
export function matchQuestions(from: readonly RoundQuestion[], to: readonly RoundQuestion[]): (number | null)[] {
    const used = new Set<number>();
    const matches: (number | null)[] = to.map(() => null);
    const pass = (same: (a: RoundQuestion, b: RoundQuestion) => boolean) => {
        to.forEach((question, place) => {
            if (matches[place] !== null) return;
            const found = from.findIndex((old, i) => !used.has(i) && same(old, question));
            if (found < 0) return;
            used.add(found);
            matches[place] = found;
        });
    };
    pass((a, b) => questionLabel(a) === questionLabel(b) && normalTitle(a.title) === normalTitle(b.title));
    pass((a, b) => normalTitle(a.title) === normalTitle(b.title));
    return matches;
}

/**
 * Where the question at `place` of an older revision `from` went in `to`,
 * and whether it is the same question there (`same` false when it changed);
 * null when `to` dropped it.
 */
export function carry(from: Round, place: number, to: Round): {place: number; same: boolean} | null {
    const target = matchQuestions(from.questions, to.questions).indexOf(place);
    if (target < 0) return null;
    return {place: target, same: sameQuestion(from.questions[place], to.questions[target])};
}

/** What the card's revision banner counts: questions marked changed and new, and those dropped. */
export function revisionCounts(answering: Answering): {changed: number; added: number; dropped: number} {
    return {
        changed: answering.questions.filter((q) => q.mark === 'changed').length,
        added: answering.questions.filter((q) => q.mark === 'new').length,
        dropped: answering.dropped,
    };
}

/** A title for matching: lowercase, punctuation and symbols as spaces, spaces collapsed. */
function normalTitle(title: string): string {
    return title
        .toLowerCase()
        .replace(/[\p{P}\p{S}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Two versions of a question ask the same when reason and recommendation match, whitespace aside. */
function sameQuestion(a: RoundQuestion, b: RoundQuestion): boolean {
    return squash(a.reason) === squash(b.reason) && squash(a.recommendation) === squash(b.recommendation);
}

function squash(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}
