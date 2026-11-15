/**
 * A stand-in for the part of main the session list talks to, for the
 * component specs of the list, the sidebar, the keyboard and the toolbar.
 *
 * The session list asks main for more than one answer at a time: a pin is
 * stored and read back by the next `getProjects`, an opened session shows up
 * in `getActiveSessions`, a stopped one leaves it. So instead of separate
 * answers this keeps one small world — the projects with their metadata, the
 * running sessions, the plain terminals — and answers every one of those calls
 * from it, the way main's repository and registry would:
 *
 * - `getProjects` lists the projects, archived sessions only when asked, and a
 *   row for each plain terminal (as `buildProjectList` does).
 * - `toggleStar`, `togglePlanPin`, `renameSession`, `archiveSession` and
 *   `snoozeSession` store what main's repository stores, and answer as main does.
 * - `openTerminal` starts a session (it is then running), `stopSession` stops it.
 * - `search` matches a title, or a title or a body, case-insensitively, as the
 *   trigram index does.
 *
 * What a running process would say — busy, idle, a notification, a question —
 * the test pushes with the helpers below, which send what main sends for it.
 *
 * The e2e helpers that read through `window.api` (`storedSession`, `redraw`'s
 * rename) land here too, so they read this world.
 */
import {expect} from '@playwright/test';
import type {Locator, Page} from '@playwright/test';
import {test as base} from './test';
import type {FakeApi} from './fake-api';
import {captured, type CapturedFixture} from '../fixtures/captured';
import {mergeEffectiveSettings} from '../../src/domain/settings/settings';
import {DEFAULT_TRENDING} from '../../src/domain/bugsnag/connection';
import type {Project} from '../../src/domain/project/project';
import type {SessionRow} from '../../src/domain/session/session';
import type {Question} from '../../src/domain/questions/question';
import {QUESTION_HOOK_TIMEOUT_SECONDS} from '../../src/domain/questions/question';
import {FIXTURE_NOW, HARNESS_SETTINGS} from '../../e2e/support/fixture-home';
import {sidebar, sessionRow, terminalStatus} from '../../e2e/support/app';
import {REMOTE} from '../../e2e/fixtures/standard';

/** One running process, as main's registry knows it. */
interface Running {
    projectPath: string;
    isNew: boolean;
    type: string | undefined;
    openedAt: number;
}

/** What a search can find in a session besides its title: its transcript's text. */
export type Bodies = Record<string, string>;

export class FakeMain {
    /** Every project, archived sessions included, as main's index holds them. */
    private readonly projects: Project[];
    /** Running sessions by id, in the order they started. */
    public readonly running = new Map<string, Running>();
    /** Metadata stored for ids that have no row. */
    private readonly orphans = new Map<string, Pick<SessionRow, 'name' | 'starred' | 'archived' | 'snoozedUntil'>>();
    /** The error every `stopSession` answers with, once `failStops` set one. */
    private stopFailure: string | null = null;

    constructor(
        fixture: CapturedFixture,
        private readonly bodies: Bodies = {},
    ) {
        this.projects = structuredClone(fixture.projectsWithArchived);
    }

    /** Answer the session list's calls from this world. */
    public install(api: FakeApi): void {
        api.handle('getProjects', (showArchived) => this.list(showArchived));
        api.handle('getActiveSessions', () => [...this.running.keys()]);
        api.handle('getActiveTerminals', () =>
            [...this.running]
                .filter(([, run]) => run.type === 'terminal')
                .map(([sessionId, run]) => ({sessionId, projectPath: run.projectPath})),
        );
        api.handle('openTerminal', (id, projectPath, isNew, options) => {
            if (!this.running.has(id)) {
                this.running.set(id, {projectPath, isNew, type: options?.type, openedAt: FIXTURE_NOW});
            }
            return {ok: true, reattached: false};
        });
        api.handle('stopSession', (id) => {
            if (this.stopFailure) return {ok: false, error: this.stopFailure};
            const was = this.running.delete(id);
            return was ? {ok: true} : {ok: true, alreadyStopped: true};
        });
        api.handle('toggleStar', (id) => {
            const row = this.meta(id);
            row.starred = row.starred ? 0 : 1;
            return {starred: row.starred};
        });
        api.handle('togglePlanPin', (projectPath, slug) => {
            const project = this.projects.find((p) => p.projectPath === projectPath)!;
            const pins = (project.pinnedPlans ??= []);
            const pinned = !pins.includes(slug);
            project.pinnedPlans = pinned ? [...pins, slug] : pins.filter((s) => s !== slug);
            return {pinned};
        });
        api.handle('renameSession', (id, name) => {
            this.meta(id).name = name || null;
            return {name: name || null};
        });
        api.handle('archiveSession', (id, archived) => {
            this.meta(id).archived = archived ? 1 : 0;
            return {archived: archived ? 1 : 0};
        });
        api.handle('snoozeSession', (id, until) => {
            this.meta(id).snoozedUntil = until;
        });
        api.handle('search', (_type, query, titleOnly) => {
            const needle = query.toLowerCase();
            return this.projects
                .flatMap((p) => p.sessions)
                .filter((s) => {
                    const title = [s.name, s.aiTitle, s.summary, s.firstPrompt].filter(Boolean).join(' ');
                    const text = titleOnly ? title : `${title} ${this.bodies[s.sessionId] ?? ''}`;
                    return text.toLowerCase().includes(needle);
                })
                .map((s) => ({id: s.sessionId, snippet: s.summary}));
        });
        api.handle('getEffectiveSettings', (projectPath) =>
            mergeEffectiveSettings(
                api.settings.global as Record<string, unknown> | null,
                projectPath ? (api.settings[`project:${projectPath}`] as Record<string, unknown> | null) : null,
            ),
        );
        api.handle('getShellProfiles', () => []);
        // What an open session's tray and the settings panel read, as main
        // answers them for a quiet session on a machine with nothing set up.
        api.handle('getSessionLinks', () => []);
        api.handle('getSessionStats', () => ({
            contextUsed: null,
            messageCount: null,
            startedAt: null,
            branch: null,
            shell: null,
        }));
        api.handle('savedPrompts', () => ({global: [], project: []}));
        api.handle('canOpenSessionWork', () => false);
        api.handle('handoffHosts', () => []);
        api.handle('getAppVersion', () => '0.0.0-component');
        api.handle('quickAskHotkeyStatus', () => ({registered: true, missing: []}));
        api.handle('bugsnagConnection', () => ({
            tokenLastFour: null,
            status: null,
            projects: [],
            localProjects: [],
            trending: DEFAULT_TRENDING,
            mcpMissing: false,
        }));
    }

    /** From now on every stop fails with `error`, as a PTY that will not die. */
    public failStops(error: string): void {
        this.stopFailure = error;
    }

    /**
     * Where main's repository keeps a session's name, star, archive and snooze:
     * its row, or, for an id with no transcript yet (a pending row), metadata
     * of its own, as `session_meta` takes any id.
     */
    private meta(id: string): Pick<SessionRow, 'name' | 'starred' | 'archived' | 'snoozedUntil'> {
        for (const project of this.projects) {
            const found = project.sessions.find((s) => s.sessionId === id);
            if (found) return found;
        }
        let orphan = this.orphans.get(id);
        if (!orphan) this.orphans.set(id, (orphan = {name: null, starred: 0, archived: 0, snoozedUntil: null}));
        return orphan;
    }

    private list(showArchived: boolean): Project[] {
        const projects = structuredClone(this.projects).map((p) => ({
            ...p,
            sessions: p.sessions.filter((s) => showArchived || !s.archived),
        }));
        for (const [sessionId, run] of this.running) {
            if (run.type !== 'terminal') continue;
            let project = projects.find((p) => p.projectPath === run.projectPath);
            if (!project) {
                project = {projectPath: run.projectPath, folder: run.projectPath.replace(/\//g, '-'), sessions: []};
                projects.push(project);
            }
            const at = new Date(run.openedAt).toISOString();
            project.sessions.push({
                sessionId,
                projectPath: run.projectPath,
                summary: 'Terminal',
                firstPrompt: '',
                created: at,
                modified: at,
                messageCount: 0,
                name: null,
                starred: 0,
                archived: 0,
                type: 'terminal',
            });
        }
        return projects;
    }
}

/**
 * The global settings the e2e fixture home seeds: the harness's, the remote
 * project, and the spec's own. The harness's settings store holds them under
 * `global`, where the renderer reads them.
 */
export function globalSettings(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        global: {
            ...HARNESS_SETTINGS,
            remoteProjects: [{user: REMOTE.user, host: REMOTE.host, port: 22, dir: REMOTE.dir}],
            ...extra,
        },
    };
}

export interface SessionListOptions {
    /** What a full-text search finds in each session's transcript, besides its title. */
    bodies: Bodies;
}

export interface SessionListFixtures {
    main: FakeMain;
}

/**
 * The component `test`, with `main` answering the session list's calls, and
 * the global settings seeded as the e2e fixture home seeds them.
 */
export const test = base.extend<SessionListOptions & SessionListFixtures>({
    bodies: [{}, {option: true}],
    settings: globalSettings(),
    main: async ({fixture, bodies}, use) => {
        await use(new FakeMain(fixture ?? captured('standard'), bodies));
    },
    // In place before the page loads, which is what asks `api` first.
    api: async ({api, main}, use) => {
        main.install(api);
        await use(api);
    },
});

export {expect};

/** A project of the given sessions, as `getProjects` answers it. */
export function project(projectPath: string, sessions: Partial<SessionRow>[]): Project {
    return {
        projectPath,
        folder: projectPath.replace(/[/.]/g, '-'),
        sessions: sessions.map((s, i) => ({
            sessionId: s.sessionId ?? `session-${i}`,
            summary: s.summary ?? '',
            firstPrompt: s.firstPrompt ?? s.summary ?? '',
            projectPath,
            created: s.created ?? s.modified ?? new Date(FIXTURE_NOW).toISOString(),
            modified: s.modified ?? new Date(FIXTURE_NOW).toISOString(),
            messageCount: s.messageCount ?? 1,
            slug: s.slug ?? null,
            aiTitle: s.aiTitle ?? null,
            pullRequests: s.pullRequests ?? [],
            name: s.name ?? null,
            starred: s.starred ?? 0,
            archived: s.archived ?? 0,
            snoozedUntil: s.snoozedUntil ?? null,
        })),
    };
}

/** A captured-shape fixture of these projects, none of them archived. */
export function worldOf(projects: Project[]): CapturedFixture {
    return {projects: structuredClone(projects), projectsWithArchived: structuredClone(projects)};
}

/** An ISO time `minutes` before FIXTURE_NOW. */
export function minutesBefore(minutes: number): string {
    return new Date(FIXTURE_NOW - minutes * 60_000).toISOString();
}

/** Redraws per page, so a marker is the same on every run of a test. */
const redraws = new WeakMap<Page, number>();

/**
 * Redraw the list from freshly fetched projects, as e2e's `redraw` does: a
 * bystander is renamed, main says the projects changed, and the bystander's
 * new name showing up proves the redraw has landed.
 */
export async function redraw(page: Page, api: FakeApi, bystander: string): Promise<void> {
    const count = (redraws.get(page) ?? 0) + 1;
    redraws.set(page, count);
    const marker = `redraw marker ${count}`;
    await page.evaluate(({id, name}) => window.api.renameSession(id, name), {id: bystander, name: marker});
    await api.emit('onProjectsChanged');
    await expect(sidebar(page).getByText(marker, {exact: true})).toHaveCount(1);
}

/** A running session, driven as the CLI under it would drive main. */
export interface Session {
    id: string;
    /** OSC 7501 working/idle: main turns it into the busy state. */
    busy(busy: boolean): Promise<void>;
    /** OSC 9: main forwards the notification. */
    notify(message: string): Promise<void>;
}

/** A session that is running, whether or not it was opened by a click. */
export function sessionOf(api: FakeApi, id: string): Session {
    return {
        id,
        busy: (busy) => api.emit('onCliBusyState', id, busy),
        notify: (message) => api.emit('onTerminalNotification', id, message),
    };
}

/**
 * Open a session by its row, as e2e's `openSession` does: click it, wait for
 * the renderer to ask main to start it, and for the header to say Running.
 */
export async function openSession(page: Page, api: FakeApi, label: string, id: string): Promise<Session> {
    await sessionRow(page, label).first().click();
    await expect.poll(() => api.callsTo('openTerminal').some(([opened]) => opened === id)).toBe(true);
    await expect(terminalStatus(page)).toHaveText('Running');
    return sessionOf(api, id);
}

/** Open a remote session by its row: the renderer asks main to dial it. */
export async function openRemoteSession(page: Page, api: FakeApi, label: string, id: string): Promise<Session> {
    await sessionRow(page, label).click();
    await expect.poll(() => api.callsTo('openTerminal').some(([opened]) => opened === id)).toBe(true);
    return sessionOf(api, id);
}

/** Ask the session's questions, as main does when its hook receives an AskUserQuestion. */
export async function askQuestions(
    api: FakeApi,
    sessionId: string,
    questions: {question: string; options: {label: string; description?: string}[]}[],
): Promise<void> {
    const asked: Question[] = questions.map((q) => ({
        question: q.question,
        header: '',
        options: q.options.map((o) => ({label: o.label, description: o.description ?? ''})),
        multiSelect: false,
    }));
    await api.emit('onQuestionsAsked', {
        sessionId,
        toolUseId: 'toolu_component_' + Math.random().toString(36).slice(2, 10),
        source: 'ask',
        questions: asked,
        askedAt: FIXTURE_NOW,
        deadline: FIXTURE_NOW + QUESTION_HOOK_TIMEOUT_SECONDS * 1000,
    });
}

/** The terminal's keyboard target: xterm's hidden textarea. */
export function terminalInput(page: Page): Locator {
    return page.getByRole('textbox', {name: 'Terminal input'});
}

/** The ids of the sessions the renderer asked main to start since `before` calls. */
export function launchedSince(api: FakeApi, before: number): string[] {
    return api
        .callsTo('openTerminal')
        .slice(before)
        .map(([id]) => id);
}
