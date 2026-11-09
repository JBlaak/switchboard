/**
 * A project: a directory with sessions in it, local or remote.
 */
import type {SessionRow} from '../session/session';

export interface Project {
    projectPath: string;
    folder: string;
    sessions: SessionRow[];
    /** True for ssh:// projects, whose sessions live on the far host. */
    remote?: boolean;
    /** True for a remote whose host runs a Switchboard agent (#276): shown as VM, not SSH. */
    agent?: boolean;
    /** The slugs of the plans pinned to the top of the session list. */
    pinnedPlans?: string[];
    /** The GitHub plans pinned to the top of the session list from their page. */
    pinnedIssuePlans?: PinnedIssuePlan[];
    /** Epoch ms the project was pinned to the top of the session list, above the pinned plans. */
    pinnedAt?: number;
}

/** A GitHub plan pinned to the top of the session list, by its issue. */
export interface PinnedIssuePlan {
    repository: string;
    number: number;
    /** The plan's title when it was pinned. */
    title: string;
    /** Epoch ms. */
    pinnedAt: number;
}
