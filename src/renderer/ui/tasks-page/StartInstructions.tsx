/**
 * What Start session (S) asks first: any extra instructions for the new
 * session, added to its first prompt. Enter starts (with none, as before),
 * Shift+Enter is a new line, Esc puts it away.
 *
 * Under the task's row, or in its detail while that is open.
 */
import { useState, type JSX, type KeyboardEvent } from 'react';
import type { TaskRow } from '../../../domain/tasks/model';
import { dismissStart, startFromTask } from './actions';

export function StartInstructions({ task }: { task: TaskRow }): JSX.Element {
  const [instructions, setInstructions] = useState('');
  const start = (): void => void startFromTask(task, { instructions });

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      start();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      dismissStart();
    }
  };

  return (
    // A click in here is the box's, not the row's: the row would take the keyboard back.
    <div className="tk-start tk-instructions" role="group" aria-label="Start session" onClick={e => e.stopPropagation()}>
      <textarea
        className="tk-instructions-input"
        rows={3}
        autoFocus
        placeholder="Any extra instructions? (optional)"
        aria-label="Extra instructions"
        value={instructions}
        spellCheck={false}
        onChange={e => setInstructions(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="tk-choices">
        <button type="button" className="sw-btn is-primary" onClick={start}>
          Start session <kbd className="sw-kbd">↵</kbd>
        </button>
        <button type="button" className="sw-btn" onClick={dismissStart}>
          Cancel <kbd className="sw-kbd">esc</kbd>
        </button>
      </div>
    </div>
  );
}
