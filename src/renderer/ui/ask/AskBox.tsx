/**
 * The box under Patch on the empty screen (#135): type what you want to work
 * on, and Patch starts the session in the right project.
 *
 * Always there while the empty screen is (B1), and focused whenever it comes
 * into view (B2), unless a dialog or the session list has the keyboard. The
 * focus then stays in the box through the wait and the choice list, so all of
 * their keys are heard on it (`ask-keys`); the box is read-only meanwhile.
 *
 * It grows with its text, up to about five lines, in the stylesheet
 * (`field-sizing`), so nothing here measures it. What it draws is `AskField`,
 * which the Quick Ask pop-up draws too.
 */
import { useEffect, useRef } from 'react';
import { placeholder } from '../../lib/dom';
import { projectLabel } from '../../features/sessions/project-label';
import { getState, onEvent } from '../../state/app-store';
import { useStore } from '../use-store';
import { AskField } from './AskField';
import { askKey, boxTakesFocus, isCaretChord, opensPickerFromBox } from './ask-keys';
import { openDialog } from '../dialogs/actions';
import {
  cancelAsk, changeAskText, closeAskChoices, hoverAskChoice, openPickerFromChoices, sendAsk, startAskChoice,
  stepAskChoice,
} from './actions';
import type { JSX, KeyboardEvent } from 'react';

/** An event `app/shortcuts` steps aside for. */
type MarkedEvent = globalThis.KeyboardEvent & { _handled?: boolean };

export function AskBox(): JSX.Element {
  const ask = useStore(state => state.ask);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const focusBox = (): void => {
      if (placeholder.style.display === 'none') return;
      const sidebar = document.getElementById('sidebar');
      const where = {
        dialogOpen: getState().dialog.open !== null,
        focusInSidebar: !!sidebar?.contains(document.activeElement),
      };
      if (boxTakesFocus(where)) box.current?.focus({ preventScroll: true });
    };

    focusBox();
    const unsubscribers = [
      onEvent('emptyScreenShown', focusBox),
      // A dialog does not hand the focus back when it closes (see `DialogShell`);
      // on the empty screen it comes back here, where a dismissed picker left the text.
      onEvent('dialogClosed', (_event, state, previous) => {
        if (state.dialog.open === null && previous.dialog.open !== null) focusBox();
      }),
    ];
    return () => unsubscribers.forEach(unsubscribe => unsubscribe());
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (opensPickerFromBox(e, ask.text)) {
      e.preventDefault();
      openDialog({ kind: 'projectPicker' });
      return;
    }
    if (isCaretChord(e)) {
      (e.nativeEvent as MarkedEvent)._handled = true;
      return;
    }
    const action = askKey(ask.phase, { key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing });
    if (!action) return;
    e.preventDefault();
    switch (action) {
      case 'send': void sendAsk(); return;
      case 'cancel': cancelAsk(); return;
      case 'up': stepAskChoice(-1); return;
      case 'down': stepAskChoice(1); return;
      case 'start': startAskChoice(); return;
      case 'picker': openPickerFromChoices(); return;
      case 'close': closeAskChoices(); return;
      case 'swallow': return;
    }
  };

  return (
    <AskField
      ask={ask}
      boxRef={box}
      placeholder="What are we working on?"
      ariaLabel="Ask Patch to start a session"
      choiceLabel={projectLabel}
      onChange={changeAskText}
      onKeyDown={onKeyDown}
      onHoverChoice={hoverAskChoice}
      onPickChoice={startAskChoice}
    />
  );
}
