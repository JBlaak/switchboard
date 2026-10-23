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
import type { CaptureTarget } from '../../domain/ask/model';
import type { PendingQuestions, QuestionsSettled } from '../../domain/questions/question';
import type { RemoteStatusPayload } from '../../domain/remote/remote-status';
import type { PhoneAccessState, TerminalOwner } from '../../domain/phone/state';
import type { UpdateNotice } from '../../domain/update/release';
import type { SessionWorkDiff, SessionWorkSnapshot, WorkAction } from '../../domain/session-work/model';
import type { DiffMode, ImageDefaults, ReviewKind, WorkTab } from './session-work-slice';
import type { PlanSource, SessionPlansAnswer } from './plan-slice';
import type { ProjectView } from './main-area-slice';
import type { IssueKey } from '../../domain/plan/model';
import type { IssueSessionStart } from '../../domain/plan/issue-session';
import type { ImageMode } from '../ui/session-work/image-compare/modes/types';
import type { Background, View } from '../ui/session-work/image-compare/types';
import type { DiffSide } from '../../domain/session-work/model';
import type { PullRequestStatusChange } from '../../domain/session-work/status';
import type { UsageLimit } from '../../domain/usage/usage';
import type { WorkingAgent } from '../../domain/terminal/program-status-children';
import type { ToolbarEvent } from './toolbar-slice';
import type { SessionListEvent } from './session-list-slice';
import type { ProjectPageEvent } from './project-page-slice';
import type { PhoneAccessEvent } from './phone-access-slice';
import type { ViewState } from './view-slice';
import type { DraftAction } from '../../domain/questions/answer-draft';
import type { QuestionView } from './answers-slice';
import type { DialogRequest } from './dialog-slice';
import type { SettingsRecord } from './settings-slice';
import type { ShellProfile } from '../../domain/shell/shell-profile';
import type { RouteResult } from '../../domain/ask/model';

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
  | { type: 'updateAvailable'; update: UpdateNotice }
  | { type: 'sessionWorkSnapshot'; snapshot: SessionWorkSnapshot }
  | { type: 'prStatusChanged'; change: PullRequestStatusChange }
  /** Quick Ask (#142): start a Claude session there on this prompt (R3). */
  | { type: 'launchRequested'; projectPath: string; initialPrompt: string }
  /** Quick Ask: the New Session picker, holding this prompt; `reason` is Patch's line. */
  | { type: 'pickerRequested'; initialPrompt: string; reason?: string }
  /** Phone access (#194): the whole snapshot, on every change. */
  | { type: 'phoneAccessChanged'; state: PhoneAccessState }
  /** A session's terminal moved to a phone, or back to the Mac. */
  | { type: 'terminalOwnerChanged'; sessionId: string; owner: TerminalOwner }
  /** Main started a Claude session the renderer didn't ask for (a phone's Ask Patch). */
  | { type: 'sessionStarted'; sessionId: string; projectPath: string }
  /** A phone archived a session; main has stopped it and archived its row. */
  | { type: 'sessionArchived'; sessionId: string };

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
  /** The green beat after a reconnect has had its moment; the card steps aside. */
  | { type: 'remoteConnectedBeatEnded'; sessionId: string }
  /** The quota gauges fetched the usage windows. */
  | { type: 'usageFetched'; rows: readonly UsageLimit[] }
  /** The usage fetch failed; what is known stays, but it counts as loaded. */
  | { type: 'usageFailed' }
  /** A key, click or keystroke on the question panel, for the set it is showing. */
  | { type: 'answerAction'; toolUseId: string; action: DraftAction }
  /** The question panel showed this set for the first time; Patch says hello. */
  | { type: 'answersGreeted'; toolUseId: string }
  /** Answer this set in the terminal instead, or go back to the panel. */
  | { type: 'answerViewChosen'; toolUseId: string; view: QuestionView }
  /** Look at the terminal under this set for a moment, or stop looking; the draft stays as it is. */
  | { type: 'answersPeeked'; toolUseId: string; peeking: boolean }
  /** Patch was poked beside this set. */
  | { type: 'answersPatchPoked'; toolUseId: string }
  /** The doze timer: this set has `minutesLeft` before the terminal takes over. */
  | { type: 'answersDozed'; toolUseId: string; minutesLeft: number }
  /** Main took the answers to this set; Patch sees them off. A prompt to act; no state changes. */
  | { type: 'answersDelivered'; toolUseId: string }
  /** The empty screen came into view; Patch appears on it. A prompt to act; no state changes. */
  | { type: 'emptyScreenShown' }
  /** Open a modal dialog, replacing any that is open. */
  | { type: 'dialogOpened'; request: DialogRequest }
  /** Close the dialog opened as `seq`; a stale close from a replaced one does nothing. */
  | { type: 'dialogClosed'; seq: number }
  /** The settings panel opened, with what is stored. */
  | {
    type: 'settingsOpened';
    current: SettingsRecord;
    shellProfiles: readonly ShellProfile[];
    appVersion: string | null;
    /** Whether main holds ⌥Space for Quick Ask, as it was when the panel opened. */
    quickAskRegistered: boolean;
    /** The capture targets whose server isn't in `~/.claude.json` (C6). */
    quickAskMissing: readonly CaptureTarget[];
  }
  /** The settings panel's Save went through. */
  | { type: 'settingsSaved' }
  /** The settings panel closed, or the terminal took its place. */
  | { type: 'settingsClosed' }
  /** A project's settings view (#176) read what the project and the global settings store. */
  | { type: 'projectSettingsLoaded'; projectPath: string; current: SettingsRecord; globalSettings: SettingsRecord }
  /** A change on a project's settings view was stored; `current` is the project's blob as written. */
  | { type: 'projectSettingsSaved'; projectPath: string; current: SettingsRecord }
  /** The project list loaded with this many sessions running. */
  | { type: 'runningCounted'; running: number }
  /** A done status message has lingered long enough. */
  | { type: 'statusActivityExpired' }
  /** The renderer asked main for a waiting update at launch. */
  | { type: 'updateChecked'; update: UpdateNotice | null }
  /** The user hid the update notice for this version. */
  | { type: 'updateDismissed'; version: string }
  | { type: 'updateInstallStarted' }
  /** Main answered the install, which means it did not quit to finish it. */
  | { type: 'updateInstallFailed' }
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
  | { type: 'terminalSearchClosed'; sessionId: string }
  // The Session work page; see `session-work-slice`.
  /** The page opened for a session (its list a skeleton until the first snapshot); `at` stamps its clock. */
  | { type: 'sessionWorkOpened'; sessionId: string; name: string; at: number }
  /** The page for this session closed: Esc, Back, Cmd+G. A close for a page not open does nothing. */
  | { type: 'sessionWorkClosed'; sessionId: string }
  /** Main answered whether the page can open for this session (D14). */
  | { type: 'sessionWorkEligibility'; sessionId: string; canOpen: boolean }
  /** An item was clicked, or `j`/`k` moved to it. */
  | { type: 'sessionWorkItemSelected'; itemId: string }
  | { type: 'sessionWorkDoneToggled' }
  /**
   * The selected item's diff was asked of main. `key` is the item as it was
   * asked for (`diffKey`): a snapshot that changes the item asks again, and an
   * answer for an older key is dropped.
   */
  | { type: 'sessionWorkDiffRequested'; sessionId: string; itemId: string; key: string }
  /** Main answered an item's diff; one with an `error` and no files is a failure. */
  | { type: 'sessionWorkDiffLoaded'; sessionId: string; itemId: string; key: string; diff: SessionWorkDiff }
  /** The request itself failed. */
  | { type: 'sessionWorkDiffFailed'; sessionId: string; itemId: string; key: string; message: string }
  /** The Unified/Split toggle, or `u`. */
  | { type: 'sessionWorkDiffModeSet'; mode: DiffMode }
  /** "Show diff" on a file that started collapsed (D7). */
  | { type: 'sessionWorkFileExpanded'; itemId: string; path: string }
  /** `n`/`p` moved to a file of the item's diff. */
  | { type: 'sessionWorkFileFocused'; itemId: string; path: string }
  /** The page's once-a-second clock, for "updated Xs ago". Only runs while it is open. */
  | { type: 'sessionWorkTicked'; at: number }
  /** An action button was pressed: main is asked to queue it (A2). */
  | { type: 'sessionWorkActionRequested'; sessionId: string; itemId: string; action: WorkAction; threadIds?: string[] }
  /** Main answered: queued (`error` null; the snapshot shows it), or refused with why. */
  | { type: 'sessionWorkActionAnswered'; sessionId: string; itemId: string; error: string | null }
  /** `+` or `c` on a line of a PR's diff: the comment composer opens under it (C1). */
  | { type: 'sessionWorkComposerOpened'; itemId: string; path: string; line: number; side: DiffSide }
  /** Cancel, Esc, or the comment went into the review. */
  | { type: 'sessionWorkComposerClosed' }
  /** Add to review, or one of the pending review bar's buttons, was pressed: main is asked (C2). */
  | { type: 'sessionWorkReviewRequested'; sessionId: string; itemId: string; kind: ReviewKind }
  /** Main answered: done (`error` null; the snapshot shows it), or refused with why. */
  | { type: 'sessionWorkReviewAnswered'; sessionId: string; itemId: string; kind: ReviewKind; error: string | null }
  /** The image cards' defaults as saved, read back when the renderer starts (C1, C3). */
  | { type: 'sessionWorkImageDefaultsRestored'; defaults: ImageDefaults }
  /**
   * An image card's stage measured its frame; `fit` is the view that fits it.
   * The first one opens the card's state; later ones refit a card not zoomed or panned since.
   */
  | { type: 'sessionWorkImageFramed'; itemId: string; path: string; fit: View }
  /** A zoom, pan or double-click on an image card. */
  | { type: 'sessionWorkImageViewed'; itemId: string; path: string; view: View }
  /** `0` on an image card: back to fit (C6). */
  | { type: 'sessionWorkImageFitted'; itemId: string; path: string }
  /** A mode picked on an image card's toolbar, or with `1`–`5` (C1, C6). */
  | { type: 'sessionWorkImageModeSet'; itemId: string; path: string; mode: ImageMode }
  /** A click on Blink's image, or `b` (M4). */
  | { type: 'sessionWorkImageBlinked'; itemId: string; path: string }
  /** The background picked on any image card; every card follows it (C3). */
  | { type: 'sessionWorkImageBackgroundSet'; background: Background }
  /** The page's Work or Plan tab was picked, for that session (W1). */
  | { type: 'sessionWorkTabSet'; sessionId: string; tab: WorkTab }
  // The plan view; see `plan-slice`.
  /** A home put a plan view on screen: the Plan tab, or (#128) the main area. */
  | { type: 'planViewOpened'; owner: string; source: PlanSource }
  /** That home's plan view left the screen. */
  | { type: 'planViewClosed'; owner: string }
  /** A plan picked from the repository's others (W2), or the way back. */
  | { type: 'planSourcePicked'; owner: string; source: PlanSource }
  /** Main answered for a source (`planSourceKey`); null when it could not. */
  | { type: 'planLoaded'; owner: string; sourceKey: string; answer: SessionPlansAnswer | null }
  /** A plan picked in the switcher (W2). */
  | { type: 'planChosen'; plan: IssueKey }
  /** The pointer is over an issue, or over none (D3). */
  | { type: 'planIssueHovered'; issue: IssueKey | null }
  /** An issue was clicked, stepped to with ↑/↓, or walked to through Needs/Unlocks; null closes the detail (D4). */
  | { type: 'planIssueSelected'; issue: IssueKey | null }
  /** Which sessions own which issues (S1), asked with every load of the view. */
  | { type: 'planOwnersLoaded'; owner: string; owners: Record<string, string> }
  /** Start session pressed on the selected issue: `confirm` for a Locked one, which asks first (A3). */
  | { type: 'planStartAsked'; issue: IssueKey; confirm: boolean }
  /** The confirmation was turned down. */
  | { type: 'planStartCancelled' }
  /** The start came back: the new session, with a warning, or why it did not start. */
  | { type: 'planStartAnswered'; issue: IssueKey; result: IssueSessionStart }
  /** The levels seen per plan, read back from storage at start (A4). */
  | { type: 'planLevelsSeenRestored'; seen: Record<string, number | null> }
  /** A plan view has played the celebration with this id. */
  | { type: 'planCelebrationPlayed'; id: number }
  /** Start level pressed on a plan's current level: asks to confirm, naming the count (A1). */
  | { type: 'planLevelStartAsked'; plan: IssueKey; level: number; issues: IssueKey[] }
  | { type: 'planLevelStartConfirmed' }
  /** The confirmation was turned down, or the answer put away. */
  | { type: 'planLevelStartCancelled' }
  /** Every start came back: how many started, and which did not. */
  | { type: 'planLevelStartAnswered'; started: number; failed: { issue: IssueKey; reason: string }[] }
  /** The Checks panel asked main for a failing check's log, by the check run's URL. */
  | { type: 'checkLogRequested'; url: string }
  /** Main answered: the log's end, or null when there is none to show. */
  | { type: 'checkLogLoaded'; url: string; text: string | null }
  // What the main area shows (#168); see `main-area-slice`.
  /** A project takes the main area, showing `view`: its page (#173), one of its plans, or its settings. */
  | { type: 'projectOpened'; projectPath: string; view: ProjectView }
  /** Its Close, or Esc: back to the session to return to, or the empty screen. */
  | { type: 'projectClosed' }
  /** The empty screen, asked for outright, whatever had the main area. */
  | { type: 'screenCleared' }
  // Asking Patch on the empty screen (#135); see `ask-slice`.
  /** The user typed in the box. */
  | { type: 'askTextChanged'; text: string }
  /** Enter in the box: what is in it goes to main to be routed. */
  | { type: 'askSent' }
  /** ⌘Enter: a quick session in `quickFolder`, or the picker when it is ''. */
  | { type: 'askQuickSent'; quickFolder: string }
  /** Esc while waiting: main is told to stop, and the box unlocks at once (W2). */
  | { type: 'askCancelled' }
  /** Main answered the send counted as `asked`. */
  | { type: 'askAnswered'; asked: number; result: RouteResult }
  /** ↑/↓ in the choice list (O2). */
  | { type: 'askChoiceStepped'; step: 1 | -1 }
  /** The pointer is over a choice. */
  | { type: 'askChoiceHovered'; index: number }
  /** Enter or a click started a session in a choice. */
  | { type: 'askChoiceStarted' }
  /** Esc in the choice list: back to editing the box. */
  | { type: 'askChoicesClosed' }
  /** Tab in the choice list: the New Session picker takes over, carrying the prompt. */
  | { type: 'askChoicesHandedOff' }
  /** The New Session picker started a session on the prompt it was opened carrying. */
  | { type: 'pickerPromptLaunched' };

export type RendererEvent = PushEvent | LocalEvent | ToolbarEvent | SessionListEvent | ProjectPageEvent | PhoneAccessEvent;

/**
 * A compile-time check that `PushEvent` names every push channel but the
 * terminal stream, and nothing else. Adding a channel to `EVENT` without an
 * event here — or the other way round — fails `npm run typecheck`.
 */
type PushChannel = Exclude<keyof typeof EVENT, 'terminalData'>;
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const pushEventsCoverEveryChannel: Exact<PushEvent['type'], PushChannel> = true;
void pushEventsCoverEveryChannel;
