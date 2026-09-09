/**
 * The card that narrates a remote session's connection.
 *
 * A remote terminal is empty until ssh says something, and ssh can take a long
 * time to say anything — a sleeping host, a 1Password approval, a banner
 * exchange that never completes. Without a status of its own the screen is
 * indistinguishable from a frozen app, which is exactly what a slow or failing
 * connect looked like.
 *
 * Two surfaces, deliberately. This card carries the live state — what we are
 * doing, to which host, how long it has left, what you can do about it — and
 * lives inside the terminal container so it follows the terminal into a grid
 * card with no extra plumbing. The scrollback keeps a one-line record of each
 * break, so the reason is still there afterwards.
 *
 * Reconnects are driven by the main process; this only reports them.
 */
import { COLOUR_WARN, statusBanner } from '../../../domain/terminal/ansi';
import { openSessions, sessionMap, view } from '../../state/session-store';
import { forgetStatus, recordStatus, remoteStatus, syncTicker } from '../../state/remote-status-store';
import { openSession } from '../sessions/session-actions';
import { updateTerminalHeader } from '../sessions/terminal-header';
import type { RemoteStatusPayload } from '../../../domain/remote/remote-status';

/**
 * What the connecting bar fills toward.
 *
 * Matches ssh's own ConnectTimeout, so the bar reaching the end means the
 * attempt has actually run out rather than the animation guessing.
 */
const CONNECT_TIMEOUT_MS = 10000;

/** How long the green "reconnected" beat stays before the card steps aside. */
const CONNECTED_FLASH_MS = 500;

const CARD_HTML = `
  <div class="rc-card">
    <svg class="rc-link" viewBox="0 0 220 58" aria-hidden="true">
      <rect class="rc-node" x="11" y="18" width="38" height="26" rx="5"/>
      <circle class="rc-node-mark" cx="30" cy="31" r="4"/>
      <path class="rc-wire" d="M55 31H165"/>
      <path class="rc-flow" d="M55 31H165"/>
      <circle class="rc-spark" cx="55" cy="31" r="3.5"/>
      <g class="rc-break">
        <path d="M103 22l14 18"/>
        <path d="M117 22l-14 18"/>
      </g>
      <rect class="rc-node" x="171" y="18" width="38" height="26" rx="5"/>
      <path class="rc-node-mark" d="M178 25h24M178 31h24M178 37h15"/>
    </svg>
    <div class="rc-status"></div>
    <div class="rc-target"></div>
    <div class="rc-bar"><i></i></div>
    <div class="rc-detail"></div>
    <div class="rc-actions">
      <button class="rc-retry" type="button">Retry now</button>
      <button class="rc-cancel" type="button">Stop trying</button>
    </div>
  </div>`;

const PHASE_CLASSES = ['is-connecting', 'is-retrying', 'is-failed', 'is-connected'];

/**
 * Act on a status the main process sent.
 *
 * Each phase does two things: update the card, and — for the phases that mean
 * something changed — leave a line in the scrollback that survives the next
 * reconnect.
 */
export function handleRemoteStatus(sessionId: string, status: RemoteStatusPayload): void {
  const previous = remoteStatus.get(sessionId);
  const target = status.target || 'the remote host';

  switch (status.phase) {
    case 'connecting':
      recordStatus(sessionId, status);
      renderCard(sessionId);
      restartBar(ensureCard(sessionId), CONNECT_TIMEOUT_MS);
      break;

    case 'connected':
      recordStatus(sessionId, status);
      // A brief green beat so a reconnect is visibly resolved rather than the
      // card just vanishing. On a first connect the tmux repaint says it well
      // enough, so the card goes straight away.
      if (previous?.attempt) {
        renderCard(sessionId);
        writeStatusLine(sessionId, 'reconnected');
        setTimeout(() => {
          if (remoteStatus.get(sessionId)?.phase === 'connected') hideCard(sessionId);
        }, CONNECTED_FLASH_MS);
      } else {
        hideCard(sessionId);
      }
      break;

    case 'retrying':
      recordStatus(sessionId, status);
      // The reason also goes to the scrollback, where it survives the next
      // reconnect — the card only ever shows the break it is currently on.
      writeStatusLine(sessionId, status.everConnected
        ? `connection lost: ${status.reason}`
        : `could not reach ${target}: ${status.reason}`, COLOUR_WARN);
      renderCard(sessionId);
      restartBar(ensureCard(sessionId), status.delayMs ?? 0);
      break;

    case 'failed':
      recordStatus(sessionId, status);
      writeStatusLine(sessionId,
        `gave up ${status.everConnected ? 'reconnecting to' : 'connecting to'} ${target}`,
        COLOUR_WARN);
      renderCard(sessionId);
      break;

    case 'disconnected':
      forgetStatus(sessionId);
      hideCard(sessionId);
      break;
  }

  syncTicker();
  if (sessionId === view.activeSessionId) updateTerminalHeader();
}

/** Repaint the cards whose countdown is still moving. */
export function tickConnectionCards(sessionIds: readonly string[]): void {
  for (const sessionId of sessionIds) renderCard(sessionId);
  updateTerminalHeader();
}

/**
 * The card for a session, built on first use.
 *
 * Local sessions never pay for it, and it is appended to the terminal's own
 * container so it moves with the terminal.
 */
function ensureCard(sessionId: string): HTMLElement | null {
  const entry = openSessions.get(sessionId);
  if (!entry) return null;
  if (entry.remoteCard) return entry.remoteCard;

  const card = document.createElement('div');
  card.className = 'rc';
  card.hidden = true;
  card.innerHTML = CARD_HTML;

  card.querySelector<HTMLElement>('.rc-retry')!.onclick = () => void retry(sessionId);
  card.querySelector<HTMLElement>('.rc-cancel')!.onclick = () => {
    // The tmux session on the far end is untouched by this, so there is nothing
    // to confirm — it only stops Switchboard dialling.
    void window.api.stopSession(sessionId);
  };

  entry.element.appendChild(card);
  entry.remoteCard = card;
  return card;
}

/**
 * "Retry now".
 *
 * While the session is still held by the main process this just short-circuits
 * the backoff; once it has been retired — retries exhausted, so the row went
 * back to Stopped — the only way back is a fresh open.
 */
async function retry(sessionId: string): Promise<void> {
  const entry = openSessions.get(sessionId);
  if (entry && !entry.closed) {
    const result = await window.api.reconnectRemote(sessionId).catch(() => null);
    if (result?.ok) return;
  }
  const session = sessionMap.get(sessionId) || entry?.session;
  if (session) void openSession(session);
}

function hideCard(sessionId: string): void {
  const card = openSessions.get(sessionId)?.remoteCard;
  if (card) card.hidden = true;
}

/**
 * Restart the bar's animation.
 *
 * Re-assigning a class does not replay keyframes, so the element is swapped for
 * a clone — the one reliable way to retrigger one.
 */
function restartBar(card: HTMLElement | null, durationMs: number): void {
  const bar = card?.querySelector<HTMLElement>('.rc-bar');
  const fresh = bar?.querySelector<HTMLElement>('i')?.cloneNode(false);
  if (!bar || !fresh) return;
  bar.replaceChildren(fresh);
  bar.style.setProperty('--rc-duration', durationMs + 'ms');
}

/**
 * Paint the card from the stored status plus the clock.
 *
 * Everything it shows is derived, so the per-second tick is just this function
 * again.
 */
function renderCard(sessionId: string): void {
  const status = remoteStatus.get(sessionId);
  if (!status) return;
  const card = ensureCard(sessionId);
  if (!card) return;

  const attemptOf = status.maxAttempts ? `attempt ${status.attempt} of ${status.maxAttempts}` : '';
  const statusEl = card.querySelector<HTMLElement>('.rc-status')!;
  const detailEl = card.querySelector<HTMLElement>('.rc-detail')!;

  card.classList.remove(...PHASE_CLASSES);
  card.querySelector<HTMLElement>('.rc-target')!.textContent = status.target || 'the remote host';

  switch (status.phase) {
    case 'connecting': {
      card.classList.add('is-connecting');
      statusEl.textContent = status.attempt ? 'Reconnecting' : 'Connecting';
      // Counting up toward a limit the user can see coming beats an
      // indeterminate spinner that could mean anything.
      const seconds = Math.floor((Date.now() - (status.startedAt ?? Date.now())) / 1000);
      detailEl.textContent = [attemptOf, seconds >= 1 ? `${seconds}s` : ''].filter(Boolean).join(' · ');
      break;
    }
    case 'retrying': {
      card.classList.add('is-retrying');
      const seconds = Math.max(0, Math.ceil(((status.retryAt ?? 0) - Date.now()) / 1000));
      statusEl.textContent = seconds > 0 ? `Reconnecting in ${seconds}s` : 'Reconnecting…';
      detailEl.textContent = [status.reason, attemptOf].filter(Boolean).join(' · ');
      break;
    }
    case 'failed':
      card.classList.add('is-failed');
      statusEl.textContent = status.everConnected ? 'Lost connection' : 'Could not connect';
      detailEl.textContent = status.reason || '';
      break;
    case 'connected':
      card.classList.add('is-connected');
      statusEl.textContent = 'Connected';
      detailEl.textContent = '';
      break;
  }

  card.hidden = false;
}

/**
 * A permanent line in the scrollback.
 *
 * In the same dim rule as the session-exit banner, so status reads as chrome
 * rather than output from the remote host.
 */
function writeStatusLine(sessionId: string, text: string, colour?: string): void {
  const entry = openSessions.get(sessionId);
  if (!entry) return;
  try {
    entry.terminal.write(statusBanner(text, colour));
  } catch {
    // The terminal was disposed between the status arriving and this write.
  }
}
