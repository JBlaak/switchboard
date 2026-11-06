/**
 * What Switchboard types into a grilling session: the answers to a round, and
 * the asks about one of its questions.
 *
 * Answers go in as one prompt, one line per answered question in the round's
 * own numbering, so Claude reads them the way the skill asked for them:
 *
 *     Q1: yes
 *     Q2: (b) 30 days, then drop the row
 *     Q4: yes, note: keep it behind a flag
 *
 * A question without an answer is left out. An answer is collapsed onto its
 * line, since a newline inside it would read as the next question's answer.
 *
 * An ask leaves the round open: Claude answers it in a turn of its own, and
 * Switchboard recognises its own wording when it sees the prompt come back
 * through the UserPromptSubmit hook, so it does not mistake it for a reply.
 */
import type {GrillAnswer} from './model';

/** The prompt that answers a round; '' when nothing is answered. */
export function answersPrompt(questions: readonly {number: number; answer: GrillAnswer | null}[]): string {
    return questions
        .filter((q): q is {number: number; answer: GrillAnswer} => q.answer !== null)
        .map((q) => `Q${q.number}: ${answerText(q.answer)}`)
        .join('\n');
}

/** One answer as it goes on its line, after `Q<n>: `. */
export function answerText(answer: GrillAnswer): string {
    switch (answer.kind) {
        case 'accepted':
            return 'yes';
        case 'noted':
            return `yes, note: ${oneLine(answer.note)}`;
        case 'overridden':
            return oneLine(answer.text);
    }
}

const ASK_PREFIX = 'Before I answer the round, about Q';

/** Ask about this: a question about one question, with what the user typed. */
export function askPrompt(number: number, text: string): string {
    return `${ASK_PREFIX}${number}: ${oneLine(text)}`;
}

/** Wait, what?: have Claude re-pitch one question in plain words. */
export function waitWhatPrompt(number: number): string {
    return `/wait-what Q${number}`;
}

/** The question number a prompt asks about, when it is one of Switchboard's asks; null for anything else. */
export function askedQuestionNumber(prompt: string): number | null {
    const text = prompt.trim();
    // The prompt is trimmed, so an ask with nothing typed ends at its colon.
    const ask = /^Before I answer the round, about Q(\d+):(?:\s|$)/.exec(text);
    if (ask) return Number(ask[1]);
    const wait = /^\/wait-what Q(\d+)$/.exec(text);
    if (wait) return Number(wait[1]);
    return null;
}

function oneLine(text: string): string {
    return text.trim().replace(/\s+/g, ' ');
}
