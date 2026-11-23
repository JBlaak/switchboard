/**
 * What the Schedule manager does: open it (its figure on the empty screen,
 * ⌘J, the Automatic shelf, a run row; with a key, that schedule's page) and
 * close it, read its facts and a schedule's page, move through it, and act on
 * a schedule or a run: Run now, Pause and Turn on, Skip the next run, Seen,
 * the Mac's wake, the prompt and the settings, Carry on in a session and Tune
 * the prompt from a run.
 *
 * The page's components and keys call these and nothing else.
 */
import {dispatch, getState} from '../../state/app-store';
import {overviewGroups, overviewOrder, stepKey} from '../../../domain/schedule/page';
import {tunePrompt} from '../../../domain/schedule/tune-prompt';
import {jumpToSession} from '../session-work/plan/actions';
import {startClaudeSessionIn} from '../../features/sessions/session-actions';
import {resolveDefaultSessionOptions} from '../../features/dialogs/launch-options';
import {promptShown} from '../../state/schedule-manager-slice';
import type {ScheduleActionResult, ScheduleRun, ScheduleSettings} from '../../../domain/schedule/manager';

// ── The route ──

export function openScheduleManager(key: string | null = null): void {
    dispatch({type: 'scheduleManagerPageRequested', key});
}

/** The create form: blank, or drafted from what a session did. */
export function openCreateSchedule(sessionId: string | null = null): void {
    dispatch({type: 'scheduleCreateRequested', sessionId});
}

/** Esc: from a schedule's page to the overview, from the overview back to what it covered. */
export function closeScheduleManager(): void {
    const route = getState().mainArea.route;
    if (route.kind === 'scheduleManager' && route.key !== null) openScheduleManager(null);
    else dispatch({type: 'scheduleManagerPageClosed'});
}

/** ⌘J: the page, open or closed. */
export function toggleScheduleManager(): void {
    if (getState().mainArea.route.kind === 'scheduleManager') dispatch({type: 'scheduleManagerPageClosed'});
    else openScheduleManager(null);
}

/** Open run: a schedule's page with that run unfolded. */
export function openRun(key: string, runId: string): void {
    openScheduleManager(key);
    dispatch({type: 'scheduleRunToggled', runId, open: true});
}

// ── Reading ──

export async function loadScheduleFacts(): Promise<void> {
    try {
        dispatch({type: 'scheduleManagerChanged', facts: await window.api.scheduleManagerFacts()});
    } catch {
        // Main answers on its next change.
    }
}

export async function loadScheduleDetail(key: string): Promise<void> {
    try {
        dispatch({type: 'scheduleDetailLoaded', key, detail: await window.api.scheduleManagerDetail(key)});
    } catch (err) {
        notice('Could not read the schedule: ' + (err as Error).message);
    }
}

function notice(text: string | null): void {
    dispatch({type: 'scheduleManagerNoticed', notice: text});
}

// ── Going through ──

export function selectSchedule(key: string | null): void {
    dispatch({type: 'scheduleRowSelected', key});
}

/** J/K on the overview. */
export function stepSchedule(step: 1 | -1): void {
    const {facts, page} = getState().scheduleManager;
    const keys = overviewOrder(overviewGroups(facts?.schedules ?? []), page.showPaused);
    const next = stepKey(keys, page.selected, step);
    if (next) selectSchedule(next);
}

export function showPaused(shown: boolean): void {
    dispatch({type: 'schedulePausedShown', shown});
}

/** J/K on a schedule's page: the runs, newest first. */
export function stepRun(step: 1 | -1): void {
    const page = getState().scheduleManager.page;
    const ids = (page.detail?.runs ?? []).map((run) => run.id);
    const next = stepKey(ids, page.selectedRun, step);
    if (next) dispatch({type: 'scheduleRunSelected', runId: next});
}

export function toggleRun(runId: string): void {
    dispatch({type: 'scheduleRunToggled', runId});
}

// ── A schedule ──

/** Do `what` with the page busy, and say why when main refused. */
async function act(what: string, call: () => Promise<ScheduleActionResult>, done?: string): Promise<boolean> {
    if (getState().scheduleManager.page.busy) return false;
    dispatch({type: 'scheduleManagerBusy', what});
    notice(null);
    try {
        const result = await call();
        if ('error' in result) {
            notice(result.error);
            return false;
        }
        if (done) notice(done);
        return true;
    } catch (err) {
        notice((err as Error).message);
        return false;
    } finally {
        dispatch({type: 'scheduleManagerBusy', what: null});
        reloadOpen();
    }
}

function reloadOpen(): void {
    const key = getState().scheduleManager.page.openKey;
    if (key) void loadScheduleDetail(key);
}

function nameOf(key: string): string {
    const facts = getState().scheduleManager.facts;
    return facts?.schedules.find((schedule) => schedule.key === key)?.settings.name ?? 'The schedule';
}

/** R. */
export function runNow(key: string): Promise<boolean> {
    return act('runNow', () => window.api.scheduleManagerRunNow(key), `${nameOf(key)} is running.`);
}

/** P, Pause, Turn on. */
export function setEnabled(key: string, enabled: boolean): Promise<boolean> {
    return act('enable', () => window.api.scheduleManagerSetEnabled(key, enabled));
}

/** P: paused when on, on when paused. */
export function togglePaused(key: string): Promise<boolean> {
    const schedule = getState().scheduleManager.facts?.schedules.find((entry) => entry.key === key);
    return schedule ? setEnabled(key, !schedule.settings.enabled) : Promise.resolve(false);
}

/** Skip tonight (its next run). */
export function skipNext(key: string): Promise<boolean> {
    return act('skip', () => window.api.scheduleManagerSkipNext(key), `${nameOf(key)} skips its next run.`);
}

/** S, Seen. */
export async function markSeen(runId: string): Promise<void> {
    try {
        await window.api.scheduleManagerMarkSeen(runId);
    } catch (err) {
        notice('Could not mark it seen: ' + (err as Error).message);
    }
    reloadOpen();
}

/** Wake the Mac at 02:55. */
export function setWake(at: string): Promise<boolean> {
    return act('wake', () => window.api.scheduleManagerSetWake(at), `The Mac wakes at ${at} every day.`);
}

// ── The prompt ──

export function typePrompt(text: string): void {
    dispatch({type: 'schedulePromptTyped', text});
}

export function typePromptNote(note: string): void {
    dispatch({type: 'schedulePromptNoteTyped', note});
}

/** Undo changes: the saved prompt back in the editor. */
export function resetPrompt(): void {
    dispatch({type: 'schedulePromptReset'});
}

/** An old version from the history, into the editor; saving it makes it the newest. */
export function loadPromptVersion(version: number): void {
    const saved = getState().scheduleManager.page.detail?.versions.find((entry) => entry.version === version);
    if (saved) typePrompt(saved.text);
}

/** Save as vN+1, and with `runNow` start a run on it. */
export async function savePrompt(runNow: boolean): Promise<void> {
    const page = getState().scheduleManager.page;
    const detail = page.detail;
    if (!detail || page.busy) return;
    const settings = {...detail.summary.settings, prompt: promptShown(page)};
    const saved = await save(settings, page.promptNote.trim() || null, runNow);
    if (saved) {
        dispatch({type: 'schedulePromptReset'});
        notice(runNow ? 'Saved, and running it now.' : 'Saved.');
    }
}

async function save(settings: ScheduleSettings, note: string | null, runNow: boolean): Promise<boolean> {
    const key = getState().scheduleManager.page.openKey;
    if (!key) return false;
    return act('save', async () => {
        const result = await window.api.scheduleManagerSave(key, settings, note, runNow);
        if ('error' in result) return result;
        // A new slug moves the file: the page follows it.
        if (result.key !== key) openScheduleManager(result.key);
        return {ok: true};
    });
}

// ── The settings ──

export function openSettings(): void {
    const settings = getState().scheduleManager.page.detail?.summary.settings;
    if (settings) dispatch({type: 'scheduleSettingsOpened', settings});
}

export function editSettings(settings: ScheduleSettings): void {
    dispatch({type: 'scheduleSettingsEdited', settings});
}

export function closeSettings(): void {
    dispatch({type: 'scheduleSettingsClosed'});
}

/** The settings sheet's Save: when, where and how, the prompt kept as saved. */
export async function saveSettings(): Promise<void> {
    const page = getState().scheduleManager.page;
    if (!page.settingsDraft || !page.detail) return;
    const settings = {...page.settingsDraft, prompt: page.detail.summary.settings.prompt};
    if (await save(settings, null, false)) closeSettings();
}

// ── A run ──

/** Carry on in a session: the run's session on screen, resumed. */
export async function carryOn(run: ScheduleRun): Promise<void> {
    if (!run.sessionId) return;
    if (!(await jumpToSession(run.sessionId))) notice("This run's session is not in the list.");
}

/**
 * Tune the prompt from this run: a new session in the schedule's project,
 * asked to improve the schedule's prompt from what the run did. It works in
 * the checkout, where the schedule's file is, never a worktree of its own.
 */
export async function tuneFromRun(key: string, run: ScheduleRun): Promise<void> {
    const detail = getState().scheduleManager.page.detail;
    if (!detail || getState().scheduleManager.page.busy) return;
    const {projectPath, name} = detail.summary.settings;
    dispatch({type: 'scheduleManagerBusy', what: 'tune'});
    notice(null);
    try {
        const {worktree: _worktree, worktreeName: _name, ...defaults} = await resolveDefaultSessionOptions(projectPath);
        const launched = await startClaudeSessionIn(projectPath, {
            ...defaults,
            initialPrompt: tunePrompt(key, name, run),
        });
        if (!launched.ok) notice('Could not start the session: ' + launched.reason);
    } catch (err) {
        notice('Could not start the session: ' + (err as Error).message);
    } finally {
        dispatch({type: 'scheduleManagerBusy', what: null});
    }
}
