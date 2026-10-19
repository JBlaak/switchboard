/**
 * The Quick Ask pop-up (#142): the slab, holding the empty screen's box and
 * its choice list, and a line for what came of a send.
 *
 * The window is a still transparent area larger than the slab (G3); only the
 * slab takes the mouse, so this reports when the pointer is over it, and main
 * lets everything else through to the window underneath. The box has the focus
 * whenever the pop-up shows, with the draft selected (B6).
 */
import { useEffect, useRef } from 'react';
import { useStoreOf } from '../ui/use-store-of';
import { AskField } from '../ui/ask/AskField';
import { quickAskPhase } from '../state/quick-ask-slice';
import { store } from './store';
import { overSlab, quickAskKey } from './quick-ask-keys';
import {
  cancel, changeText, close, closeChoices, hoverChoice, openPicker, send, startChoice, stepChoice,
} from './actions';
import type { JSX, KeyboardEvent } from 'react';
import type { QuickAskState } from '../state/quick-ask-slice';

const selectAll = (state: QuickAskState): QuickAskState => state;

export function QuickAsk(): JSX.Element {
  const state = useStoreOf(store, selectAll);
  const box = useRef<HTMLTextAreaElement>(null);
  const slab = useRef<HTMLDivElement>(null);

  // The box takes the focus, the draft selected, each time the pop-up shows.
  useEffect(() => {
    const focusBox = (): void => {
      box.current?.focus({ preventScroll: true });
      box.current?.select();
    };
    focusBox();
    return store.subscribe((_state, _previous, event) => {
      if (event.type === 'quickAskShown') focusBox();
    });
  }, []);

  // Over the slab or not, told to main only when it changes: as the pointer
  // moves, and as the slab grows or shrinks under a pointer that holds still.
  useEffect(() => {
    let pointer: { x: number; y: number } | null = null;
    let over = false;
    const check = (): void => {
      const rect = slab.current?.getBoundingClientRect();
      const now = !!pointer && !!rect && overSlab(pointer.x, pointer.y, rect);
      if (now === over) return;
      over = now;
      window.quickAsk.pointerOverSlab(now);
    };
    const onMove = (e: MouseEvent): void => { pointer = { x: e.clientX, y: e.clientY }; check(); };
    const onLeave = (): void => { pointer = null; check(); };
    const resized = new ResizeObserver(check);
    if (slab.current) resized.observe(slab.current);
    document.addEventListener('mousemove', onMove);
    document.documentElement.addEventListener('mouseleave', onLeave);
    // Main lets the mouse through each time it shows the pop-up, until told otherwise.
    const unsubscribe = store.subscribe((_state, _previous, event) => {
      if (event.type === 'quickAskShown') { pointer = null; over = false; }
    });
    return () => {
      unsubscribe();
      resized.disconnect();
      document.removeEventListener('mousemove', onMove);
      document.documentElement.removeEventListener('mouseleave', onLeave);
    };
  }, []);

  const phase = quickAskPhase(state);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    const action = quickAskKey(phase, { key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing });
    if (!action) return;
    e.preventDefault();
    switch (action) {
      case 'send': void send(); return;
      case 'cancel': cancel(); return;
      case 'up': stepChoice(-1); return;
      case 'down': stepChoice(1); return;
      case 'start': void startChoice(); return;
      case 'picker': openPicker(); return;
      case 'close': closeChoices(); return;
      case 'dismiss': close(); return;
      case 'swallow': return;
    }
  };

  return (
    <div className={'quick-ask-slab is-' + phase} ref={slab} data-testid="quick-ask">
      <AskField
        ask={state.box}
        boxRef={box}
        placeholder="Ask Patch anything…"
        ariaLabel="Ask Patch"
        choiceLabel={(_projectPath, index) => state.folders[index] ?? _projectPath}
        onChange={changeText}
        onKeyDown={onKeyDown}
        onHoverChoice={hoverChoice}
        onPickChoice={index => void startChoice(index)}
      />
      <QuickAskLine state={state} />
    </div>
  );
}

/** What the pop-up says under the box, if anything. */
function QuickAskLine({ state }: { state: QuickAskState }): JSX.Element | null {
  const line = lineFor(state);
  if (!line) return null;
  return <p className="quick-ask-line" data-testid="quick-ask-line" role="status">{line}</p>;
}

function lineFor(state: QuickAskState): string {
  const { result } = state;
  if (result?.kind === 'started') return `Started in ${result.folder}`;
  if (result?.kind === 'saving') return 'Saving…';
  if (result?.kind === 'saved') return result.summary;
  if (state.box.phase === 'waiting') return 'Thinking…';
  return state.note;
}
