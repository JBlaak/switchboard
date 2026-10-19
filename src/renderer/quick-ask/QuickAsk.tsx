/**
 * The Quick Ask pop-up (#142): the slab, holding the empty screen's box and
 * its choice list, and a line for what came of a send.
 *
 * The window is a still transparent area larger than the slab (G3); only the
 * slab takes the mouse, so this reports when the pointer is over it, and main
 * lets everything else through to the window underneath. The glass moves inside
 * the window (`motion`), so the check runs again on every frame it moves. The
 * box has the focus whenever the pop-up shows, with the draft selected (B6),
 * and when a capture undone puts the text back (C4).
 */
import { useEffect, useRef } from 'react';
import { useStoreOf } from '../ui/use-store-of';
import { AskField } from '../ui/ask/AskField';
import { quickAskPhase, savedLabel, savingLine } from '../state/quick-ask-slice';
import { store } from './store';
import { overSlab, quickAskKey } from './quick-ask-keys';
import { slabMotion } from './motion';
import {
  cancel, changeText, close, closeChoices, hoverChoice, openPicker, send, startChoice, stepChoice, undo,
} from './actions';
import type { JSX, KeyboardEvent } from 'react';
import type { QuickAskState } from '../state/quick-ask-slice';

const selectAll = (state: QuickAskState): QuickAskState => state;

export function QuickAsk(): JSX.Element {
  const state = useStoreOf(store, selectAll);
  const box = useRef<HTMLTextAreaElement>(null);
  const slab = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const mark = useRef<HTMLSpanElement>(null);

  useEffect(() => slabMotion.attach(slab.current!, inner.current!, mark.current!), []);

  // The box takes the focus, the draft selected, each time the pop-up shows,
  // and once an undo has put the text back, after it is in the box.
  useEffect(() => {
    const focusBox = (): void => {
      box.current?.focus({ preventScroll: true });
      box.current?.select();
    };
    focusBox();
    return store.subscribe((_state, _previous, event) => {
      if (event.type === 'quickAskShown') focusBox();
      if (event.type === 'quickAskRestored') setTimeout(focusBox, 0);
    });
  }, []);

  // Over the slab or not, told to main only when it changes: as the pointer
  // moves, and as the slab moves under a pointer that holds still.
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
    slabMotion.onMove = check;
    document.addEventListener('mousemove', onMove);
    document.documentElement.addEventListener('mouseleave', onLeave);
    // Main lets the mouse through each time it shows the pop-up, until told otherwise.
    const unsubscribe = store.subscribe((_state, _previous, event) => {
      if (event.type === 'quickAskShown') { pointer = null; over = false; }
    });
    return () => {
      unsubscribe();
      slabMotion.onMove = null;
      document.removeEventListener('mousemove', onMove);
      document.documentElement.removeEventListener('mouseleave', onLeave);
    };
  }, []);

  const phase = quickAskPhase(state);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    const action = quickAskKey(phase, {
      key: e.key, shiftKey: e.shiftKey, metaKey: e.metaKey, isComposing: e.nativeEvent.isComposing,
    });
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
      case 'undo': void undo(); return;
      case 'swallow': return;
    }
  };

  return (
    <div className={'quick-ask-slab is-' + phase} ref={slab} data-testid="quick-ask">
      <div className="quick-ask-sheen" aria-hidden="true" />
      <div className="quick-ask-inner" ref={inner}>
        <span className="quick-ask-mark" ref={mark} aria-hidden="true">
          <svg viewBox="0 0 16 16" fill="currentColor"><path d="M9.2 1 3 9h4l-1.2 6L12 7H8z" /></svg>
        </span>
        <span className="quick-ask-hint" aria-hidden="true">↵ send · esc close</span>
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
        <QuickAskResult state={state} />
        <QuickAskFoot state={state} />
      </div>
    </div>
  );
}

/** What came of a send, sliding into the box's row as the text slides out of it. */
function QuickAskResult({ state }: { state: QuickAskState }): JSX.Element | null {
  const { result } = state;
  switch (result?.kind) {
    case 'started':
      return (
        <p className="quick-ask-result" data-testid="quick-ask-line" role="status">
          <span className="quick-ask-done">Started in</span> <span className="quick-ask-where">{result.folder}</span>
        </p>
      );
    // "Task added · Call Peter · due Thu", and ⌘Z for the 3 s it shows (C4).
    case 'saved':
      return (
        <>
          <p className="quick-ask-result has-undo" data-testid="quick-ask-line" role="status">
            <span className="quick-ask-done">{savedLabel(result.target)}</span>
            {result.summary && <> <span className="quick-ask-where">· {result.summary}</span></>}
          </p>
          {/* A press would take the focus from the box, which keeps ⌘Z and Esc. */}
          <button type="button" className="quick-ask-undo" onMouseDown={e => e.preventDefault()} onClick={() => void undo()}>
            <kbd className="sw-kbd">⌘Z</kbd> Undo
          </button>
        </>
      );
    case 'undoing':
      return (
        <p className="quick-ask-result is-busy" data-testid="quick-ask-line" role="status">
          <span className="quick-ask-spinner" aria-hidden="true" />
          <span className="quick-ask-where">Taking it back…</span>
        </p>
      );
    case 'undone':
      return (
        <p className="quick-ask-result" data-testid="quick-ask-line" role="status">
          <span className="quick-ask-done">Undone</span>
        </p>
      );
    case 'saving':
    case undefined:
      return null;
  }
}

/** The line under the box while it waits or saves, or Patch's note after a capture failed. */
function QuickAskFoot({ state }: { state: QuickAskState }): JSX.Element | null {
  const { result } = state;
  const busy = result?.kind === 'saving' || (!result && state.box.phase === 'waiting');
  const line = result?.kind === 'saving' ? savingLine(result.target) : busy ? 'Thinking…' : result ? '' : state.note;
  if (!line) return null;
  return (
    <div className="quick-ask-foot">
      {/* Under Reduce motion, in place of the rim's orbiting highlight. */}
      {busy && <span className="quick-ask-spinner" aria-hidden="true" />}
      <p className="quick-ask-line" data-testid="quick-ask-line" role="status">{line}</p>
    </div>
  );
}
