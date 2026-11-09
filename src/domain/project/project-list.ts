/**
 * Assembling the sidebar's project list.
 *
 * Four different things become a project row — cached transcripts, project
 * directories with nothing in them yet, plain terminals that only exist in
 * memory, and remote projects that only exist in settings — and they all have
 * to end up in one list ordered the same way. The rules for that are pure: the
 * caller reads the four sources and hands them over.
 */
import {encodeProjectPath} from './project-path';
import {remoteProjectPath} from './remote-target';
import {byMostRecentlyModified, toSessionRow} from '../session/session';
import type {PinnedIssuePlan, Project} from './project';
import type {CachedSession, SessionMeta, SessionRow} from '../session/session';
import type {RemoteProjectSetting} from '../settings/settings';

/** A plan pinned to the top of the session list: the slug its sessions share, in one project. */
export interface PlanPin {
    projectPath: string;
    slug: string;
}

/** A GitHub plan pinned to the top of the session list from its page, in one project. */
export interface IssuePlanPin extends PinnedIssuePlan {
    projectPath: string;
}

/** A project pinned to the top of the session list from its page. */
export interface ProjectPin {
    projectPath: string;
    /** Epoch ms. */
    pinnedAt: number;
}

/** A plain terminal, which has no transcript and lives only while it runs. */
export interface ActiveTerminalRow {
    sessionId: string;
    projectPath: string;
    /** Epoch ms — a terminal's only timestamp is when it was opened. */
    openedAt: number;
}

export interface ProjectListInputs {
    /** Every cached transcript row. */
    cached: readonly CachedSession[];
    /** sessionId → the user's own state for it. */
    meta: ReadonlyMap<string, SessionMeta>;
    /** Projects the user removed from the sidebar. */
    hiddenProjects: ReadonlySet<string>;
    /**
     * Project directories the indexer knows about, so a project with no sessions
     * yet still gets a row to launch the first one from.
     */
    knownProjectPaths: Iterable<string>;
    activeTerminals: Iterable<ActiveTerminalRow>;
    remoteProjects: Iterable<RemoteProjectSetting>;
    pinnedPlans: Iterable<PlanPin>;
    pinnedIssuePlans: Iterable<IssuePlanPin>;
    /** Optional so callers that never pin projects need not say so. */
    pinnedProjects?: Iterable<ProjectPin>;
    showArchived: boolean;
    /**
     * sessionId → a VM session's transcript as last fetched from its host
     * (#276 stage 3). A VM Claude row takes its title, first prompt, PR links
     * and activity from it; without an entry it stays "Remote Claude".
     */
    vmTranscripts?: ReadonlyMap<string, CachedSession>;
    /**
     * Sessions handed off to a VM, by id. Their transcript on the Mac stays on
     * disk, but their local row is left out: the VM row stands for them, so one
     * conversation has one row.
     */
    handedOffSessions?: ReadonlySet<string>;
}

/** A row for a session that exists only in memory. */
function syntheticRow(
    fields: Partial<SessionRow> & Pick<SessionRow, 'sessionId' | 'projectPath' | 'summary' | 'created' | 'modified'>,
): SessionRow {
    return {
        firstPrompt: '',
        name: null,
        starred: 0,
        archived: 0,
        messageCount: 0,
        ...fields,
    };
}

/**
 * What a VM Claude row takes from its transcript (#276 stage 3): what a local
 * row takes from its cache row. Its activity is whichever is later, the last
 * message or the last time the Mac opened it, so opening a quiet session
 * still brings it to the top as it did before there was a transcript.
 */
function fromVmTranscript(transcript: CachedSession, opened: string): Partial<SessionRow> {
    const modified =
        new Date(transcript.modified).getTime() > new Date(opened).getTime() ? transcript.modified : opened;
    return {
        summary: transcript.summary,
        firstPrompt: transcript.firstPrompt,
        modified,
        messageCount: transcript.messageCount,
        slug: transcript.slug || null,
        aiTitle: transcript.aiTitle || null,
        pullRequests: transcript.pullRequests ?? [],
    };
}

/**
 * Group cached rows, directories, terminals and remotes into one ordered list.
 *
 * Grouping is by projectPath, not by on-disk folder name. Multiple transcript
 * directories can resolve to the same projectPath — Claude Code's folder-naming
 * scheme has changed over time, leaving legacy stragglers around — so they merge
 * into a single sidebar group, which is also what avoids duplicate-id collisions
 * in the incremental render.
 */
export function buildProjectList(inputs: ProjectListInputs): Project[] {
    const projects = new Map<string, Project>();

    const upsert = (projectPath: string): Project | null => {
        if (inputs.hiddenProjects.has(projectPath)) return null;
        let project = projects.get(projectPath);
        if (!project) {
            project = {folder: encodeProjectPath(projectPath), projectPath, sessions: []};
            projects.set(projectPath, project);
        }
        return project;
    };

    // Cached transcripts. A project is only created once it has a session that
    // survives the archive filter — otherwise a folder whose sessions are all
    // archived would appear as an undismissable phantom entry.
    for (const row of inputs.cached) {
        if (!row.projectPath) continue;
        if (inputs.hiddenProjects.has(row.projectPath)) continue;
        if (inputs.handedOffSessions?.has(row.sessionId)) continue;
        const session = toSessionRow(row, inputs.meta.get(row.sessionId));
        if (!inputs.showArchived && session.archived) continue;
        upsert(row.projectPath)?.sessions.push(session);
    }

    // Project directories with no sessions yet.
    for (const projectPath of inputs.knownProjectPaths) {
        if (projectPath) upsert(projectPath);
    }

    // Plain terminals, so they participate in the same ordering as everything else.
    for (const terminal of inputs.activeTerminals) {
        if (!terminal.projectPath) continue;
        const project = upsert(terminal.projectPath);
        if (!project) continue;
        if (project.sessions.some((s) => s.sessionId === terminal.sessionId)) continue;
        const at = new Date(terminal.openedAt).toISOString();
        project.sessions.push(
            syntheticRow({
                sessionId: terminal.sessionId,
                projectPath: terminal.projectPath,
                summary: 'Terminal',
                created: at,
                modified: at,
                type: 'terminal',
            }),
        );
    }

    // Remote projects, which are stored in settings rather than derived from
    // transcripts. Their session history lives on the remote host; locally we
    // only track the tmux sessions we created so they can be listed and
    // re-attached. Star/rename/archive still work, keyed by sessionId alone.
    for (const remote of inputs.remoteProjects) {
        const projectPath = remoteProjectPath(remote);
        const project = upsert(projectPath);
        if (!project) continue;
        project.remote = true;
        // A host with a Switchboard agent (#276) is a VM: its badge says so.
        if (remote.agent) project.agent = true;
        for (const record of remote.sessions || []) {
            const meta = inputs.meta.get(record.sessionId);
            if (!inputs.showArchived && meta?.archived) continue;
            const opened = record.lastOpened || record.created;
            const transcript = record.kind === 'shell' ? undefined : inputs.vmTranscripts?.get(record.sessionId);
            project.sessions.push(
                syntheticRow({
                    sessionId: record.sessionId,
                    projectPath,
                    summary: record.kind === 'shell' ? 'Remote terminal' : 'Remote Claude',
                    created: record.created,
                    modified: opened,
                    ...(transcript ? fromVmTranscript(transcript, opened) : {}),
                    name: meta?.name || null,
                    starred: meta?.starred || 0,
                    archived: meta?.archived || 0,
                    snoozedUntil: meta?.snoozedUntil || null,
                    type: 'remote',
                    remoteKind: record.kind,
                }),
            );
        }
    }

    // A pin on a project that has no row (hidden, or nothing left in it) has
    // nowhere to show, and stays stored for when it does.
    for (const pin of inputs.pinnedPlans) {
        const project = projects.get(pin.projectPath);
        if (project) (project.pinnedPlans ??= []).push(pin.slug);
    }
    for (const {projectPath, ...pin} of inputs.pinnedIssuePlans) {
        const project = projects.get(projectPath);
        if (project) (project.pinnedIssuePlans ??= []).push(pin);
    }
    for (const {projectPath, pinnedAt} of inputs.pinnedProjects ?? []) {
        const project = projects.get(projectPath);
        if (project) project.pinnedAt = pinnedAt;
    }

    const list = [...projects.values()];
    for (const project of list) project.sessions.sort(byMostRecentlyModified);
    list.sort(compareProjects);
    return list;
}

/** Most recent activity first, with projects that have nothing in them last. */
function compareProjects(a: Project, b: Project): number {
    if (a.sessions.length === 0 && b.sessions.length > 0) return 1;
    if (b.sessions.length === 0 && a.sessions.length > 0) return -1;
    const aDate = a.sessions[0]?.modified || '';
    const bDate = b.sessions[0]?.modified || '';
    return new Date(bDate).getTime() - new Date(aDate).getTime();
}
