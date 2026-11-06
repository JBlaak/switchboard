/**
 * Patch's answer, read into what `AskField` draws: paragraphs of text with
 * `code` in them, and commands on their own as code blocks.
 *
 * Haiku is asked for plain text with every command and piece of code in
 * backticks, a command to run on a line of its own. A paragraph whose every
 * line is one backticked span, or a ``` fence, is a code block; anything else
 * is text, its backticked spans drawn as inline code. Text it wrote without
 * backticks still reads, only without the code font.
 */

export interface AnswerSpan {
    readonly code: boolean;
    readonly text: string;
}

export type AnswerBlock =
    /** Lines to run or read as code, without their backticks. */
    | {readonly kind: 'code'; readonly text: string}
    /** A paragraph: its lines, each in spans of text and inline code. */
    | {readonly kind: 'text'; readonly lines: readonly (readonly AnswerSpan[])[]};

const FENCE = /^```[\w-]*\n([\s\S]*?)\n?```$/;
const WHOLE_CODE_LINE = /^`([^`]+)`$/;
const INLINE_CODE = /`([^`\n]+)`/g;

export function answerBlocks(answer: string): AnswerBlock[] {
    return answer
        .replace(/\r\n?/g, '\n')
        .split(/\n[ \t]*\n/)
        .map((paragraph) => paragraph.trim())
        .filter((paragraph) => paragraph !== '')
        .map(block);
}

function block(paragraph: string): AnswerBlock {
    const fenced = paragraph.match(FENCE);
    if (fenced) return {kind: 'code', text: fenced[1]};
    const lines = paragraph.split('\n').map((line) => line.trim());
    const whole = lines.map((line) => line.match(WHOLE_CODE_LINE)?.[1]);
    if (whole.every((code) => code !== undefined)) return {kind: 'code', text: whole.join('\n')};
    return {kind: 'text', lines: lines.map(spans)};
}

function spans(line: string): AnswerSpan[] {
    const out: AnswerSpan[] = [];
    let at = 0;
    for (const match of line.matchAll(INLINE_CODE)) {
        if (match.index > at) out.push({code: false, text: line.slice(at, match.index)});
        out.push({code: true, text: match[1]});
        at = match.index + match[0].length;
    }
    if (at < line.length) out.push({code: false, text: line.slice(at)});
    return out;
}
