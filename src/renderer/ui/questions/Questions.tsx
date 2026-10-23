/**
 * Answering Claude's questions in Switchboard rather than in the terminal:
 * the panel and its send-offs, rendered into #terminals.
 *
 * The panel covers the terminal area of the session on screen while that
 * session has questions and the user has not chosen the terminal instead. It
 * is a sibling of the terminal containers inside #terminals, never a child of
 * one: the xterm stays mounted and sized underneath (only its container is
 * scaled back, which does not touch layout), and a drop or a key on the panel
 * cannot reach the terminal's own handlers.
 *
 * The terminal containers are the terminal manager's, so sinking the one
 * under the panel (`qp-under`) and letting a session switch land without
 * transitions (`qp-instant` on #terminals) are class changes made here, from
 * the same state the panel renders from.
 *
 * While the user peeks, the terminal comes back up from under the sheet and a
 * pill over it offers the way back to the questions.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { onEvent } from '../../state/app-store';
import { openSessions } from '../../state/session-store';
import { peek } from './actions';
import { Farewell } from './Farewell';
import { AnsweredOnPhone } from './AnsweredOnPhone';
import { QuestionPanel } from './QuestionPanel';
import { useOnScreen } from './use-on-screen';
import type { JSX } from 'react';

interface FarewellItem {
  id: number;
  leaving: boolean;
}

export function Questions(): JSX.Element {
  const screen = useOnScreen();

  // A switch should land, not animate: the new session's terminal is not
  // sinking, it is already behind its questions.
  const lastActive = useRef<string | null | undefined>(undefined);
  useLayoutEffect(() => {
    if (lastActive.current === screen.sessionId) return;
    lastActive.current = screen.sessionId;
    skipTransitions();
  }, [screen.sessionId]);

  useLayoutEffect(() => {
    for (const [, other] of openSessions) {
      const under = screen.up && !screen.peeking && other === screen.open;
      if (other.element.classList.contains('qp-under') !== under) other.element.classList.toggle('qp-under', under);
    }
  });

  const [farewells, setFarewells] = useState<FarewellItem[]>([]);
  const nextId = useRef(0);
  useEffect(() => onEvent('answersDelivered', () => {
    const id = ++nextId.current;
    setFarewells(list => [...list, { id, leaving: false }]);
  }), []);
  const leave = useCallback((id?: number) => {
    setFarewells(list => list.map(f => (id === undefined || f.id === id ? { ...f, leaving: true } : f)));
  }, []);
  // Claude can ask again within a second of an answer, and the farewell sits
  // above the sheet, so a new set must not come up underneath it.
  const dismissAll = useCallback(() => leave(), [leave]);

  return (
    <>
      <QuestionPanel screen={screen} onShow={dismissAll} />
      {screen.peeking && screen.pending && (
        <button
          type="button"
          className="qp-peek-back"
          tabIndex={-1}
          onClick={() => { if (screen.pending) peek(screen.pending.toolUseId, false); }}
        >
          Back to questions<kbd className="qp-peek-key">T</kbd>
        </button>
      )}
      <AnsweredOnPhone />
      {farewells.map(f => (
        <Farewell
          key={f.id}
          leaving={f.leaving}
          onStayed={() => leave(f.id)}
          onGone={() => setFarewells(list => list.filter(other => other.id !== f.id))}
        />
      ))}
    </>
  );
}

/** Let the next state apply without its transitions, for one frame. */
function skipTransitions(): void {
  const terminals = document.getElementById('terminals');
  if (!terminals) return;
  terminals.classList.add('qp-instant');
  requestAnimationFrame(() => requestAnimationFrame(() => terminals.classList.remove('qp-instant')));
}
