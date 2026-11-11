/**
 * Starting a session on a VM rather than here, when the user answered "Do you
 * want to hand this off to…?" with a VM (an issue's, a task's or a level's
 * start).
 *
 * The start goes as it always does up to its worktree, which is made on this
 * Mac; then that worktree is handed off to the VM (as a session's hand-off
 * would hand off its checkout: a worktree of the same name and branch in the
 * project's copy there), and the session starts in the copy, so nothing runs
 * here. Kept free of the terminal and the DOM, so the sequences that use it
 * are tested in node with fakes.
 */
import type {SessionOptions} from '../../../domain/launch/session-options';
import type {HandoffHost, StartHandoffResult} from '../../../application/services/project-handoff';

/** What a start needs to go to a VM. */
export interface VmStartSteps {
    /**
     * Hand the start's worktrees (and with `project`, the project) off to the
     * host (`handOffForStart`); `onProgress` hears each step main reports on the way.
     */
    handOff(
        localPath: string,
        hostKey: string,
        worktrees: string[],
        options: {project: boolean},
        onProgress?: (line: string) => void,
    ): Promise<StartHandoffResult>;
    /** Start a Claude session in a VM folder (a copy's project path), put it on screen unless `show` is false. */
    launch(
        copyPath: string,
        options: SessionOptions,
        how: {show: boolean},
    ): Promise<{ok: true; sessionId: string} | {ok: false; reason: string}>;
}

/** Why a start the user sent to a VM did not get there; the worktree is still on this Mac. */
export function notHandedOff(vm: HandoffHost, error: string): string {
    return `Couldn’t hand it off to ${vm.label}: ${error} The worktree is ready on this Mac.`;
}

/**
 * The steps a start on a VM reports while it goes, so its button need not
 * only say "Starting…" for the minute a hand-off can take.
 */
export const START_STEP = {
    worktree: 'Making the worktree on this Mac',
    handOff: (vm: HandoffHost) => `Getting the hand-off to ${vm.label} ready`,
    launch: (vm: HandoffHost) => `Starting Claude on ${vm.label}`,
} as const;

/** Hand one start's worktree to `vm`: the worktree's copy there, or why it did not go. */
export async function handOffWorktree(
    steps: VmStartSteps | undefined,
    vm: HandoffHost,
    projectPath: string,
    worktreePath: string,
    onStep: (step: string) => void = () => {},
): Promise<{ok: true; copyPath: string} | {ok: false; reason: string}> {
    if (!steps) return {ok: false, reason: notHandedOff(vm, 'hand-off isn’t available here.')};
    let handed: StartHandoffResult;
    onStep(START_STEP.handOff(vm));
    try {
        handed = await steps.handOff(projectPath, vm.key, [worktreePath], {project: false}, onStep);
    } catch (err) {
        handed = {ok: false, error: (err as Error).message || 'the hand-off stopped.'};
    }
    if (!handed.ok) return {ok: false, reason: notHandedOff(vm, sentence(handed.error))};
    const copy = handed.worktrees.find((worktree) => worktree.checkout === worktreePath);
    if (!copy) return {ok: false, reason: notHandedOff(vm, 'the VM did not say where the worktree went.')};
    if (!copy.ok) return {ok: false, reason: notHandedOff(vm, sentence(copy.error))};
    return {ok: true, copyPath: copy.copyPath};
}

/** An error as a sentence: ending in a full stop, once. */
export function sentence(text: string): string {
    const trimmed = text.trim();
    return /[.!?]$/.test(trimmed) ? trimmed : trimmed + '.';
}

/** "Do you want to hand this off to dev@vm?", or "to a VM?" when there are several to pick from. */
export function handOffQuestion(hosts: readonly HandoffHost[]): string {
    return hosts.length === 1
        ? `Do you want to hand this off to ${hosts[0].label}?`
        : 'Do you want to hand this off to a VM?';
}
