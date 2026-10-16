/**
 * The terminal header's part in the questions: a way out to the terminal
 * while the panel is up, a way back while it is not, nothing once the set is
 * settled.
 *
 * Rendered into `#terminal-header-questions`, which the header owns; this
 * only fills it and says whether it is hidden. The button is keyed by what it
 * says, so it is built afresh (and its pop plays) only when that changes.
 */
import { useLayoutEffect } from 'react';
import { answeredCount } from '../../../domain/questions/answer-draft';
import { waitingLabel } from '../../features/questions/question-copy';
import { chooseView } from './actions';
import { useOnScreen } from './use-on-screen';
import type { JSX } from 'react';

const SLOT_ID = 'terminal-header-questions';

export function QuestionsHeaderButton(): JSX.Element | null {
  const { pending, answering, up } = useOnScreen();
  const entry = pending && answering ? { pending, answering } : null;

  useLayoutEffect(() => {
    const slot = document.getElementById(SLOT_ID);
    if (slot) slot.hidden = !entry;
  }, [!entry]);

  if (!entry) return null;
  const { toolUseId, questions } = entry.pending;

  if (up) {
    return (
      <button key={`${toolUseId}:up`} type="button" className="qh-terminal" onClick={() => chooseView(toolUseId, 'terminal')}>
        <TerminalIcon />Answer in terminal<kbd className="qh-kbd">esc</kbd>
      </button>
    );
  }
  const label = waitingLabel(questions.length - answeredCount(questions, entry.answering.draft));
  return (
    <button key={`${toolUseId}:down:${label}`} type="button" className="qh-waiting" onClick={() => chooseView(toolUseId, 'questions')}>
      <PatchFace />{label}
    </button>
  );
}

function TerminalIcon(): JSX.Element {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 7l5 5-5 5" /><path d="M12 19h7" />
    </svg>
  );
}

function PatchFace(): JSX.Element {
  return (
    <svg className="qh-face" aria-hidden="true" width="22" height="20" viewBox="46 64 106 106" fill="none">
      <path className="qh-face-body" d="M50 138 C 46 96, 72 68, 100 68 C 132 68, 152 96, 148 138 C 146 158, 128 166, 100 166 C 70 166, 52 158, 50 138 Z" />
      <ellipse className="qh-face-eye" cx="86" cy="118" rx="6" ry="8" />
      <ellipse className="qh-face-eye" cx="114" cy="118" rx="6" ry="8" />
    </svg>
  );
}
