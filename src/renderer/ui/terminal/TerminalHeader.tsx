/**
 * The bar above the terminal: which session, whether it is running, and what
 * the process last called itself.
 *
 * Two halves, each portalled into its own container in `#terminal-header`
 * (see `Root`): the header also holds the question panel's slot, which that
 * feature fills itself, between the info and the status. The header element
 * stays in `index.html` so the settings panel can keep hiding and showing it;
 * whether it is up follows the session on screen.
 *
 * The header is a window drag region; the stylesheet opts its spans and
 * buttons out (`_chrome.scss`), which is why the markup keeps its ids.
 */
import { useLayoutEffect } from 'react';
import type { JSX } from 'react';
import { remoteStatusLabel } from '../../../domain/remote/remote-status';
import { shallowEqual } from '../../state/store';
import { headerShellIn, headerTitleIn } from '../../state/terminal-slice';
import { useStore } from '../use-store';
import { stopSessionOnScreen } from './actions';

/** The session's name, the process title (or a CLI notice), its id and its shell. */
export function TerminalHeaderInfo(): JSX.Element {
  const { onScreen, name, title, shell } = useStore(state => ({
    onScreen: state.terminal.onScreen,
    name: state.terminal.headerName,
    title: headerTitleIn(state.terminal),
    shell: headerShellIn(state.terminal),
  }), shallowEqual);

  useLayoutEffect(() => {
    const header = document.getElementById('terminal-header');
    if (header) header.style.display = onScreen ? '' : 'none';
  }, [onScreen]);

  return (
    <>
      <span id="terminal-header-name">{name}</span>
      <span id="terminal-header-pty-title" style={title ? undefined : { display: 'none' }}>{title}</span>
      <span id="terminal-header-id">{onScreen ?? ''}</span>
      <span id="terminal-header-shell" style={shell ? undefined : { display: 'none' }}>{shell ?? ''}</span>
    </>
  );
}

/**
 * Running or stopped, and the Stop button while it is running.
 *
 * A remote session mid-connect is neither running nor stopped, and saying
 * either is misleading — so a connection label takes precedence when there is
 * one. Its countdown re-renders off the shared remote tick.
 */
export function TerminalHeaderControls(): JSX.Element {
  const { running, remote } = useStore(state => {
    const id = state.terminal.onScreen;
    return {
      running: !!id && state.view.activePtyIds.has(id),
      remote: id ? state.remote.statuses[id] : undefined,
      // Selected only so each tick re-renders the countdown.
      tickAt: state.remote.tickAt,
    };
  }, shallowEqual);

  const connecting = remoteStatusLabel(remote);
  const status = connecting ? 'connecting' : running ? 'running' : 'stopped';
  const label = connecting ?? (running ? 'Running' : 'Stopped');

  return (
    <>
      <span id="terminal-header-status" className={status}>{label}</span>
      <button
        id="terminal-stop-btn" title="Stop process" onClick={stopSessionOnScreen}
        style={running ? undefined : { display: 'none' }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="2" width="8" height="8" rx="1" /></svg>
      </button>
    </>
  );
}
