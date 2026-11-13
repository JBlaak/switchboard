/**
 * A wayfinder map's launchers (Next ticket, Reconcile): one
 * session in the project, started the way a new session there starts, with
 * the launcher's skill as its first prompt. It is about the map, not one
 * ticket, so it gets no ticket worktree; the project's own options decide
 * whether it gets one of its own.
 *
 * Kept free of the terminal and the DOM, so the sequence is tested in node
 * with fakes; `actions.ts` hands it the real steps.
 */
import type {IssueKey} from '../../../../domain/plan/model';
import {mapLauncherPrompt, type MapLauncher} from '../../../../domain/plan/start';
import type {StartIssueSessionSteps} from './start-issue-session';

export type MapLauncherSteps = Pick<StartIssueSessionSteps, 'defaultOptions' | 'launch'>;

export interface MapLauncherRequest {
    projectPath: string;
    plan: IssueKey;
    launcher: MapLauncher;
    /** Put the new session on screen; false keeps the page where it is. Default true. */
    show?: boolean;
}

export async function startMapLauncherWith(
    steps: MapLauncherSteps,
    {projectPath, plan, launcher, show = true}: MapLauncherRequest,
): Promise<{ok: true; sessionId: string} | {ok: false; reason: string}> {
    try {
        const defaults = await steps.defaultOptions(projectPath);
        return await steps.launch(projectPath, {...defaults, initialPrompt: mapLauncherPrompt(launcher, plan)}, {show});
    } catch (err) {
        return {ok: false, reason: (err as Error).message || 'Could not start the session'};
    }
}
