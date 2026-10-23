/**
 * What the question panel does beyond drawing itself: answering, choosing the
 * terminal instead, sending, and the feeds that keep it supplied.
 *
 * The components call these; these call `window.api` and dispatch. Nothing
 * here holds state of its own except the sky, which is only dressing for
 * Patch and is read at the moment Patch appears.
 */
import { draftAnswers } from '../../../domain/questions/answer-draft';
import { relayoutSessionList } from '../session-list/relayout';
import { fetchWeather } from '../../app/weather';
import { dozeMinute } from '../../features/questions/question-copy';
import { dispatch, getState, onEvent } from '../../state/app-store';
import { addPendingQuestions, settleQuestions } from '../../state/question-store';
import { sessionAsking } from '../../state/questions-slice';
import { openSessions } from '../../state/session-store';
import { highlightedSession } from '../../state/main-area-slice';
import type { DraftAction } from '../../../domain/questions/answer-draft';
import type { PatchSky } from '@jblaak/patch';
import type { QuestionView } from '../../state/answers-slice';

/** How often the doze check runs; it acts at most once per minute-left. */
const DOZE_TICK_MS = 5000;

let sky: PatchSky | null = null;

/** The weather to dress Patch for beside the questions; null until known. */
export function questionSky(): PatchSky | null {
  return sky;
}

/**
 * Start the feeds: the sets asked before this window loaded, the sidebar
 * redraw when a set starts or ends, the doze timer, and the weather.
 */
export function installQuestions(): void {
  // Asking moves a row into the needs-input section and writes its label;
  // settling moves it back. Both are a render, not a class toggle.
  onEvent('questionsAsked', (_event, state, previous) => {
    if (state.questions.bySession !== previous.questions.bySession) relayoutSessionList();
  });
  onEvent('questionsSettled', (_event, state, previous) => {
    if (state.questions.bySession !== previous.questions.bySession) relayoutSessionList();
  });

  setInterval(tickDoze, DOZE_TICK_MS);

  void fetchWeather()
    .then(weather => { sky = weather?.sky ?? null; })
    .catch(() => {});
  // Sets asked before this window loaded (or before a reload).
  void window.api.getPendingQuestions()
    .then(list => list.forEach(addPendingQuestions))
    .catch(() => {});
}

/**
 * One key, click or keystroke on the panel. When it was the one that asked to
 * send (the reducer marks the set as sending), the answers go.
 */
export function answer(toolUseId: string, action: DraftAction): void {
  const before = getState().answers.byToolUse[toolUseId];
  dispatch({ type: 'answerAction', toolUseId, action });
  const after = getState().answers.byToolUse[toolUseId];
  if (before && after && !before.sending && after.sending) void send(toolUseId);
}

/** T, the peek button or the pill over the terminal: look at the terminal under the set, or come back. */
export function peek(toolUseId: string, peeking: boolean): void {
  dispatch({ type: 'answersPeeked', toolUseId, peeking });
}

/** Esc, the header button, or the pill: which of the two the set shows. */
export function chooseView(toolUseId: string, view: QuestionView): void {
  dispatch({ type: 'answerViewChosen', toolUseId, view });
  if (view === 'terminal') focusTerminal();
}

export function greet(toolUseId: string): void {
  dispatch({ type: 'answersGreeted', toolUseId });
}

export function pokePatch(toolUseId: string): void {
  dispatch({ type: 'answersPatchPoked', toolUseId });
}

/** Put the keyboard in the terminal of the session on screen. */
export function focusTerminal(): void {
  const id = highlightedSession(getState().mainArea);
  if (id) openSessions.get(id)?.terminal.focus();
}

/**
 * Send the answers.
 *
 * Whatever comes back, the set is over here: answered, or already withdrawn
 * (main answers `ok: false` when the hook request went away first). Settling
 * locally makes main's own settle event, whichever arrives first, a no-op.
 * Only a real answer gets Patch's send-off.
 */
async function send(toolUseId: string): Promise<void> {
  const state = getState();
  const sessionId = sessionAsking(state.questions, toolUseId);
  const pending = sessionId ? state.questions.bySession[sessionId] : undefined;
  const entry = state.answers.byToolUse[toolUseId];
  if (!pending || !entry) return;

  let ok = false;
  try {
    const result = await window.api.answerQuestions(pending.sessionId, toolUseId, draftAnswers(pending.questions, entry.draft));
    ok = result.ok === true;
    if (!ok) console.warn('[questions] answer not delivered:', result.error);
  } catch (err) {
    console.warn('[questions] answer failed:', err);
  }
  // The session may have been re-keyed while main answered.
  const now = sessionAsking(getState().questions, toolUseId) ?? pending.sessionId;
  settleQuestions({ sessionId: now, toolUseId, outcome: ok ? 'answered' : 'withdrawn' });
  if (ok) dispatch({ type: 'answersDelivered', toolUseId });
}

/**
 * When the questions on screen have waited long, Patch dozes and says when the
 * terminal takes over. Only the set on screen, and only while it is up.
 */
function tickDoze(): void {
  const state = getState();
  const id = highlightedSession(state.mainArea);
  const pending = id ? state.questions.bySession[id] : undefined;
  const entry = pending ? state.answers.byToolUse[pending.toolUseId] : undefined;
  if (!pending || !entry || entry.view !== 'questions' || entry.peeking || entry.sending) return;
  // A grilling round has no deadline: it waits at the prompt.
  if (pending.deadline === null) return;
  if (!id || !openSessions.has(id)) return;
  const minutesLeft = dozeMinute(pending.deadline, Date.now(), entry.dozedAt);
  if (minutesLeft === null) return;
  dispatch({ type: 'answersDozed', toolUseId: pending.toolUseId, minutesLeft });
}
