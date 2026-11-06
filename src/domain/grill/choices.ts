/**
 * The lettered choices a grilling question offers inside its reason.
 *
 * A question often weighs a few options in running text rather than in a
 * list:
 *
 *     Only our row and the worktree cost space. (a) Forever; (b) 30 days,
 *     then drop the row; (c) Until its worktree is removed. Worktrees are
 *     often removed by hand.
 *
 * The grilling card shows those as a row of choices to pick from, with the
 * one the recommendation names marked. Two or more markers in a row, lettered
 * from `a` in order and written inline (`(a) …` or `a) …`), make a set of
 * choices; the last one ends with its sentence. A Markdown list in the reason
 * is left as text: the card already draws a list well, and its items are as
 * often notes as options.
 */
import type {Choice, Choices} from './model';

/**
 * A choice marker: `(a)` or `a)`, maybe bold, after the start of the text,
 * whitespace or punctuation that runs into a list, and before whitespace.
 */
const MARKER = /(?<=^|[\s:;,])(?:\*\*)?\(?([a-z])\)(?:\*\*)?(?=\s)/g;

/** What may stand before a marker on its line when the marker opens a list item. */
const LINE_OPENING = /^[ \t]*(?:[-*+•]|\d+[.)])?[ \t]*$/;

/** A paragraph break: choices written inline stay within one paragraph. */
const PARAGRAPH_BREAK = /\n[ \t]*\n/;

/** Where the last choice's sentence ends: a full stop, question or exclamation mark, or the line's end. */
const SENTENCE_END = /[.!?](?=\s|$)|\n/;

/** Joining words and punctuation a choice trails into the next one with. */
const TRAILING_JOIN = /[\s;,.]*(?:\b(?:or|and|of|en)\b)?[\s;,.]*$/;

interface Marker {
    letter: string;
    start: number;
    end: number;
}

/** The reason split around its inline choices, or undefined when it offers fewer than two. */
export function splitChoices(reason: string): Choices | undefined {
    const markers = [...reason.matchAll(MARKER)].map((m) => ({
        letter: m[1],
        start: m.index ?? 0,
        end: (m.index ?? 0) + m[0].length,
    }));
    for (let first = 0; first < markers.length; first++) {
        if (markers[first].letter !== 'a') continue;
        const run = runFrom(reason, markers, first);
        if (run.length < 2) continue;
        if (isList(reason, run)) return undefined;
        return choicesOf(reason, run);
    }
    return undefined;
}

/** The markers lettered a, b, c, … in a row from `first`, within one paragraph. */
function runFrom(reason: string, markers: Marker[], first: number): Marker[] {
    const run = [markers[first]];
    for (let next = first + 1; next < markers.length; next++) {
        const previous = run[run.length - 1];
        const expected = String.fromCharCode(previous.letter.charCodeAt(0) + 1);
        if (markers[next].letter !== expected) break;
        if (PARAGRAPH_BREAK.test(reason.slice(previous.end, markers[next].start))) break;
        run.push(markers[next]);
    }
    return run;
}

/** A run is a list when a choice after the first opens its own line. */
function isList(reason: string, run: Marker[]): boolean {
    return run.slice(1).some((marker) => {
        const lineStart = reason.lastIndexOf('\n', marker.start - 1) + 1;
        return LINE_OPENING.test(reason.slice(lineStart, marker.start));
    });
}

function choicesOf(reason: string, run: Marker[]): Choices | undefined {
    const list: Choice[] = [];
    for (let i = 0; i < run.length - 1; i++) {
        list.push({letter: run[i].letter, text: choiceText(reason.slice(run[i].end, run[i + 1].start))});
    }
    const last = run[run.length - 1];
    const rest = reason.slice(last.end);
    const end = SENTENCE_END.exec(rest);
    const lastText = end ? rest.slice(0, end[0] === '.' || end[0] === '\n' ? end.index : end.index + 1) : rest;
    const after = end ? rest.slice(end.index + 1) : '';
    list.push({letter: last.letter, text: choiceText(lastText)});
    if (list.some((choice) => choice.text === '')) return undefined;
    return {lead: reason.slice(0, run[0].start).trim(), list, after: after.trim()};
}

function choiceText(text: string): string {
    return text.trim().replace(TRAILING_JOIN, '').trim();
}

/**
 * The letter of the choice a recommendation opens with, as in `(b) 30 days:
 * predictable`, `a) Forever` or `**c)** …`; undefined when it opens with
 * anything else or names a letter the choices do not have.
 */
export function recommendedLetter(recommendation: string, choices: Choices): string | undefined {
    const match = /^\s*(?:\*\*)?\(?([a-z])\)(?:\*\*)?(?=[\s.:,;]|$)/.exec(recommendation);
    if (!match) return undefined;
    return choices.list.some((choice) => choice.letter === match[1]) ? match[1] : undefined;
}
