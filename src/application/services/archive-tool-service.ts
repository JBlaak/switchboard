/**
 * A session archiving itself, through Switchboard's `archive_session` tool.
 *
 * The call only asks: the session is archived when its turn ends (the Stop
 * hook), so it can still say what it did, and an archive aimed at a turn that
 * never ends simply never happens. The request is held on the running session
 * itself, so it follows the session through a re-key and goes with it.
 */
import {
    ARCHIVE_TOOL_QUALIFIED_NAME,
    archiveToolMcpConfig,
    type ArchiveToolOutcome,
} from '../../domain/session/archive-tool';
import {PAGE_TOOL_QUALIFIED_NAME} from '../../domain/session/page-tool';
import {QUESTION_HOOK_TOKEN_HEADER} from '../../domain/questions/question';
import type {ActiveSession} from '../model/active-session';
import type {SessionRegistry} from '../model/session-registry';
import type {Logger} from '../ports/logger';
import type {QuestionHookEndpoint} from '../ports/question-hook';

/** What a launch adds to give a session the tool. */
export interface ArchiveToolLaunch {
    mcpConfig: string;
    /** Pre-approved, so asking for the archive or showing a page doesn't stop on a permission prompt. */
    allowedTools: string[];
}

export interface ArchiveToolServiceDeps {
    registry: SessionRegistry;
    /** The loopback server the tool is served from, shared with the question hook. */
    endpoint: QuestionHookEndpoint;
    /** Archives a session as the phone's archive does: stopped, row archived, window told. */
    archiver: {archive(sessionId: string): {ok: boolean}};
    log: Logger;
}

export class ArchiveToolService {
    private readonly requested = new WeakSet<ActiveSession>();
    /** Others that hear every turn end (the merge queue's errands, for "Needs you"). */
    private readonly turnFollowers: Array<(sessionIds: string[], archiving: boolean, currentId: string) => void> = [];

    constructor(private readonly deps: ArchiveToolServiceDeps) {}

    /**
     * Hear each turn end of a running session: every id it has gone by,
     * whether it asked to be archived (it is archived right after), and the id
     * it goes by now, the one it is archived under.
     */
    public onTurnEnded(fn: (sessionIds: string[], archiving: boolean, currentId: string) => void): void {
        this.turnFollowers.push(fn);
    }

    /** Has the running session asked to be archived when its turn ends? */
    public hasRequested(sessionId: string): boolean {
        const found = this.deps.registry.find(sessionId);
        return found !== null && this.requested.has(found.session);
    }

    /** The tool for a session launched as `sessionId`, or null while the server is not listening. */
    public launchFor(sessionId: string): ArchiveToolLaunch | null {
        const {url, token} = this.deps.endpoint;
        if (!url) return null;
        return {
            mcpConfig: archiveToolMcpConfig(`${url}/mcp/${encodeURIComponent(sessionId)}`, {
                [QUESTION_HOOK_TOKEN_HEADER]: token,
            }),
            // The Mac's server offers `show_page` beside the archive (composition root).
            allowedTools: [ARCHIVE_TOOL_QUALIFIED_NAME, PAGE_TOOL_QUALIFIED_NAME],
        };
    }

    /** The session launched as `launchId` called the tool. */
    public request(launchId: string): ArchiveToolOutcome {
        const found = this.deps.registry.find(launchId);
        if (!found)
            return {ok: false, message: 'Switchboard has no running session by this id, so nothing was archived.'};
        this.requested.add(found.session);
        this.deps.log.info(`[archive-tool] session=${currentId(found.session, found.key)} asked to be archived`);
        return {
            ok: true,
            message: 'This session will be archived in Switchboard as soon as this turn ends. Finish your reply now.',
        };
    }

    /** A turn of the session launched as `launchId` ended: archive it, if it asked. */
    public turnEnded(launchId: string): void {
        const found = this.deps.registry.find(launchId);
        if (!found) return;
        const archiving = this.requested.has(found.session);
        const ids = sessionIds(launchId, found.session, found.key);
        const current = currentId(found.session, found.key);
        for (const fn of this.turnFollowers) {
            try {
                fn(ids, archiving, current);
            } catch (err) {
                this.deps.log.error('[archive-tool] a turn follower failed:', (err as Error).message);
            }
        }
        if (!archiving) return;
        this.requested.delete(found.session);
        const sessionId = current;
        const {ok} = this.deps.archiver.archive(sessionId);
        this.deps.log.info(
            `[archive-tool] session=${sessionId} ${ok ? 'archived' : 'could not be stopped; left as it is'}`,
        );
    }
}

/** Every id the session has gone by: the one it was launched as, the one it is keyed by, and those between. */
function sessionIds(launchId: string, session: ActiveSession, key: string): string[] {
    const ids = new Set([launchId, key]);
    if (session.realSessionId) ids.add(session.realSessionId);
    for (const prior of session.priorIds ?? []) ids.add(prior);
    return [...ids];
}

function currentId(session: ActiveSession, key: string): string {
    return session.realSessionId || key;
}
