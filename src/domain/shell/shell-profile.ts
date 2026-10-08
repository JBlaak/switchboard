/** A shell the user can launch a session in. */
export interface ShellProfile {
  id: string;
  name: string;
  /** Absolute path. */
  path: string;
}
