/**
 * A small stand-in for main's projects, settings and sessions, for the specs
 * whose tests change them: add or hide a project, archive its sessions, start
 * one and see it running, launch with a project's settings.
 *
 * It answers the way the real handlers do (src/main/ipc/project-handlers.ts,
 * settings-handlers.ts, the PTY's `openTerminal`), from state the test can
 * read back: what was added, hidden, archived and started.
 *
 * ```ts
 * import {test, expect} from '../support/main-world';
 *
 * test('hides it', async ({page, world}) => {
 *   …
 *   expect(world.projectPaths()).not.toContain(path);
 * });
 * ```
 */
import {test as base, expect} from './test';
import type {FakeApi} from './fake-api';
import type {Answers} from './default-answers';
import type {CapturedFixture} from '../fixtures/captured';
import type {Project} from '../../src/domain/project/project';
import type {SessionRow} from '../../src/domain/session/session';
import {encodeProjectPath} from '../../src/domain/project/project-path';
import {completePath, completionTarget} from '../../src/domain/project/folder-check';
import type {ProjectFolderCheck} from '../../src/domain/project/folder-check';
import {normalizeRemoteDir, remoteProjectPath, validateRemoteInput} from '../../src/domain/project/remote-target';
import {mergeEffectiveSettings, projectSettingsKey} from '../../src/domain/settings/settings';
import {parseSavedPrompts, SAVED_PROMPTS_SETTING} from '../../src/domain/settings/saved-prompts';
import {DEFAULT_TRENDING} from '../../src/domain/bugsnag/connection';
import {FIXTURE_HOME} from '../fixtures/captured';

/** One `openTerminal` the renderer asked for. */
export interface Launch {
    sessionId: string;
    projectPath: string;
    isNew: boolean;
    options: Record<string, unknown>;
}

export class MainWorld {
    /** Every project, archived sessions included: `getProjects(true)`. */
    public projects: Project[];
    /** The sessions with a live process, as `getActiveSessions` answers. */
    public readonly active = new Set<string>();
    /** The folders on disk, for adding a project and the modal's inline check. */
    public readonly folders = new Set<string>();
    /** What `stopSession` answers; main's `{ok: true}` unless a test says otherwise. */
    public stopResult: {ok: boolean; error?: string} = {ok: true};

    constructor(
        private readonly api: FakeApi,
        fixture: CapturedFixture | null,
    ) {
        this.projects = structuredClone(fixture?.projectsWithArchived ?? []);
        for (const project of this.projects) if (!project.remote) this.folders.add(project.projectPath);
    }

    /** Every launch the renderer asked main for, in order. */
    public launches(): Launch[] {
        return this.api.callsTo('openTerminal').map(([sessionId, projectPath, isNew, options]) => ({
            sessionId,
            projectPath,
            isNew,
            options: {...(options ?? {})},
        }));
    }

    public projectPaths(): string[] {
        return this.projects.map((project) => project.projectPath);
    }

    public project(projectPath: string): Project | undefined {
        return this.projects.find((project) => project.projectPath === projectPath);
    }

    /** Main's answers, put on `api`. */
    public install(): void {
        const api = this.api;
        // What the real handlers answer on a machine with no git, no VM and nothing detected.
        for (const [name, answer] of Object.entries(QUIET_MAIN)) {
            api.handle(name as never, (() => structuredClone(answer)) as never);
        }
        api.handle('projectOverview', (projectPath) => ({
            projectPath,
            remote: projectPath.startsWith('ssh://'),
            repository: null,
            github: null,
            worktrees: [],
            running:
                this.projects
                    .find((project) => project.projectPath === projectPath)
                    ?.sessions.filter((session) => this.active.has(session.sessionId))
                    .map((session) => session.sessionId) ?? [],
        }));
        api.handle('getProjects', (showArchived) =>
            structuredClone(
                showArchived
                    ? this.projects
                    : this.projects.map((project) => ({
                          ...project,
                          sessions: project.sessions.filter((session) => !session.archived),
                      })),
            ),
        );
        api.handle('getActiveSessions', () => [...this.active]);
        api.handle('openTerminal', (sessionId) => {
            this.active.add(sessionId);
            return {ok: true, reattached: false};
        });
        api.handle('stopSession', (sessionId) => {
            if (this.stopResult.ok) this.active.delete(sessionId);
            return this.stopResult;
        });
        api.handle('archiveSession', (sessionId, archived) => {
            for (const project of this.projects) {
                for (const session of project.sessions) {
                    if (session.sessionId === sessionId) session.archived = archived ? 1 : 0;
                }
            }
            return {archived: archived ? 1 : 0};
        });
        api.handle('getEffectiveSettings', (projectPath) =>
            mergeEffectiveSettings(
                this.blob('global'),
                projectPath ? this.blob(projectSettingsKey(projectPath)) : null,
            ),
        );
        api.handle('savedPrompts', (projectPath) => ({
            global: parseSavedPrompts(this.blob('global')[SAVED_PROMPTS_SETTING]),
            project: projectPath
                ? parseSavedPrompts(this.blob(projectSettingsKey(projectPath))[SAVED_PROMPTS_SETTING])
                : [],
        }));
        api.handle('setSavedPrompts', (projectPath, prompts) => {
            const list = parseSavedPrompts(prompts);
            const key = projectPath ? projectSettingsKey(projectPath) : 'global';
            const blob = {...this.blob(key)};
            if (list.length > 0 || !projectPath) blob[SAVED_PROMPTS_SETTING] = list;
            else delete blob[SAVED_PROMPTS_SETTING];
            api.settings[key] = blob;
            return list;
        });
        api.handle('checkProjectFolder', (typed) => this.check(typed));
        api.handle('addProject', (typed) => {
            const projectPath = expandHome(String(typed).trim()).replace(/(.)\/+$/, '$1');
            if (!this.folders.has(projectPath)) return {error: 'Path does not exist'};
            if (!this.project(projectPath)) {
                this.projects.push({projectPath, folder: encodeProjectPath(projectPath), sessions: []});
            }
            return {ok: true, folder: encodeProjectPath(projectPath), projectPath};
        });
        api.handle('removeProject', (projectPath) => {
            this.projects = this.projects.filter((project) => project.projectPath !== projectPath);
            delete api.settings[projectSettingsKey(projectPath)];
            return {ok: true};
        });
        api.handle('addRemoteProject', (config) => {
            const error = validateRemoteInput(config ?? {});
            if (error) return {error};
            const projectPath = remoteProjectPath({
                user: config.user,
                host: config.host,
                port: Number(config.port) || 22,
                dir: normalizeRemoteDir(config.dir) ?? '',
            });
            if (this.project(projectPath)) return {error: 'This remote is already added.'};
            this.projects.push({projectPath, folder: encodeProjectPath(projectPath), sessions: [], remote: true});
            return {ok: true, projectPath};
        });
        api.handle('removeRemoteProject', (projectPath) => {
            this.projects = this.projects.filter((project) => project.projectPath !== projectPath);
            return {ok: true};
        });
    }

    /** A settings blob as stored, or an empty one. */
    public blob(key: string): Record<string, unknown> {
        return (this.api.settings[key] as Record<string, unknown> | undefined) ?? {};
    }

    /** `app.projectFolders.check`, over `folders`. */
    private check(typed: string): ProjectFolderCheck {
        const path = expandHome(typed);
        const exists = this.folders.has(path.replace(/(.)\/+$/, '$1'));
        const target = completionTarget(typed);
        let completion: string | null = null;
        if (target) {
            const parent = expandHome(target.folder).replace(/(.)\/+$/, '$1');
            const names = [...this.folders]
                .filter((folder) => folder.startsWith(parent + '/'))
                .map((folder) => folder.slice(parent.length + 1).split('/')[0]);
            completion = completePath(typed, [...new Set(names)]);
        }
        return {path, exists, directory: exists, git: false, branch: null, gitHubRepository: null, completion};
    }
}

/** The answers that need no state: what main says when there is nothing to find. */
const QUIET_MAIN: Answers = {
    handoffHosts: [],
    projectCopies: [],
    copyOrigin: null,
    schedulesWhere: null,
    canOpenSessionWork: false,
    rendererReady: undefined,
    resizeTerminal: undefined,
    getShellProfiles: [],
    quickAskHotkeyStatus: {registered: true, missing: []},
    getSessionLinks: [],
    getSessionStats: {contextUsed: null, messageCount: null, startedAt: null, branch: null, shell: null},
    workspaceEditor: {available: false, reason: 'No editor in the component harness'},
    issueSessions: {},
    projectTasks: [],
    sessionTasks: {},
    openExternal: undefined,
    openRepository: true,
    bugsnagConnection: {
        tokenLastFour: null,
        status: null,
        projects: [],
        localProjects: [],
        trending: DEFAULT_TRENDING,
        mcpMissing: false,
    },
    releaseTags: {repository: null, latestTagAt: null, detected: null, override: null, tagged: false},
};

function expandHome(typed: string): string {
    if (typed === '~') return FIXTURE_HOME;
    if (typed.startsWith('~/')) return FIXTURE_HOME + typed.slice(1);
    return typed;
}

/** A row as main lists a session read off disk. */
export function sessionRow(change: Partial<SessionRow> & Pick<SessionRow, 'sessionId' | 'projectPath'>): SessionRow {
    return {
        summary: '',
        firstPrompt: '',
        created: '2026-06-10T12:00:00.000Z',
        modified: '2026-06-10T12:00:00.000Z',
        messageCount: 4,
        slug: null,
        aiTitle: null,
        pullRequests: [],
        name: null,
        starred: 0,
        archived: 0,
        snoozedUntil: null,
        ...change,
    };
}

export const test = base.extend<{world: MainWorld}>({
    // Put the world's answers in before the renderer loads, under the test's own.
    api: async ({api, fixture, answers}, use) => {
        const world = new MainWorld(api, fixture);
        world.install();
        for (const [name, answer] of Object.entries(answers)) {
            api.handle(name as never, (typeof answer === 'function' ? answer : () => answer) as never);
        }
        WORLDS.set(api, world);
        await use(api);
    },
    world: async ({api}, use) => {
        await use(WORLDS.get(api)!);
    },
});

const WORLDS = new WeakMap<FakeApi, MainWorld>();

/** The world behind `api`, for a spec that extends this `test` with more of main. */
export function worldOf(api: FakeApi): MainWorld {
    return WORLDS.get(api)!;
}

export {expect};
