/**
 * Which set of questions, if any, belongs on screen right now.
 *
 * The session on screen is the store's active session, provided its terminal
 * is open: the panel covers a terminal, and the open terminals are a registry
 * outside the store (`openSessions`). Opening a session's terminal happens just
 * before it is made active, so the store's `activeSessionChanged` is the moment
 * to look again — including when it names the session already active, which
 * is how a restore or a second click on the row shows the same session anew.
 * `shown` counts those events, so a re-show is a change the panel can act on
 * (taking the keyboard back from the terminal it just focused).
 */
import { useEffect, useState } from 'react';
import { onEvent } from '../../state/app-store';
import { openSessions } from '../../state/session-store';
import { useStore } from '../use-store';
import type { Answering } from '../../state/answers-slice';
import type { OpenSession } from '../../state/session-store';
import type { PendingQuestions } from '../../../domain/questions/question';

export interface OnScreen {
  /** The active session, whether or not its terminal is open. */
  sessionId: string | null;
  /** Its open terminal, if it has one. */
  open: OpenSession | undefined;
  /** The set it is asking, when its terminal is on screen. */
  pending: PendingQuestions | undefined;
  answering: Answering | undefined;
  /** The panel is up: a set is on screen and the user has not chosen the terminal. */
  up: boolean;
  /** The panel is up but stepped aside, showing the terminal under it. */
  peeking: boolean;
  /** Bumped each time a session is shown, even the one already active. */
  shown: number;
}

export function useOnScreen(): OnScreen {
  const [shown, setShown] = useState(0);
  useEffect(() => onEvent('activeSessionChanged', () => setShown(n => n + 1)), []);

  const sessionId = useStore(s => s.view.activeSessionId);
  const open = sessionId ? openSessions.get(sessionId) : undefined;
  const pending = useStore(s => (open && sessionId ? s.questions.bySession[sessionId] : undefined));
  const answering = useStore(s => (pending ? s.answers.byToolUse[pending.toolUseId] : undefined));
  const up = !!pending && !!answering && answering.view === 'questions';
  const peeking = up && answering.peeking;
  return { sessionId, open, pending, answering, up, peeking, shown };
}
