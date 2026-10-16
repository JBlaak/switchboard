/**
 * Everything that can change the renderer's state, as one typed union.
 *
 * Three sources feed it: what the main process pushes (one event per channel
 * in `EVENT`), what the user does, and what the renderer's own timers notice.
 * Naming them all here is what lets the reducers be the single place the rules
 * live, rather than each caller mutating a Map and remembering to redraw.
 *
 * `terminalData` is the one push channel that is not here: it is the terminal
 * byte stream, far too frequent for a store, and it goes straight to the
 * terminal manager instead (see `app/ipc-bridge`).
 */
import type { EVENT } from '../../ipc/channels';
import type { PendingQuestions, QuestionsSettled } from '../../domain/questions/question';
import type { RemoteStatusPayload } from '../../domain/remote/remote-status';
import type { UpdateNotice } from '../../domain/update/release';
import type { UsageLimit } from '../../domain/usage/usage';
import type { WorkingAgent } from '../../domain/terminal/program-status-children';
import type { ViewState } from './view-slice';

// ── Pushed by the main process ──

export type PushEvent =
  | { type: 'processExited'; sessionId: string; exitCode: number }
  | { type: 'sessionForked'; oldId: string; newId: string }
  | { type: 'cliBusyState'; sessionId: string; busy: boolean }
  | { type: 'terminalNotification'; sessionId: string; message: string }
  | { type: 'sessionNeedsAttention'; sessionId: string }
  | { type: 'sessionAgents'; sessionId: string; agents: readonly WorkingAgent[] }
  /** `receivedAt` is stamped by the bridge, so the reducer stays pure. */
  | { type: 'remoteStatus'; sessionId: string; status: RemoteStatusPayload; receivedAt: number }
  | { type: 'questionsAsked'; pending: PendingQuestions }
  | { type: 'questionsSettled'; settled: QuestionsSettled }
  | { type: 'projectsChanged' }
  | { type: 'statusUpdate'; text: string; kind: string }
  | { type: 'fullscreenChanged'; isFullscreen: boolean }
  | { type: 'updateAvailable'; update: UpdateNotice };

// ── From the renderer itself: user actions and timers ──

export type LocalEvent =
  /**
   * The renderer has rows for these sessions (fetched, or just launched); the
   * ones it has not seen before get a local key (see `keys-slice`).
   */
  | { type: 'sessionsSeen'; sessionIds: readonly string[] }
  /** The session on screen changed (or none is). */
  | { type: 'activeSessionChanged'; sessionId: string | null }
  /**
   * The vanilla code's assignments to `view`, carried as they are.
   *
   * A stopgap: each field gets an intent of its own as the surface that writes
   * it moves to React. Until then the `view` adapter turns `view.x = y` into
   * this, so no caller had to change.
   */
  | { type: 'viewPatched'; patch: Partial<ViewState> }
  /** A session was stopped from here, ahead of the next poll noticing. */
  | { type: 'ptyStopped'; sessionId: string }
  /** The user is looking at this session now, so nothing about it is unread. */
  | { type: 'sessionViewed'; sessionId: string }
  /** Nothing runs under this session any more: busy, ready and waiting all go. */
  | { type: 'activityCleared'; sessionId: string }
  /** The renderer dropped a session's terminal, and its connection state with it. */
  | { type: 'remoteStatusForgotten'; sessionId: string }
  /** The shared once-a-second clock the connection countdowns run on. */
  | { type: 'remoteTick'; at: number }
  /** The quota gauges fetched the usage windows. */
  | { type: 'usageFetched'; rows: readonly UsageLimit[] }
  /** The usage fetch failed; what is known stays, but it counts as loaded. */
  | { type: 'usageFailed' }
  // The terminals' chrome; see `terminal-slice`. Never the byte stream.
  /** A terminal was created for a session; `slotId` keys its container. */
  | { type: 'terminalOpened'; sessionId: string; slotId: number }
  /** A session's terminal was torn down. */
  | { type: 'terminalClosed'; sessionId: string }
  /** A session's terminal and header were put on screen, the header naming it `name`. */
  | { type: 'sessionShown'; sessionId: string; name: string }
  /** The session on screen has a new name for the header (after a re-key). */
  | { type: 'headerRenamed'; sessionId: string; name: string }
  /** Something asked the header to repaint, which puts the process title back over a notice. */
  | { type: 'headerRefreshed' }
  /** The process in a terminal set its title (OSC 0). */
  | { type: 'ptyTitleChanged'; sessionId: string; title: string }
  /** The shell profile a session runs in; null when it is the default. */
  | { type: 'shellProfileResolved'; sessionId: string; name: string | null }
  /** Cmd+F in a terminal. */
  | { type: 'terminalSearchOpened'; sessionId: string }
  | { type: 'terminalSearchClosed'; sessionId: string };

export type RendererEvent = PushEvent | LocalEvent;

/**
 * A compile-time check that `PushEvent` names every push channel but the
 * terminal stream, and nothing else. Adding a channel to `EVENT` without an
 * event here — or the other way round — fails `npm run typecheck`.
 */
type PushChannel = Exclude<keyof typeof EVENT, 'terminalData'>;
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const pushEventsCoverEveryChannel: Exact<PushEvent['type'], PushChannel> = true;
void pushEventsCoverEveryChannel;
