/**
 * How a session should be launched.
 *
 * Assembled by the renderer from the settings panel and the launch dialogs,
 * read by the main process when it spawns the PTY. Open-ended on purpose: the
 * settings panel can carry flags either side does not know about yet, and only
 * the ones acted on need naming here.
 */

export interface SessionOptions {
  /** 'terminal' for a plain shell; absent or 'claude' for a CLI session. */
  type?: string;
  /** 'shell' or 'claude', for a session on a remote host. */
  remoteKind?: string;
  shell?: string;
  /** The session this one is forked from, while the fork is unresolved. */
  forkFrom?: string;
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
  mcpEmulation?: boolean;
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
  { value: null, label: 'Default', desc: 'Prompt for all actions' },
  { value: 'auto', label: 'Auto', desc: 'Classifier allows routine work, stops for risky actions' },
  { value: 'acceptEdits', label: 'Accept Edits', desc: 'Auto-accept file edits, prompt for others' },
  { value: 'plan', label: 'Plan Mode', desc: 'Read-only exploration, no writes' },
  { value: 'dontAsk', label: "Don't Ask", desc: 'Auto-deny tools not explicitly allowed' },
  { value: 'bypassPermissions', label: 'Bypass', desc: 'Auto-accept all tool calls' },
];
