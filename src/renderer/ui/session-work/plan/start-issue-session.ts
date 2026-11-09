/**
 * Starting a session on a plan's issue (A2, A3), from the renderer's side.
 *
 * Main makes the worktree and the prompt (`prepareIssueWorktree`); the
 * session is started here, because its row is the renderer's to make. It
 * starts with the project's usual session options, minus `--worktree` (it is
 * in one already), and with the prompt as the CLI's first prompt.
 *
 * Kept free of the terminal and the DOM, so the sequence is tested in node
 * with fakes; `actions.ts` hands it the real steps.
 */
import type {IssueKey, Plan} from '../../../../domain/plan/model';
import type {IssueSessionStart, IssueWorktreeRequest, IssueWorktreeResult} from '../../../../domain/plan/issue-session';
import type {SessionOptions} from '../../../../domain/launch/session-options';
import type {HandoffHost} from '../../../../application/services/project-handoff';
import {handOffWorktree, type VmStartSteps} from '../../session-handoff/start-on-vm';

export interface StartIssueSessionSteps {
    prepare(request: IssueWorktreeRequest): Promise<IssueWorktreeResult>;
    /** The options a new session in this project starts with by default. */
    defaultOptions(projectPath: string): Promise<SessionOptions>;
    /** Start a Claude session in a directory, put it on screen unless `show` is false, and answer its id. */
    launch(
        projectPath: string,
        options: SessionOptions,
        how: {show: boolean},
    ): Promise<{ok: true; sessionId: string} | {ok: false; reason: string}>;
    /** How a start goes to a VM, when it is handed off; absent where it can't be. */
    vm?: VmStartSteps;
}

export interface StartIssueSessionRequest {
    /** The project the plan is shown for: the worktree goes under its repository. */
    projectPath: string;
    issue: IssueKey;
    plan: Plan;
    /** Put the new session on screen; false keeps the plan view where it is (Start level). Default true. */
    show?: boolean;
    /** What to do with the issue's branch when it exists already (see `IssueWorktreeRequest`). */
    existing?: IssueWorktreeRequest['existing'];
    /** Hand the start off to this VM: the worktree goes there and the session starts in its copy. */
    vm?: HandoffHost;
}

export async function startIssueSessionWith(
    steps: StartIssueSessionSteps,
    {projectPath, issue, plan, show = true, existing, vm}: StartIssueSessionRequest,
): Promise<IssueSessionStart> {
    let prepared: IssueWorktreeResult;
    try {
        prepared = await steps.prepare({projectPath, issue, plan, ...(existing ? {existing} : {})});
    } catch (err) {
        return {ok: false, reason: (err as Error).message || 'Could not prepare the worktree'};
    }
    if (!prepared.ok) return prepared;

    let launched: Awaited<ReturnType<StartIssueSessionSteps['launch']>>;
    if (vm) {
        const copy = await handOffWorktree(steps.vm, vm, projectPath, prepared.worktreePath);
        if (!copy.ok) return copy;
        // The copy's own defaults, as a session started on its project page would get.
        const {
            worktree: _worktree,
            worktreeName: _worktreeName,
            ...defaults
        } = await steps.defaultOptions(copy.copyPath);
        launched = await steps.vm!.launch(copy.copyPath, {...defaults, initialPrompt: prepared.prompt}, {show});
    } else {
        // The session is in its worktree already; `--worktree` would make another.
        const {worktree: _worktree, worktreeName: _worktreeName, ...defaults} = await steps.defaultOptions(projectPath);
        launched = await steps.launch(prepared.worktreePath, {...defaults, initialPrompt: prepared.prompt}, {show});
    }
    if (!launched.ok) return launched;
    return prepared.warning
        ? {ok: true, sessionId: launched.sessionId, warning: prepared.warning}
        : {ok: true, sessionId: launched.sessionId};
}
