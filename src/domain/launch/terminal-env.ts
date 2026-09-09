/**
 * The environment a session's process is given.
 *
 * Mostly one claim: that this is a capable, iTerm2-compatible terminal. Claude
 * Code checks TERM_PROGRAM before it emits the OSC 9 notifications Switchboard
 * reads to know when a session needs attention, so without this the packaged
 * app's minimal environment silently loses every status signal.
 */
import { PLAIN_TERMINAL_CLAUDE_SHIM } from './claude-command';

/** What every session gets, on top of the inherited environment. */
const TERMINAL_IDENTITY: Record<string, string> = {
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  TERM_PROGRAM: 'iTerm.app',
  TERM_PROGRAM_VERSION: '3.6.6',
  FORCE_COLOR: '3',
  ITERM_SESSION_ID: '1',
};

/** The environment for a Claude session, plus the IDE bridge's port if any. */
export function claudeSessionEnv(
  baseEnv: Record<string, string>,
  options: { ideBridgePort?: number } = {},
): Record<string, string> {
  const env = { ...baseEnv, ...TERMINAL_IDENTITY };
  if (options.ideBridgePort !== undefined) {
    env.CLAUDE_CODE_SSE_PORT = String(options.ideBridgePort);
  }
  return env;
}

/**
 * The environment for a plain terminal.
 *
 * The `claude` shim is injected through ENV/BASH_ENV, which sh and bash read at
 * startup. zsh reads neither, so the caller also writes the shim into the shell
 * once it is up — a ZDOTDIR override would work for zsh but breaks the user's
 * own configuration, which is the whole point of offering their real shell.
 */
export function plainTerminalEnv(baseEnv: Record<string, string>): Record<string, string> {
  return {
    ...baseEnv,
    ...TERMINAL_IDENTITY,
    CLAUDECODE: '1',
    ENV: PLAIN_TERMINAL_CLAUDE_SHIM,
    BASH_ENV: PLAIN_TERMINAL_CLAUDE_SHIM,
  };
}

/** The environment for a one-shot, non-interactive `claude` run. */
export function headlessEnv(baseEnv: Record<string, string>): Record<string, string> {
  return { ...baseEnv, FORCE_COLOR: '0' };
}
