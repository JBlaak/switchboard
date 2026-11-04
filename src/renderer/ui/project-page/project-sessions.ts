/**
 * The project page's Sessions section (#173), decided from the cached projects
 * alone: which of a repository's sessions it lists, and in what order.
 *
 * A repository's sessions are its own and those of its worktrees under
 * `.claude/worktrees`, which the cache keeps as projects of their own. Kept
 * free of the store and the DOM, so it is tested in node.
 */
import {repositoryRoot, worktreeName} from '../../features/sessions/project-label';
import type {Project} from '../../../domain/project/project';
import type {SessionRow} from '../../../domain/session/session';

/** How many sessions the section lists; Show all filters the sidebar for the rest. */
export const SESSIONS_SHOWN = 5;

export interface ProjectSessionLine {
    readonly session: SessionRow;
    readonly running: boolean;
    /** The worktree it runs in, which names its branch; null in the repository itself. */
    readonly worktree: string | null;
}

export interface ProjectSessions {
    readonly lines: readonly ProjectSessionLine[];
    /** Every session the repository has, listed or not. */
    readonly total: number;
}

/** The projects that make up `repository`: itself and its worktrees, as far as the cache knows them. */
export function repositoryProjects(projects: readonly Project[], repository: string): Project[] {
    return projects.filter((p) => repositoryRoot(p.projectPath) === repository);
}

/**
 * The repository's most recent sessions, running ones first, then the most
 * recently active; `limit` of them.
 */
export function projectSessions(
    projects: readonly Project[],
    repository: string,
    running: ReadonlySet<string>,
    limit = SESSIONS_SHOWN,
): ProjectSessions {
    const all: ProjectSessionLine[] = [];
    for (const project of repositoryProjects(projects, repository)) {
        const worktree = worktreeName(project.projectPath);
        for (const session of project.sessions) {
            all.push({session, running: running.has(session.sessionId), worktree});
        }
    }
    all.sort((a, b) => Number(b.running) - Number(a.running) || modifiedAt(b.session) - modifiedAt(a.session));
    return {lines: all.slice(0, limit), total: all.length};
}

function modifiedAt(session: SessionRow): number {
    const at = Date.parse(session.modified);
    return Number.isNaN(at) ? 0 : at;
}

/**
 * The session that owns one of `numbers` (a PR, or a stack's members) in
 * `repository` (`owner/repo`), as far as the cache knows: the newest
 * unarchived one among the repository's sessions whose transcript linked it
 * (#315, the merge queue's head). Null when none did.
 */
export function pullRequestSession(
    projects: readonly Project[],
    repositoryPath: string,
    repository: string,
    numbers: readonly number[],
): SessionRow | null {
    const owners = repositoryProjects(projects, repositoryPath)
        .flatMap((project) => project.sessions)
        .filter(
            (session) =>
                !session.archived &&
                (session.pullRequests ?? []).some(
                    (pr) => numbers.includes(pr.number) && (pr.repository === '' || pr.repository === repository),
                ),
        );
    owners.sort((a, b) => modifiedAt(b) - modifiedAt(a));
    return owners[0] ?? null;
}
