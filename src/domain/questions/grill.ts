/**
 * The rounds of questions a grilling session asks in its reply, and the prompt
 * that answers one.
 *
 * The `grilling` skill does not use AskUserQuestion: it ends its turn with a
 * round written out as text, one block per question —
 *
 *     ❓ **Q1** - **<title>**: <body, maybe several paragraphs and choices>
 *
 *     ➡️ <the recommended answer>
 *
 *     ---
 *
 * — and waits for a reply typed at its prompt. Each question is worded so
 * "yes" accepts the recommendation. So a round reaches us as the text of the
 * turn's last message (the Stop hook carries it), becomes the same Questions
 * the panel already draws, and the answers go back as one typed prompt.
 *
 * Every question gets the same rows: "Yes" (the recommendation, so it is
 * recommended), the choices its body lists, if it lists any, and "Wait,
 * what?", which asks for a re-pitch through the `/wait-what` skill. The
 * panel's Other row is the open answer.
 */
import type { Answers, Question, QuestionOption } from './question';

/** The row that accepts the recommendation; sent back as "yes". */
export const GRILL_YES_LABEL = 'Yes (Recommended)';

/** The row that asks for a re-pitch instead of answering. */
export const WAIT_WHAT_LABEL = 'Wait, what?';

const WAIT_WHAT_DESCRIPTION = 'Have Claude re-pitch this one in plain words (/wait-what)';

/**
 * At most this many choices are lifted out of a body: with Yes, Wait-what and
 * Other around them, that keeps every row on a number key. A longer list is
 * more likely notes than choices, and stays in the body.
 */
const MAX_CHOICES = 6;

/** A choice longer than this before its separator is all label. */
const MAX_LABEL_CHARS = 60;

/** Where a question block starts: a line opening with ❓. */
const BLOCK_START = /^(?=[ \t]*❓)/m;
const QUESTION_MARK = /^[ \t]*❓️?[ \t]*/;
/** The line the recommendation starts on: ➡️, with or without its variation selector. */
const RECOMMENDATION = /^[ \t]*➡️?[ \t]*/m;
/** A horizontal rule, as the rounds put between questions. */
const RULE = /^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/;

/**
 * The opening of a block, most to least literal: `**Q1** - **Title**:`, then
 * `**Q1 - Title**:`, then `Q1 - Title:`. Each captures the number and title.
 */
const OPENINGS = [
  /^\*\*Q(\d+)\*\*[ \t]*[-–—:.]?[ \t]*\*\*([^\n]+?)\*\*[ \t]*:?[ \t]*/,
  /^\*\*Q(\d+)[ \t]*[-–—:.][ \t]*([^\n]+?)\*\*[ \t]*:?[ \t]*/,
  /^Q(\d+)[ \t]*[-–—.][ \t]*([^\n:]+):[ \t]*/,
];

/** A list item: a bullet, `1.`/`1)`, `a.`/`A)`, `(a)` or a bold `**A**`, then its text. */
const LIST_ITEM = /^[ \t]*(?:[-*•][ \t]+|(?=\d{1,2}[.)][ \t])|(?=[A-Za-z][.)][ \t])|(?=\([A-Za-z0-9]{1,2}\)[ \t])|(?=\*\*[A-Za-z0-9][.):]?\*\*[.):]?[ \t]))(.+)$/;
/** Between a choice's label and its explanation. */
const CHOICE_SEPARATOR = /[ \t]+[—–-][ \t]+|:[ \t]+/;

/**
 * The questions in a grilling round, or null when the text is not one.
 *
 * A round is any text with at least one block that has a ❓ opening with a
 * question number and title, and a ➡️ recommendation; blocks without both
 * are passed over. Whatever comes before the first ❓ (a recap of the last
 * round, usually) is not a question and is left to the terminal.
 */
export function parseGrillRound(text: string): Question[] | null {
  const questions: Question[] = [];
  for (const block of text.split(BLOCK_START)) {
    if (!QUESTION_MARK.test(block)) continue;
    const question = parseBlock(block.replace(QUESTION_MARK, ''));
    if (question) questions.push(question);
  }
  return questions.length > 0 ? questions : null;
}

function parseBlock(block: string): Question | null {
  let number = '';
  let title = '';
  let rest = '';
  for (const opening of OPENINGS) {
    const match = opening.exec(block);
    if (!match) continue;
    number = match[1];
    title = plain(match[2]).replace(/:$/, '').trim();
    rest = block.slice(match[0].length);
    break;
  }
  if (!number || !title) return null;

  const arrow = RECOMMENDATION.exec(rest);
  if (!arrow) return null;
  const body = withoutRules(rest.slice(0, arrow.index));
  const recommendation = plain(withoutRules(rest.slice(arrow.index + arrow[0].length)));
  if (!recommendation) return null;

  const { choices, detail } = splitChoices(body);
  const options: QuestionOption[] = [
    { label: GRILL_YES_LABEL, description: recommendation },
    ...choices,
    { label: WAIT_WHAT_LABEL, description: WAIT_WHAT_DESCRIPTION },
  ];
  return {
    question: title,
    header: `Q${number}`,
    options,
    multiSelect: false,
    ...(detail ? { detail } : {}),
  };
}

/**
 * The body's list items as choices, and the rest of it as the detail shown
 * under the title. Fewer than two items, or more than MAX_CHOICES, is not a
 * set of choices: the body stays whole.
 */
function splitChoices(body: string): { choices: QuestionOption[]; detail: string } {
  const lines = body.split('\n');
  const items = lines.flatMap((line, index) => {
    const match = LIST_ITEM.exec(line);
    return match ? [{ index, text: plain(match[1]) }] : [];
  });
  if (items.length < 2 || items.length > MAX_CHOICES) return { choices: [], detail: tidy(body) };

  const taken = new Set(items.map(item => item.index));
  const choices = items.map(({ text }) => choiceOf(text));
  // Two choices that read the same would be one row picked twice.
  if (new Set(choices.map(c => c.label)).size !== choices.length) return { choices: [], detail: tidy(body) };
  return { choices, detail: tidy(lines.filter((_, index) => !taken.has(index)).join('\n')) };
}

/** "A) SQLite — one file, no server" → label "A) SQLite", the rest its description. */
function choiceOf(text: string): QuestionOption {
  const separator = CHOICE_SEPARATOR.exec(text);
  if (!separator || separator.index === 0 || separator.index > MAX_LABEL_CHARS) return { label: text, description: '' };
  return {
    label: text.slice(0, separator.index).trim(),
    description: text.slice(separator.index + separator[0].length).trim(),
  };
}

/** Bold markers go: the panel draws plain text. Code ticks stay, they still read as code. */
function plain(text: string): string {
  return text.replace(/\*\*/g, '').trim();
}

function withoutRules(text: string): string {
  return text.split('\n').filter(line => !RULE.test(line)).join('\n').trim();
}

/** Plain text, with runs of blank lines down to one and no blank edges. */
function tidy(text: string): string {
  return plain(text.replace(/\n[ \t]*(?:\n[ \t]*)+/g, '\n\n'));
}

/**
 * The prompt that answers a round, from the panel's answers (question text →
 * the picked label or the typed answer).
 *
 * One line per question, by the number the round gave it: "Q1: yes" for the
 * recommendation, the choice (with its explanation, so Claude need not look
 * it up) or the typed answer otherwise. Questions marked "Wait, what?" turn
 * the prompt into `/wait-what Q2 Q3`, with the other answers after it, so
 * nothing already answered is lost while Claude re-pitches.
 */
export function grillReply(questions: Question[], answers: Answers): string {
  const unclear: string[] = [];
  const lines: string[] = [];
  for (const question of questions) {
    const answer = (answers[question.question] ?? '').trim();
    if (!answer) continue;
    if (answer === WAIT_WHAT_LABEL) {
      unclear.push(question.header);
    } else if (answer === GRILL_YES_LABEL) {
      lines.push(`${question.header}: yes`);
    } else {
      const choice = question.options.find(option => option.label === answer);
      lines.push(`${question.header}: ${choice?.description ? `${choice.label} — ${choice.description}` : answer}`);
    }
  }
  if (unclear.length === 0) return lines.join('\n');
  const rePitch = `/wait-what ${unclear.join(' ')}`;
  return lines.length === 0 ? rePitch : `${rePitch}\n\nMy answers to the rest:\n${lines.join('\n')}`;
}
