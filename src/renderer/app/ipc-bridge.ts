/**
 * The one place the renderer listens to the main process.
 *
 * Every `window.api.on*` is subscribed here, once, and turned into a
 * `RendererEvent` for the store. Nothing is decided here: the reducers record
 * what changed, and the follow-ups that still have to touch the DOM or the
 * terminals subscribe to the store (see `ipc-listeners`).
 *
 * The exception is the terminal byte stream. It is far too frequent for a
 * store, and nothing but the terminal it belongs to cares about it, so it goes
 * straight to the terminal manager.
 */
import type { RendererEvent } from '../state/events';
import type { SwitchboardApi } from '../../ipc/api';

/**
 * Subscribe to every push channel.
 *
 * `send` is the store's `dispatch` and `terminalData` the terminal manager's
 * buffer; both are passed in so the bridge loads in node, where the tests
 * drive it with a fake `api`. Answers the unsubscribe for all of them, so a
 * reload or a test can tear the bridge down without leaking listeners in the
 * preload.
 */
export function installIpcBridge(
  api: SwitchboardApi,
  send: (event: RendererEvent) => void,
  terminalData: (sessionId: string, data: string) => void,
): () => void {
  const unsubscribes = [
    api.onTerminalData(terminalData),
    api.onProcessExited((sessionId, exitCode) => send({ type: 'processExited', sessionId, exitCode })),
    api.onSessionForked((oldId, newId) => send({ type: 'sessionForked', oldId, newId })),
    api.onCliBusyState((sessionId, busy) => send({ type: 'cliBusyState', sessionId, busy })),
    api.onTerminalNotification((sessionId, message) =>
      send({ type: 'terminalNotification', sessionId, message })),
    api.onSessionNeedsAttention((sessionId) => send({ type: 'sessionNeedsAttention', sessionId })),
    api.onSessionAgents((sessionId, agents) => send({ type: 'sessionAgents', sessionId, agents })),
    // Stamped on arrival: the countdowns are measured from when it got here.
    api.onRemoteStatus((sessionId, status) =>
      send({ type: 'remoteStatus', sessionId, status, receivedAt: Date.now() })),
    api.onQuestionsAsked((pending) => send({ type: 'questionsAsked', pending })),
    api.onQuestionsSettled((settled) => send({ type: 'questionsSettled', settled })),
    api.onProjectsChanged(() => send({ type: 'projectsChanged' })),
    api.onStatusUpdate((text, kind) => send({ type: 'statusUpdate', text, kind })),
    api.onFullscreenChanged((isFullscreen) => send({ type: 'fullscreenChanged', isFullscreen })),
    api.onUpdateAvailable((update) => send({ type: 'updateAvailable', update })),
  ];
  return () => unsubscribes.forEach(unsubscribe => unsubscribe());
}
