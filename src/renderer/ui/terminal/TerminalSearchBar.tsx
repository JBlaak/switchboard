/**
 * Find in a terminal's buffer (Cmd+F).
 *
 * One per terminal, inside its container, so each session keeps its own bar.
 * Whether it is open lives in the store (the terminal's key handler asks for
 * it); the query is this bar's own. The searching itself is xterm's search
 * addon, reached through the session's entry in `openSessions`.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import type { ChangeEvent, JSX, KeyboardEvent } from 'react';
import { dispatch } from '../../state/app-store';
import { openSessions } from '../../state/session-store';
import { useStore } from '../use-store';

const SEARCH_OPTIONS = {
  decorations: {
    matchBackground: '#515C6A',
    activeMatchBackground: '#EAA549',
    matchOverviewRuler: '#515C6A',
    activeMatchColorOverviewRuler: '#EAA549',
  },
};

export interface TerminalSearchBarProps {
  sessionId: string;
}

export function TerminalSearchBar({ sessionId }: TerminalSearchBarProps): JSX.Element {
  // How many times the bar has been asked open; undefined while closed.
  const opened = useStore(state => state.terminal.searches[sessionId]);
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  // The id as of now, for the effect below without re-running it on a re-key.
  const current = useRef(sessionId);
  useLayoutEffect(() => { current.current = sessionId; }, [sessionId]);

  // Each ask takes the keyboard, and starts from what is selected, if anything.
  useLayoutEffect(() => {
    if (opened === undefined) return;
    input.current?.focus();
    const entry = openSessions.get(current.current);
    const selection = entry?.terminal.getSelection();
    if (selection) {
      setQuery(selection);
      entry?.searchAddon?.findNext(selection, SEARCH_OPTIONS);
    }
  }, [opened]);

  const addon = () => openSessions.get(sessionId)?.searchAddon;
  const next = () => addon()?.findNext(query, SEARCH_OPTIONS);
  const previous = () => addon()?.findPrevious(query, SEARCH_OPTIONS);

  function close(): void {
    dispatch({ type: 'terminalSearchClosed', sessionId });
    addon()?.clearDecorations();
    setQuery('');
    openSessions.get(sessionId)?.terminal.focus();
  }

  function onChange(e: ChangeEvent<HTMLInputElement>): void {
    const q = e.target.value;
    setQuery(q);
    if (q) addon()?.findNext(q, SEARCH_OPTIONS);
    else addon()?.clearDecorations();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Escape') { close(); e.preventDefault(); }
    else if (e.key === 'Enter' && e.shiftKey) { previous(); e.preventDefault(); }
    else if (e.key === 'Enter') { next(); e.preventDefault(); }
  }

  return (
    <div className="terminal-search-bar" style={{ display: opened === undefined ? 'none' : 'flex' }}>
      <input
        ref={input} type="text" className="terminal-search-input" placeholder="Find..."
        value={query} onChange={onChange} onKeyDown={onKeyDown}
      />
      <span className="terminal-search-count"></span>
      <button className="terminal-search-prev" title="Previous (Shift+Enter)" onClick={previous}>&#x25B2;</button>
      <button className="terminal-search-next" title="Next (Enter)" onClick={next}>&#x25BC;</button>
      <button className="terminal-search-close" title="Close (Escape)" onClick={close}>&times;</button>
    </div>
  );
}
