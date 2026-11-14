/**
 * Moving merging between this Mac and a VM (#442), from the Merge manager's
 * page and the figure's menu. Main pushes the new state as it moves; these
 * answer what to say beside the button.
 */

/** What a move came to, in words for beside its button. */
export interface MoveAnswer {
    readonly ok: boolean;
    readonly text: string | null;
    /** The command that fixes a refused hand-off. */
    readonly fix?: string;
    /** The VM did not answer: Take back anyway is offered. */
    readonly unreachable?: boolean;
}

export async function handOffMerging(vmKey?: string): Promise<MoveAnswer> {
    try {
        const answer = await window.api.mergeManagerHandOff(vmKey);
        if (answer.ok) return {ok: true, text: answer.warning};
        return {ok: false, text: answer.reason, ...(answer.fix ? {fix: answer.fix} : {})};
    } catch (err) {
        return {ok: false, text: (err as Error).message};
    }
}

export async function bringMergingBack(): Promise<MoveAnswer> {
    try {
        const answer = await window.api.mergeManagerBringBack();
        return answer.ok ? {ok: true, text: null} : {ok: false, text: answer.reason, unreachable: answer.unreachable};
    } catch (err) {
        return {ok: false, text: (err as Error).message, unreachable: true};
    }
}

export async function takeMergingBack(): Promise<MoveAnswer> {
    try {
        await window.api.mergeManagerTakeBack();
        return {ok: true, text: null};
    } catch (err) {
        return {ok: false, text: (err as Error).message};
    }
}

export async function dismissAwaySummary(): Promise<void> {
    try {
        await window.api.mergeManagerDismissAway();
    } catch {
        // The summary stays; dismissing again tries again.
    }
}
