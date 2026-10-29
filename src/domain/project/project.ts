/**
 * A project: a directory with sessions in it, local or remote.
 */
import type { SessionRow } from '../session/session';

export interface Project {
  projectPath: string;
  folder: string;
  sessions: SessionRow[];
  /** True for ssh:// projects, whose sessions live on the far host. */
  remote?: boolean;
  /** The slugs of the plans pinned to the top of the session list. */
  pinnedPlans?: string[];
}
