/**
 * Assembling the sidebar's project list.
 *
 * Four different things become a project row — cached transcripts, project
 * directories with nothing in them yet, plain terminals that only exist in
 * memory, and remote projects that only exist in settings — and they all have
 * to end up in one list ordered the same way. The rules for that are pure: the
 * caller reads the four sources and hands them over.
 */
import { encodeProjectPath } from './project-path';
import { remoteProjectPath } from './remote-target';
import { byMostRecentlyModified, toSessionRow } from '../session/session';
import type { Project } from './project';
import type { CachedSession, SessionMeta, SessionRow } from '../session/session';
import type { RemoteProjectSetting } from '../settings/settings';

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
  showArchived: boolean;
}

/** A row for a session that exists only in memory. */
function syntheticRow(fields: Partial<SessionRow> & Pick<SessionRow, 'sessionId' | 'projectPath' | 'summary' | 'created' | 'modified'>): SessionRow {
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
      project = { folder: encodeProjectPath(projectPath), projectPath, sessions: [] };
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
    if (project.sessions.some(s => s.sessionId === terminal.sessionId)) continue;
    const at = new Date(terminal.openedAt).toISOString();
    project.sessions.push(syntheticRow({
      sessionId: terminal.sessionId,
      projectPath: terminal.projectPath,
      summary: 'Terminal',
      created: at,
      modified: at,
      type: 'terminal',
    }));
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
    for (const record of remote.sessions || []) {
      const meta = inputs.meta.get(record.sessionId);
      if (!inputs.showArchived && meta?.archived) continue;
      project.sessions.push(syntheticRow({
        sessionId: record.sessionId,
        projectPath,
        summary: record.kind === 'shell' ? 'Remote terminal' : 'Remote Claude',
        created: record.created,
        modified: record.lastOpened || record.created,
        name: meta?.name || null,
        starred: meta?.starred || 0,
        archived: meta?.archived || 0,
        type: 'remote',
        remoteKind: record.kind,
      }));
    }
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
