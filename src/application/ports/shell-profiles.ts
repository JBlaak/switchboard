/**
 * Which shells this machine has, and which one to launch in.
 *
 * Discovery reads the system's shell list and falls back to guesses when it
 * cannot, so it lives behind a port and the launch path only asks for a
 * resolved profile.
 */
import type { ShellProfile } from '../../domain/shell/shell-profile';

export interface ShellProfileProvider {
  /** Every profile the user can choose, discovered once per launch. */
  list(): ShellProfile[];
  /**
   * The profile for an id, falling back to auto-detection.
   *
   * Always answers with something runnable: an id that no longer resolves (a
   * shell the user uninstalled) falls back rather than failing the launch.
   */
  resolve(profileId?: string | null): ShellProfile;
}
