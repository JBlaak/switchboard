/**
 * The workspace actions' public shape (#342): open a session's working
 * directory in its IDE, in Finder, or in a shell.
 *
 * Shared by main and the renderer (the tray, #343). Every action names its
 * folder by session or directly, and answers with what opened it or why it
 * could not: a remote (ssh/VM) session's folder is not on this Mac, so its
 * actions answer `available: false` / `ok: false` with `NOT_AVAILABLE_REMOTE`,
 * and the tray disables them.
 */
import type {Editor} from './editor';

export type {Editor} from './editor';

/**
 * Which folder an action is for: a session's working directory (the worktree
 * it last worked in, else the directory it started in), or a local directory.
 */
export type WorkspaceTarget = {sessionId: string} | {directory: string};

/** The IDE the Editor action would open a folder in, for the tray's label. */
export type WorkspaceEditorInfo =
    | {
          available: true;
          /** The folder the actions open. */
          directory: string;
          editor: Editor;
          /** The app's name, e.g. "PhpStorm": the button's label. */
          app: string;
      }
    | {available: false; reason: string};

/** What came of an action. */
export type WorkspaceActionResult =
    | {
          ok: true;
          /** The folder that was opened. */
          directory: string;
          /** The app that opened it: "PhpStorm", "Sublime Text", "Finder", "iTerm", "Terminal". */
          openedWith: string;
      }
    | {ok: false; reason: string};

/** Why a remote session's actions are unavailable. */
export const NOT_AVAILABLE_REMOTE = 'Not available for a remote session';

/** Why an action for an unknown session cannot run. */
export const NO_SESSION = 'No session goes by that id';

/** Why an action for a folder that is not on this Mac (any more) cannot run. */
export const NO_FOLDER = 'The folder is not there';

/** Why an action failed when nothing would open the folder. */
export const NOTHING_OPENED = 'Nothing would open the folder';
