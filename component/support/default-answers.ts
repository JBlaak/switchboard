/**
 * What the fake api answers when a test has not said: a quiet machine with
 * nothing set up. Every value is typed against `SwitchboardApi`, so a change to
 * the contract breaks here at compile time instead of in a test.
 *
 * A call with no default and no handler answers `undefined` and is listed in
 * `FakeApi.unhandled`, so a test that needs it says so by failing loudly.
 */
import type {SwitchboardApi} from '../../src/ipc/api';
import {EMPTY_INBOX_SUMMARY} from '../../src/domain/inbox/model';
import {EMPTY_MERGE_MANAGER_STATE} from '../../src/domain/merge-manager/model';
import {PHONE_ACCESS_OFF} from '../../src/domain/phone/state';
import type {Usage} from '../../src/domain/usage/usage';

export type Answers = {
    [K in keyof SwitchboardApi]?: SwitchboardApi[K] extends (...args: infer A) => infer R
        ? Awaited<R> | ((...args: A) => Awaited<R> | Promise<Awaited<R>>)
        : never;
};

/** The gauges' usage, the same fixed numbers the e2e harness shows. */
export const DEFAULT_USAGE: Usage = {
    limits: [
        {kind: 'session', label: 'Current session', model: null, percent: 42, reset: '6pm (UTC)', severity: 'normal'},
        {
            kind: 'weekly_all',
            label: 'Week (all models)',
            model: null,
            percent: 67,
            reset: 'Jun 12 at 9am (UTC)',
            severity: 'normal',
        },
    ],
};

export const DEFAULT_ANSWERS: Answers = {
    // Boot
    getProjects: [],
    getActiveSessions: [],
    getActiveTerminals: [],
    getPendingQuestions: [],
    grillViews: [],
    getSleepDisabled: false,
    getUsage: DEFAULT_USAGE,
    getUpdate: null,
    getUpdateOutcome: null,
    getWeather: null,
    getPhoneAccess: PHONE_ACCESS_OFF,
    getTerminalOwners: {},
    vmHosts: [],
    inboxSummary: EMPTY_INBOX_SUMMARY,
    mergeManagerState: EMPTY_MERGE_MANAGER_STATE,
    scheduleManagerFacts: {schedules: [], recentRuns: [], wakeAt: null, suggestedWakeAt: null, week: null},
    githubHeldUntil: null,
    warmAskRoute: undefined,

    // A session on screen: its tray and its header's reads
    getSessionLinks: [],
    getSessionStats: {contextUsed: null, messageCount: null, startedAt: null, branch: null, shell: null},
    savedPrompts: {global: [], project: []},
    workspaceEditor: {available: false, reason: 'No editor in the component harness'},
    canOpenSessionWork: false,
    handoffHosts: [],
    projectCopies: [],
    schedulesWhere: null,

    // The settings page
    getShellProfiles: [],
    getAppVersion: '9.0.0',
    quickAskHotkeyStatus: {registered: true, missing: []},
    bugsnagConnection: {
        tokenLastFour: null,
        status: null,
        projects: [],
        localProjects: [],
        trending: {multiplier: 3, minEvents: 20},
        mcpMissing: false,
    },

    // Host actions with nothing to answer; a test reads them with `callsTo`
    openExternal: undefined,
    writeClipboard: undefined,
    writeClipboardImage: undefined,
};
