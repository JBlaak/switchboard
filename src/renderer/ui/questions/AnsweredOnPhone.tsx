/**
 * "Answered on phone" (#194): when the set on screen is answered from a
 * paired phone, the panel goes and this says why, for a few seconds.
 *
 * A short-lived pill of its own, like the farewell beside it; decoration
 * only, so it cannot take a click or a key meant for the terminal under it.
 */
import { useEffect, useState } from 'react';
import { onEvent } from '../../state/app-store';
import { answeredOnPhone } from '../../state/phone-access-slice';
import { PhoneIcon } from '../phone-access/icons';
import type { JSX } from 'react';

/** How long the note stays. */
const NOTE_MS = 3200;

export function AnsweredOnPhone(): JSX.Element | null {
  const [shown, setShown] = useState(0);
  useEffect(() => onEvent('questionsSettled', ({ settled }, _state, previous) => {
    if (answeredOnPhone(settled, previous.questions, previous.view.activeSessionId)) setShown(n => n + 1);
  }), []);
  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => setShown(0), NOTE_MS);
    return () => clearTimeout(timer);
  }, [shown]);

  if (!shown) return null;
  return (
    <div key={shown} className="qp-answered-on-phone" role="status">
      <PhoneIcon />Answered on phone
    </div>
  );
}
