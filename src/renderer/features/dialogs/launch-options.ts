/**
 * Turning a project's settings into the options a launch is made with.
 *
 * A leaf: it reads settings and produces a payload, and nothing about a session
 * or the DOM reaches it. Every launch path goes through it so a project's
 * configured defaults apply whether the session was started from the sidebar,
 * a dialog or a restored tab.
 */
import { defaultSessionOptions } from '../../../domain/launch/session-options';
import type { SessionOptions } from '../../../domain/launch/session-options';

/** The options a session in this project starts with by default (`defaultSessionOptions`). */
export async function resolveDefaultSessionOptions(projectPath: string): Promise<SessionOptions> {
  return defaultSessionOptions(await window.api.getEffectiveSettings(projectPath));
}
