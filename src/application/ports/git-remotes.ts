/**
 * Where a project's code lives online.
 */
export interface GitRemotes {
  /** The `origin` remote of the repository at this path, or null if it has none. */
  originUrl(projectPath: string): Promise<string | null>;
}
