/**
 * What the session tray (#343) does outside its own markup: asking for the
 * session's stats, sending a saved prompt (a click, or ⌘1–9 from anywhere the
 * keys are not typing), and the facts a prompt is filled from.
 */
import {dispatch, getState} from '../../state/app-store';
import {sessionMap} from '../../state/session-store';
import {sessionTaskOf} from '../../state/session-task-slice';
import {sessionStatsIn} from '../../state/session-tray-slice';
import {projectLabel, repositoryRoot} from '../../features/sessions/project-label';
import {savedPromptForKey} from '../../../domain/settings/saved-prompts';
import {loadSavedPrompts, sendSavedPrompt} from './saved-prompts';
import {promptFacts} from './tray-view';
import type {SessionLink} from '../../../domain/session/links';
import type {SessionStats} from '../../../domain/session/stats';
import type {SavedPrompt, SavedPromptFacts} from '../../../domain/settings/saved-prompts';

/** Ask main for the session's stats, for the bar's branch and the tray's Session group. */
export async function loadSessionStats(sessionId: string): Promise<SessionStats | null> {
    try {
        const stats = await window.api.getSessionStats(sessionId);
        dispatch({type: 'sessionStatsLoaded', sessionId, stats});
        return stats;
    } catch {
        return null;
    }
}

/** The session's links, or none when main could not say. */
export async function loadSessionLinks(sessionId: string): Promise<SessionLink[]> {
    try {
        return await window.api.getSessionLinks(sessionId);
    } catch {
        return [];
    }
}

/** The title of the session's task, once BlaakTasks has said; null without one. */
export function taskTitleOf(sessionId: string): string | null {
    return sessionTaskOf(getState().sessionTask, sessionId)?.detail?.title ?? null;
}

/** The facts a prompt for `sessionId` is filled from, given its links and branch. */
export function factsFor(sessionId: string, links: readonly SessionLink[], branch: string | null): SavedPromptFacts {
    const projectPath = projectOf(sessionId);
    return promptFacts({branch, project: projectLabel(projectPath), task: taskTitleOf(sessionId), links});
}

/**
 * The project a session's prompts belong to: its repository, never a
 * worktree of it, since project prompts are stored under the repository's path.
 */
export function projectOf(sessionId: string): string | null {
    const path = sessionMap.get(sessionId)?.projectPath;
    return path ? repositoryRoot(path) : null;
}

/** Type a prompt into the session and flash its row "Sent ✓"; false when nothing was typed. */
export function sendTrayPrompt(sessionId: string, prompt: SavedPrompt, facts: SavedPromptFacts): boolean {
    const sent = sendSavedPrompt(sessionId, prompt, facts);
    if (sent) dispatch({type: 'trayPromptSent', promptId: prompt.id, at: Date.now()});
    return sent;
}

/**
 * ⌘`key`: send the session on screen its `key`th saved prompt, filled in from
 * what is known of it now. Nothing happens without a session on screen or a
 * prompt on that key.
 */
export async function sendSavedPromptOnScreen(key: number): Promise<void> {
    const sessionId = terminalOnScreen();
    if (!sessionId) return;
    const prompts = await loadSavedPrompts(projectOf(sessionId)).catch(() => []);
    const prompt = savedPromptForKey(prompts, key);
    if (!prompt) return;
    const known = sessionStatsIn(getState().sessionTray, sessionId);
    const [links, stats] = await Promise.all([
        loadSessionLinks(sessionId),
        known ? Promise.resolve(known) : loadSessionStats(sessionId),
    ]);
    // The user may have moved on while main answered.
    if (terminalOnScreen() !== sessionId) return;
    sendTrayPrompt(sessionId, prompt, factsFor(sessionId, links, stats?.branch ?? null));
}

/** The session whose terminal is on screen: not one covered by its Session work page, a project or the settings. */
function terminalOnScreen(): string | null {
    const {route} = getState().mainArea;
    return route.kind === 'session' ? route.sessionId : null;
}
