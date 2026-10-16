/**
 * How far the user got answering each pending set of questions, and what
 * Patch last said beside it.
 *
 * The other half of `questions-slice`: that one holds what main said is
 * pending, this one what the user has done about it. One entry per set, keyed
 * by tool-use id rather than session id, so a draft survives its session being
 * re-keyed, and an entry lives exactly as long as its set does — it is made
 * when the set arrives and dropped when the set settles or is replaced.
 *
 * Every way of answering (keys, clicks, typing) arrives as one `answerAction`
 * and goes through `reduceDraft`, the domain's rules for a draft. What an
 * action meant for Patch is kept as `said`, with a count that moves each time
 * Patch has something new to say, so the panel can tell a new line from the
 * last one being shown again after a session switch.
 */
import { createDraft, reduceDraft } from '../../domain/questions/answer-draft';
import { sessionAsking } from './questions-slice';
import { withEntry, withoutEntry } from './records';
import type { AnswerDraft } from '../../domain/questions/answer-draft';
import type { QuestionMoment } from '../../domain/companion/question-beats';
import type { IdRecord } from './records';
import type { QuestionsState } from './questions-slice';
import type { RendererEvent } from './events';

/** Which of the two things a session with questions shows over its terminal area. */
export type QuestionView = 'questions' | 'terminal';

export interface Said {
  /** Moves each time Patch says something new beside this set. */
  readonly seq: number;
  readonly moment: QuestionMoment;
}

export interface Answering {
  readonly draft: AnswerDraft;
  readonly view: QuestionView;
  /** Patch has said hello to this set; a later showing is a return, not an arrival. */
  readonly greeted: boolean;
  /** How many times Patch has been poked beside this set, for its cycle of lines. */
  readonly pokes: number;
  /** The minutes-left Patch last dozed on, so the reminder plays once per minute. */
  readonly dozedAt: number | null;
  /** The answers are on their way to main; the set takes no more input. */
  readonly sending: boolean;
  /** What Patch last said beside this set; null until it has greeted it. */
  readonly said: Said | null;
}

export interface AnswersState {
  /** toolUseId → how far the user got with that set. */
  readonly byToolUse: IdRecord<Answering>;
}

export const initialAnswersState: AnswersState = { byToolUse: {} };

/** A fresh entry for a set that just arrived. */
export function startAnswering(questions: Parameters<typeof createDraft>[0]): Answering {
  return {
    draft: createDraft(questions),
    view: 'questions',
    greeted: false,
    pokes: 0,
    dozedAt: null,
    sending: false,
    said: null,
  };
}

/**
 * `questions` is the questions slice as this same event left it, so a set and
 * its entry come and go together.
 */
export function answersReducer(state: AnswersState, event: RendererEvent, questions: QuestionsState): AnswersState {
  const synced = followPending(state, questions);
  switch (event.type) {
    case 'answerAction': {
      const entry = synced.byToolUse[event.toolUseId];
      const pending = pendingFor(questions, event.toolUseId);
      if (!entry || !pending || entry.sending) return synced;
      const { draft, event: meant } = reduceDraft(pending.questions, entry.draft, event.action);
      if (draft === entry.draft && !meant) return synced;
      // Asking to send is not something Patch remarks on; the send-off is.
      if (meant?.kind === 'submit') return put(synced, event.toolUseId, { ...entry, draft, sending: true });
      return put(synced, event.toolUseId, meant ? say({ ...entry, draft }, meant) : { ...entry, draft });
    }

    // The panel showed a set for the first time.
    case 'answersGreeted': {
      const entry = synced.byToolUse[event.toolUseId];
      const pending = pendingFor(questions, event.toolUseId);
      if (!entry || !pending || entry.greeted) return synced;
      return put(synced, event.toolUseId, greet(entry, pending.questions.length));
    }

    // The user went to the terminal (Esc, the header button) or came back (the pill).
    case 'answerViewChosen': {
      const entry = synced.byToolUse[event.toolUseId];
      const pending = pendingFor(questions, event.toolUseId);
      if (!entry || !pending || entry.view === event.view) return synced;
      const moved = { ...entry, view: event.view };
      if (event.view === 'terminal') return put(synced, event.toolUseId, moved);
      return put(synced, event.toolUseId,
        moved.greeted ? say(moved, { kind: 'returned' }) : greet(moved, pending.questions.length));
    }

    case 'answersPatchPoked': {
      const entry = synced.byToolUse[event.toolUseId];
      if (!entry) return synced;
      const pokes = entry.pokes + 1;
      return put(synced, event.toolUseId, say({ ...entry, pokes }, { kind: 'poked', count: pokes }));
    }

    case 'answersDozed': {
      const entry = synced.byToolUse[event.toolUseId];
      if (!entry || entry.sending || entry.dozedAt === event.minutesLeft) return synced;
      return put(synced, event.toolUseId,
        say({ ...entry, dozedAt: event.minutesLeft }, { kind: 'waiting', minutesLeft: event.minutesLeft }));
    }

    default:
      return synced;
  }
}

function greet(entry: Answering, count: number): Answering {
  return say({ ...entry, greeted: true }, { kind: 'arrived', count });
}

function say(entry: Answering, moment: QuestionMoment): Answering {
  return { ...entry, said: { seq: (entry.said?.seq ?? 0) + 1, moment } };
}

function put(state: AnswersState, toolUseId: string, entry: Answering): AnswersState {
  return { byToolUse: withEntry(state.byToolUse, toolUseId, entry) };
}

function pendingFor(questions: QuestionsState, toolUseId: string) {
  const sessionId = sessionAsking(questions, toolUseId);
  return sessionId ? questions.bySession[sessionId] : undefined;
}

/** One entry per pending set: new sets get a fresh one, settled or replaced sets lose theirs. */
export function followPending(state: AnswersState, questions: QuestionsState): AnswersState {
  let byToolUse = state.byToolUse;
  const live = new Set<string>();
  for (const pending of Object.values(questions.bySession)) {
    live.add(pending.toolUseId);
    if (!byToolUse[pending.toolUseId]) byToolUse = withEntry(byToolUse, pending.toolUseId, startAnswering(pending.questions));
  }
  for (const toolUseId of Object.keys(byToolUse)) {
    if (!live.has(toolUseId)) byToolUse = withoutEntry(byToolUse, toolUseId);
  }
  return byToolUse === state.byToolUse ? state : { byToolUse };
}

/** The entry for the set a session is asking, if it is asking one. */
export function answeringFor(
  answers: AnswersState, questions: QuestionsState, sessionId: string | null | undefined,
): Answering | undefined {
  const pending = sessionId ? questions.bySession[sessionId] : undefined;
  return pending ? answers.byToolUse[pending.toolUseId] : undefined;
}
