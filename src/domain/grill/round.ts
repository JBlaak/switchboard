/**
 * Reading a grilling round out of the text Claude ended its turn with.
 *
 * The grilling skill writes a round as plain Markdown, one block per
 * question:
 *
 *     ❓ **Q1** - **Keep the old API?**: Two callers still use it.
 *
 *     ➡️ Keep it for one more release, then drop it.
 *
 *     ---
 *
 * Claude does not write the header the same way every time, so the reader is
 * tolerant: the number may sit inside or outside the bold, the title may be
 * bold or run to the first colon, the separator may be a dash, colon or dot,
 * the number's prefix may be `Q`, Dutch `V`, `Vraag`, or nothing, the number
 * may be split by a letter (`Q2a`, `Q2b`) or primed (`Q4'`, `Q4′`), and the line may be a Markdown
 * heading. A `❓` line without a number is not a
 * question. Text before the first question is the round's preamble (usually
 * a recap of the last round); prose after the last recommendation, past a
 * blank line, closes the turn and is not part of the round.
 *
 * A text is a round only when every numbered question it has comes with a
 * `➡️` recommendation: a half-written question means Claude was not asking
 * the user to answer yet.
 */
import {recommendedLetter, splitChoices} from './choices';
import type {EndedTurn, Round, RoundQuestion} from './model';

/** A question's header line: `❓`, maybe inside a Markdown heading. */
const QUESTION_LINE = /^[ \t]*(?:#{1,6}[ \t]*)?❓️?[ \t]*(?:#{1,6}[ \t]+)?(.*)$/;

/** The line the recommendation starts on: `➡️`, with or without its variation selector. */
const RECOMMENDATION_LINE = /^[ \t]*(?:#{1,6}[ \t]*)?➡️?[ \t]*(.*)$/;

/** A horizontal rule, as rounds put between questions. */
const RULE = /^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/;

/**
 * The number, after a prefix of up to eight letters (`Q`, `V`, `Vraag`) or
 * none, maybe split by one lower-case letter (`Q2a`, `Q2b`) and maybe primed
 * with an apostrophe, prime or right quote (`Q4'`, `Q4′`, `Q2a’`, `Q4''`).
 */
const NUMBER = /^(?:\p{L}{1,8}[ \t]?)?(\d+)([a-z]?['′″’]*)/u;

/** A separator between number and title: dash, en or em dash, colon or dot. */
const SEPARATOR = /^[ \t]*[-–—:.]/;

interface Header {
    number: number;
    suffix?: string;
    title: string;
    /** What follows the title on the header line. */
    reason: string;
}

/**
 * The round a text holds, or null when it holds none: no numbered `❓`
 * question, or a numbered question without its `➡️` recommendation.
 */
export function parseRound(text: string): Round | null {
    const lines = text.split(/\r?\n/);
    const headers: {line: number; header: Header}[] = [];
    lines.forEach((line, index) => {
        const header = headerOf(line);
        if (header) headers.push({line: index, header});
    });
    if (headers.length === 0) return null;

    const questions: RoundQuestion[] = [];
    for (let k = 0; k < headers.length; k++) {
        const {line, header} = headers[k];
        const last = k === headers.length - 1;
        const body = lines.slice(line + 1, last ? lines.length : headers[k + 1].line);
        const question = questionOf(header, body, last);
        if (!question) return null;
        questions.push(question);
    }
    return {preamble: withoutTrailingRules(lines.slice(0, headers[0].line)).join('\n').trim(), questions};
}

/** The round a turn posted with its last text block, and that block's id; null when it is no round. */
export function roundOfTurn(turn: EndedTurn): {id: string; round: Round} | null {
    const last = turn.texts[turn.texts.length - 1];
    if (!last) return null;
    const round = parseRound(last.text);
    return round ? {id: last.id, round} : null;
}

/** A header line's number, title and the start of its reason; null for any other line. */
function headerOf(line: string): Header | null {
    const question = QUESTION_LINE.exec(line);
    if (!question) return null;
    let rest = question[1];

    // Bold that opens before the number may close right after it, or after the title.
    let bold = rest.startsWith('**');
    if (bold) rest = rest.slice(2).trimStart();

    const number = NUMBER.exec(rest);
    if (!number) return null;
    rest = rest.slice(number[0].length);

    let separated = false;
    let closed = false;
    const separator = SEPARATOR.exec(rest);
    if (separator) {
        separated = true;
        rest = rest.slice(separator[0].length);
    }
    if (bold && rest.trimStart().startsWith('**')) {
        bold = false;
        closed = true;
        rest = rest.trimStart().slice(2);
        const after = SEPARATOR.exec(rest);
        if (after) rest = rest.slice(after[0].length);
    }
    if (!separated && !closed) return null;
    rest = rest.trimStart();

    let title: string;
    let reason: string;
    if (bold) {
        [title, reason] = splitAt(rest, '**');
    } else if (rest.startsWith('**')) {
        [title, reason] = splitAt(rest.slice(2), '**');
    } else {
        [title, reason] = splitAt(rest, ':');
    }
    title = title.trim().replace(/[ \t]*:$/, '');
    if (!title) return null;
    const header: Header = {number: Number(number[1]), title, reason: reason.replace(/^[ \t]*:/, '').trim()};
    if (number[2]) header.suffix = number[2];
    return header;
}

/** The text before and after the first `mark`; all of it before when there is none. */
function splitAt(text: string, mark: string): [string, string] {
    const at = text.indexOf(mark);
    return at < 0 ? [text, ''] : [text.slice(0, at), text.slice(at + mark.length)];
}

/**
 * A question from its header and the lines up to the next one. The reason
 * runs to the `➡️` line; the recommendation from there to a rule, or for the
 * last question to the first blank line, since what follows that closes the
 * turn.
 */
function questionOf(header: Header, body: string[], last: boolean): RoundQuestion | null {
    const arrow = body.findIndex((line) => RECOMMENDATION_LINE.test(line));
    if (arrow < 0) return null;

    const reason = [header.reason, ...body.slice(0, arrow).filter((line) => !RULE.test(line))].join('\n').trim();

    const lines = [(RECOMMENDATION_LINE.exec(body[arrow]) ?? [])[1] ?? ''];
    for (const line of body.slice(arrow + 1)) {
        if (RULE.test(line)) break;
        if (last && line.trim() === '' && lines.some((l) => l.trim() !== '')) break;
        lines.push(line);
    }
    const recommendation = lines.join('\n').trim();
    if (!recommendation) return null;

    const question: RoundQuestion = {number: header.number, title: header.title, reason, recommendation};
    if (header.suffix) question.suffix = header.suffix;
    const choices = splitChoices(reason);
    if (choices) {
        question.choices = choices;
        const letter = recommendedLetter(recommendation, choices);
        if (letter) question.recommendedChoice = letter;
    }
    return question;
}

function withoutTrailingRules(lines: string[]): string[] {
    let end = lines.length;
    while (end > 0 && (lines[end - 1].trim() === '' || RULE.test(lines[end - 1]))) end--;
    return lines.slice(0, end);
}
