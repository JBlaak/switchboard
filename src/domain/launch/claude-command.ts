/**
 * The command line a Claude session is started with.
 *
 * Built as an argv and quoted once at the end, so nothing the user typed — a
 * worktree name, an extra directory, a system prompt — can be read as shell
 * syntax. The one deliberate exception is `preLaunchCmd`, which is raw shell by
 * design ("aws-vault exec profile --") and is only checked for the newline that
 * would let it smuggle in a second command.
 */
import { quoteArgvForShell } from '../shell/quoting';
import type { SessionOptions } from './session-options';

/** Which session the CLI should attach to, and how. */
export interface SessionTarget {
  sessionId: string;
  /** A session being started rather than resumed. */
  isNew: boolean;
}

/** Raised when a launch option cannot be made safe. */
export class UnsafeLaunchOptionError extends Error {}

/**
 * The `claude` argv for this launch.
 *
 * `--worktree` only applies when STARTING a session — it creates a fresh
 * isolated git worktree. Resuming must reuse the session's existing directory,
 * so the worktree options are ignored on resume regardless of which call site
 * supplied them (sidebar click, schedule creator, fork, …). Otherwise a resume
 * tries to spin up a new worktree and fails to attach.
 */
export function buildClaudeArgs(target: SessionTarget, options?: SessionOptions): string[] {
  const args: string[] = [];

  if (options?.forkFrom) {
    args.push('--resume', String(options.forkFrom), '--fork-session');
  } else if (target.isNew) {
    args.push('--session-id', String(target.sessionId));
  } else {
    args.push('--resume', String(target.sessionId));
  }

  if (!options) return args;

  if (options.dangerouslySkipPermissions) {
    args.push('--dangerously-skip-permissions');
  } else if (options.permissionMode) {
    args.push('--permission-mode', String(options.permissionMode));
  }

  if (target.isNew && options.worktree) {
    args.push('--worktree');
    if (options.worktreeName) args.push(String(options.worktreeName));
  }

  if (options.chrome) args.push('--chrome');

  if (options.addDirs) {
    for (const dir of String(options.addDirs).split(',').map(d => d.trim()).filter(Boolean)) {
      args.push('--add-dir', dir);
    }
  }

  if (options.appendSystemPrompt) {
    args.push('--append-system-prompt', String(options.appendSystemPrompt));
  }

  return args;
}

/** Everything that shapes the final command string. */
export interface ClaudeCommandSpec {
  shellPath: string;
  target: SessionTarget;
  options?: SessionOptions;
  /** True once an MCP sidecar is listening, which is what `--ide` connects to. */
  ideBridge?: boolean;
}

/**
 * The full shell command that starts a Claude session.
 *
 * @throws UnsafeLaunchOptionError when `preLaunchCmd` spans more than one line.
 */
export function buildClaudeCommand({ shellPath, target, options, ideBridge }: ClaudeCommandSpec): string {
  let command = 'claude ' + quoteArgvForShell(shellPath, buildClaudeArgs(target, options));
  if (ideBridge) command += ' --ide';

  if (options?.preLaunchCmd) {
    const pre = String(options.preLaunchCmd);
    if (/[\r\n]/.test(pre)) {
      throw new UnsafeLaunchOptionError('preLaunchCmd must not contain newlines');
    }
    command = pre + ' ' + command;
  }

  return command;
}

/**
 * A shell function that overrides `claude` in a plain terminal.
 *
 * A plain terminal is deliberately not a Claude session — starting one there
 * would give it no MCP bridge, no session tracking and no row in the sidebar —
 * so the name is shadowed with an explanation instead of failing obscurely.
 */
export const PLAIN_TERMINAL_CLAUDE_SHIM =
  'claude() { echo "\\033[33mTo start a Claude session, use the + button in the sidebar.\\033[0m"; return 1; }; export -f claude 2>/dev/null;';
