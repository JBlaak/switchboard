/**
 * Turning a project's settings into the options a launch is made with.
 *
 * A leaf: it reads settings and produces a payload, and nothing about a session
 * or the DOM reaches it. Every launch path goes through it so a project's
 * configured defaults apply whether the session was started from the sidebar,
 * a dialog, a fork or a restored tab.
 */
import type { SessionOptions } from '../../../domain/launch/session-options';

/**
 * The options a session in this project starts with by default.
 *
 * Only settings that are actually set are copied across: an absent key means
 * "let the CLI apply the user's own default", which is not the same as sending
 * the flag with a falsy value.
 */
export async function resolveDefaultSessionOptions(projectPath: string): Promise<SessionOptions> {
  const effective = await window.api.getEffectiveSettings(projectPath);
  const options: SessionOptions = {};

  if (effective.dangerouslySkipPermissions) {
    options.dangerouslySkipPermissions = true;
  } else if (effective.permissionMode) {
    options.permissionMode = effective.permissionMode;
  }

  if (effective.worktree) {
    options.worktree = true;
    if (effective.worktreeName) options.worktreeName = effective.worktreeName;
  }
  if (effective.chrome) options.chrome = true;
  if (effective.preLaunchCmd) options.preLaunchCmd = effective.preLaunchCmd;
  if (effective.addDirs) options.addDirs = effective.addDirs;
  if (effective.mcpEmulation === false) options.mcpEmulation = false;

  return options;
}
