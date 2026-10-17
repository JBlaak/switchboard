/**
 * The answers someone is putting together, before they are sent.
 *
 * Kept as a reducer so every way of answering — arrows, number keys, space,
 * clicks, typing an answer of one's own — goes through one set of rules that
 * can be tested without a DOM. The renderer owns the draft, feeds it actions,
 * and plays whatever event comes back (Patch's reaction, a submit).
 *
 * Rows: a question with n options has n + 1 rows; row n is "Other", a free-text
 * answer. On a single-choice question picking one thing lets go of the other —
 * choosing Other clears the picked option and picking an option clears Other.
 * On a multiple-choice question Other is one more thing to include.
 */
import type { Answers, Question } from './question';

export interface AnswerDraft {
  /** The question on screen. */
  step: number;
  /** The keyboard cursor's row on that question: 0..options.length (the last is Other). */
  cursor: number;
  /** Per question, the picked option labels (at most one on a single-choice question). */
  picks: string[][];
  /** Per question, the free-text answer; '' when there is none. */
  other: string[];
}

export type DraftAction =
  /** ↑/↓. Wraps across all rows. On a single-choice question, landing on an option picks it. */
  | { kind: 'move'; by: 1 | -1 }
  /** A number key, 0-based. Picks (single) or toggles (multiple); the Other row just moves the cursor there. */
  | { kind: 'press'; row: number }
  /** A click. Like press, except clicking the picked option of a single-choice question unpicks it. */
  | { kind: 'click'; row: number }
  /** Space: press the row under the cursor. */
  | { kind: 'space' }
  /** The Other field took focus. Same as pressing its row. */
  | { kind: 'focus-other' }
  /** The Other field's text changed. */
  | { kind: 'type'; text: string }
  /**
   * Enter / →. Advances when the question is answered, or asks to submit on the last one.
   * On an unanswered single-choice question it first picks the option under the cursor.
   */
  | { kind: 'next' }
  /** ←. */
  | { kind: 'back' }
  /** A click on a question's tab. */
  | { kind: 'goto'; step: number };

/** What an action meant, for Patch to react to and the renderer to act on. Arrow moves are quiet. */
export type DraftEvent =
  | { kind: 'picked'; recommended: boolean }
  | { kind: 'unpicked' }
  /** A toggle on a multiple-choice question; `total` is its option count. */
  | { kind: 'multi-count'; count: number; total: number }
  /** The Other text went from empty to not. */
  | { kind: 'started-other' }
  /** This action answered the last unanswered question. Wins over the event it would otherwise be. */
  | { kind: 'all-answered' }
  /** Moved forward; `done` is how many questions are answered, `isLast` whether we landed on the last. */
  | { kind: 'advanced'; done: number; total: number; isLast: boolean }
  /** Moved back, or jumped to another tab; `header` is where we landed. */
  | { kind: 'moved-to'; header: string }
  /** Next with the current question unanswered, or submit with any unanswered. */
  | { kind: 'blocked'; isLast: boolean }
  /** Next on the last question with everything answered: send it. */
  | { kind: 'submit' };

export interface DraftResult {
  draft: AnswerDraft;
  event: DraftEvent | null;
}

/** A fresh draft: first question, cursor on the first row, nothing picked. */
export function createDraft(questions: Question[]): AnswerDraft {
  return {
    step: 0,
    cursor: 0,
    picks: questions.map(() => []),
    other: questions.map(() => ''),
  };
}

export function reduceDraft(questions: Question[], draft: AnswerDraft, action: DraftAction): DraftResult {
  const result = applyAction(questions, draft, action);
  // Arrow moves stay quiet even when they happen to complete the set: a move
  // is browsing, and cheering on every pass over an option would be noise.
  if (action.kind === 'move' || result.draft === draft || result.event?.kind === 'submit') return result;
  const total = questions.length;
  const before = answeredCount(questions, draft);
  const after = answeredCount(questions, result.draft);
  if (before < total && after === total) return { draft: result.draft, event: { kind: 'all-answered' } };
  return result;
}

function applyAction(questions: Question[], draft: AnswerDraft, action: DraftAction): DraftResult {
  const question = questions[draft.step];
  if (!question) return quiet(draft);
  const otherRow = question.options.length;

  switch (action.kind) {
    case 'move': {
      const rows = otherRow + 1;
      const cursor = (((draft.cursor + action.by) % rows) + rows) % rows;
      if (question.multiSelect) return quiet({ ...draft, cursor });
      if (cursor === otherRow) return quiet(withAnswer(draft, { cursor, picks: [] }));
      return quiet(withAnswer(draft, { cursor, picks: [question.options[cursor].label], other: '' }));
    }
    case 'press':
      return choose(question, draft, action.row, false);
    case 'click':
      return choose(question, draft, action.row, true);
    case 'space':
      if (draft.cursor === otherRow) return quiet(draft);
      return choose(question, draft, draft.cursor, false);
    case 'focus-other':
      return choose(question, draft, otherRow, false);
    case 'type': {
      const wasBlank = isBlank(draft.other[draft.step]);
      const next = withAnswer(draft, {
        cursor: otherRow,
        other: action.text,
        ...(question.multiSelect ? {} : { picks: [] }),
      });
      const started = wasBlank && !isBlank(action.text);
      return { draft: next, event: started ? { kind: 'started-other' } : null };
    }
    case 'next': {
      const last = questions.length - 1;
      // The cursor sits on an option from the start, so Enter takes it — as in Claude Code's own picker.
      if (!question.multiSelect && draft.cursor < otherRow && !isAnswered(questions, draft, draft.step)) {
        draft = withAnswer(draft, { cursor: draft.cursor, picks: [question.options[draft.cursor].label], other: '' });
      }
      if (!isAnswered(questions, draft, draft.step)) {
        return { draft, event: { kind: 'blocked', isLast: draft.step === last } };
      }
      if (draft.step === last) {
        const everything = answeredCount(questions, draft) === questions.length;
        return { draft, event: everything ? { kind: 'submit' } : { kind: 'blocked', isLast: true } };
      }
      const landed = land(questions, draft, draft.step + 1);
      return {
        draft: landed,
        event: {
          kind: 'advanced',
          done: answeredCount(questions, landed),
          total: questions.length,
          isLast: landed.step === last,
        },
      };
    }
    case 'back':
      if (draft.step === 0) return quiet(draft);
      return movedTo(questions, draft, draft.step - 1);
    case 'goto':
      if (action.step === draft.step || action.step < 0 || action.step >= questions.length) return quiet(draft);
      return movedTo(questions, draft, action.step);
  }
}

/**
 * A number key, a click, space or the Other field taking focus: the cursor
 * follows, and the row is picked or toggled. Only a click lets go of a
 * single-choice pick — pressing its key again reads as a confirmation, not a
 * change of mind.
 */
function choose(question: Question, draft: AnswerDraft, row: number, isClick: boolean): DraftResult {
  const otherRow = question.options.length;
  if (!Number.isInteger(row) || row < 0 || row > otherRow) return quiet(draft);
  const picks = draft.picks[draft.step] ?? [];

  if (row === otherRow) {
    return quiet(withAnswer(draft, { cursor: row, ...(question.multiSelect ? {} : { picks: [] }) }));
  }

  const label = question.options[row].label;
  if (question.multiSelect) {
    const toggled = picks.includes(label) ? picks.filter(p => p !== label) : [...picks, label];
    const ordered = question.options.map(o => o.label).filter(l => toggled.includes(l));
    return {
      draft: withAnswer(draft, { cursor: row, picks: ordered }),
      event: { kind: 'multi-count', count: ordered.length, total: question.options.length },
    };
  }

  if (picks.includes(label)) {
    if (isClick) return { draft: withAnswer(draft, { cursor: row, picks: [] }), event: { kind: 'unpicked' } };
    return quiet(withAnswer(draft, { cursor: row }));
  }
  return {
    draft: withAnswer(draft, { cursor: row, picks: [label], other: '' }),
    event: { kind: 'picked', recommended: isRecommended(label) },
  };
}

function movedTo(questions: Question[], draft: AnswerDraft, step: number): DraftResult {
  const landed = land(questions, draft, step);
  const header = questions[step].header.trim() || `Question ${step + 1}`;
  return { draft: landed, event: { kind: 'moved-to', header } };
}

/** Arriving at a question puts the cursor back on the answer it already has. */
function land(questions: Question[], draft: AnswerDraft, step: number): AnswerDraft {
  const question = questions[step];
  const picks = draft.picks[step] ?? [];
  let cursor = 0;
  if (!question.multiSelect && picks.length > 0) {
    cursor = Math.max(0, question.options.findIndex(o => o.label === picks[0]));
  } else if (picks.length === 0 && !isBlank(draft.other[step])) {
    cursor = question.options.length;
  }
  return { ...draft, step, cursor };
}

/** A copy of the draft with the current question's cursor, picks or Other text replaced. */
function withAnswer(draft: AnswerDraft, change: { cursor: number; picks?: string[]; other?: string }): AnswerDraft {
  const picks = change.picks === undefined ? draft.picks : replaceAt(draft.picks, draft.step, change.picks);
  const other = change.other === undefined ? draft.other : replaceAt(draft.other, draft.step, change.other);
  return { ...draft, cursor: change.cursor, picks, other };
}

function replaceAt<T>(items: T[], index: number, value: T): T[] {
  const copy = items.slice();
  copy[index] = value;
  return copy;
}

function quiet(draft: AnswerDraft): DraftResult {
  return { draft, event: null };
}

function isBlank(text: string | undefined): boolean {
  return !text || !text.trim();
}

/** Whether question `index` has an answer: a pick, or non-blank Other text. */
export function isAnswered(questions: Question[], draft: AnswerDraft, index: number): boolean {
  if (!questions[index]) return false;
  return (draft.picks[index]?.length ?? 0) > 0 || !isBlank(draft.other[index]);
}

export function answeredCount(questions: Question[], draft: AnswerDraft): number {
  return questions.filter((_, index) => isAnswered(questions, draft, index)).length;
}

/**
 * The answers to send: question text → picked labels in option order (with
 * their "(Recommended)" suffix intact) and trimmed Other text last, joined
 * with ", ". Only meaningful once every question is answered.
 */
export function draftAnswers(questions: Question[], draft: AnswerDraft): Answers {
  const answers: Answers = {};
  questions.forEach((question, index) => {
    const picks = draft.picks[index] ?? [];
    const parts = question.options.map(o => o.label).filter(label => picks.includes(label));
    const other = (draft.other[index] ?? '').trim();
    if (other) parts.push(other);
    answers[question.question] = parts.join(', ');
  });
  return answers;
}

const RECOMMENDED_SUFFIX = /\s*\(recommended\)\s*$/i;

/** Claude's own convention for the option it would pick. */
export function isRecommended(label: string): boolean {
  return RECOMMENDED_SUFFIX.test(label);
}

/** The label without the "(Recommended)" suffix, for display. */
export function displayLabel(label: string): string {
  return label.replace(RECOMMENDED_SUFFIX, '').trim();
}
