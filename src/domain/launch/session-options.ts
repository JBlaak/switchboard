/**
 * How a session should be launched.
 *
 * Assembled by the renderer from the settings panel and the launch dialogs,
 * read by the main process when it spawns the PTY. Open-ended on purpose: the
 * settings panel can carry flags either side does not know about yet, and only
 * the ones acted on need naming here.
 */

import type { EffectiveSettings } from '../settings/settings';

export interface SessionOptions {
  /** 'terminal' for a plain shell; absent or 'claude' for a CLI session. */
  type?: string;
  /** 'shell' or 'claude', for a session on a remote host. */
  remoteKind?: string;
  shell?: string;
  dangerouslySkipPermissions?: boolean;
  permissionMode?: string | null;
  worktree?: boolean;
  worktreeName?: string;
  chrome?: boolean;
  /** Raw shell prefix, e.g. "aws-vault exec profile --". */
  preLaunchCmd?: string;
  /** Comma-separated extra directories for `--add-dir`. */
  addDirs?: string;
  appendSystemPrompt?: string;
  /**
   * The first prompt a new session starts on, handed to the CLI as its
   * positional prompt. Ignored on resume. Never a stored setting: the launch
   * that asks for it is the only one it applies to.
   */
  initialPrompt?: string;
  [key: string]: unknown;
}

/**
 * Permission modes offered for a session, in the order they're shown.
 *
 * `value` is passed verbatim to `claude --permission-mode`, so each one must
 * stay a member of that flag's choice list (as of CLI 2.1.220: acceptEdits,
 * auto, bypassPermissions, manual, dontAsk, plan). A `null` value means the flag
 * is omitted entirely and the CLI applies the user's own configured default.
 *
 * Shared by both session dialogs and the settings panel — the list used to be
 * copy-pasted in all three, so a new mode reached only whichever copy someone
 * remembered to edit.
 */
export const PERMISSION_MODES = [
  { value: null, label: 'Default', desc: 'Whatever your own Claude settings say' },
  { value: 'auto', label: 'Auto', desc: 'Classifier allows routine work, stops for risky actions' },
  { value: 'acceptEdits', label: 'Accept Edits', desc: 'Auto-accept file edits, prompt for others' },
  { value: 'plan', label: 'Plan Mode', desc: 'Read-only exploration, no writes' },
  { value: 'dontAsk', label: "Don't Ask", desc: 'Auto-deny tools not explicitly allowed' },
  { value: 'bypassPermissions', label: 'Bypass', desc: 'Auto-accept all tool calls' },
];

/**
 * The options a session in a project starts with by default, from that
 * project's effective settings. Every launch path goes through it, the
 * renderer's and a phone's (#194), so a project's configured defaults apply
 * wherever the session was started from.
 *
 * Only settings that are actually set are copied across: an absent key means
 * "let the CLI apply the user's own default", which is not the same as sending
 * the flag with a falsy value.
 */
export function defaultSessionOptions(effective: EffectiveSettings): SessionOptions {
  const options: SessionOptions = {};

  if (effective.dangerouslySkipPermissions) {
    options.dangerouslySkipPermissions = true;
  } else if (effective.permissionMode) {
    options.permissionMode = effective.permissionMode;
  }

  // A stored `worktreeName` is ignored: one fixed name put every new session in
  // the same worktree, so the CLI names each one instead.
  if (effective.worktree) options.worktree = true;
  if (effective.chrome) options.chrome = true;
  if (effective.preLaunchCmd) options.preLaunchCmd = effective.preLaunchCmd;
  if (effective.addDirs) options.addDirs = effective.addDirs;

  return options;
}
