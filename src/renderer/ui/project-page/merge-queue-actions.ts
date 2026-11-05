/**
 * What the project page's Merge queue section does (#315): its buttons
 * (Nudge, Fix in session, Retry and a PR row's + Queue), and reading
 * the queue's errands again with each overview.
 *
 * Switchboard never moves a PR itself: Retry and + Queue only remove or add
 * the queue's own labels, through main. Nudge and a new Fix answer a first
 * prompt; the session is started here, as an issue's is (a row is the
 * renderer's to make), and main is told which one it is, or that none
 * started. Nudge asks first, in a plain confirm that shows the exact message.
 *
 * What reaches beyond the store and `window.api` (the confirm, starting a
 * session, the row's pulse, asking for the overview again) comes in through
 * `MergeQueueEffects`, set once at launch (`install-project-page`), so these
 * are tested in node against a fake `window.api` and fake effects.
 */
import {dispatch, getState} from '../../state/app-store';
import {queueActionKey, type QueueActionOutcome} from '../../state/project-page-slice';
import {heldForReview, nudgeMessage} from '../../../domain/project/queue-errands';
import type {FailedEntry, MergeQueue} from '../../../domain/project/merge-queue';

type Started = {ok: true; sessionId: string} | {ok: false; reason: string};

export interface MergeQueueEffects {
    /** A plain confirm: true on yes. */
    confirm(message: string): boolean;
    /**
     * Start a Claude session in `directory` (the project, or a worktree of it)
     * with the project's usual options, minus `--worktree`, and `prompt` as its
     * first prompt; in the background, not on screen.
     */
    launch(directory: string, projectPath: string, prompt: string): Promise<Started>;
    /** The new session's sidebar row pulses once. */
    pulse(sessionId: string): void;
    /** Ask for the overview again, for whatever the page shows. */
    reload(): void;
}

const NO_EFFECTS: MergeQueueEffects = {
    confirm: () => false,
    launch: async () => ({ok: false, reason: 'Not ready yet'}),
    pulse: () => {},
    reload: () => {},
};

let effects: MergeQueueEffects = NO_EFFECTS;

/** Hand the section its effects: the real ones at launch, fakes in a test. */
export function setMergeQueueEffects(next: MergeQueueEffects): void {
    effects = next;
}

/** What the confirm before a nudge says: who, and the message word for word. */
export function nudgeConfirm(reviewer: string, message: string): string {
    return `Nudge ${reviewer} on Slack? This is sent as you:\n\n${message}`;
}

const reasonOf = (err: unknown, fallback: string): string => (err as Error)?.message || fallback;

/**
 * Read the queue's errands in `repository` again, after telling main which
 * held entries wait for a review now, so a nudge whose request changed is
 * settled (and Nudge offered again) before they are read. A failed read keeps
 * what the page had.
 */
export async function followQueueErrands(repository: string, queue: MergeQueue | null): Promise<void> {
    try {
        if (queue) await window.api.queueSettleNudges(repository, heldForReview(queue));
        const errands = await window.api.queueErrands(repository);
        if (Array.isArray(errands)) dispatch({type: 'projectQueueErrandsAnswered', repository, errands});
    } catch {
        // Main could not say; the section shows the errands it had.
    }
}

/** Whether the button under `key` is at work already: a second press does nothing. */
function busy(key: string): boolean {
    return getState().projectPage.queueActions[key]?.phase === 'busy';
}

function answered(key: string, outcome: QueueActionOutcome): void {
    dispatch({type: 'projectQueueActionAnswered', key, outcome});
}

/**
 * Start the errand's session and tell main which one it is, or that none
 * started (which forgets the errand). Answers how it went.
 */
async function startErrand(errandId: string, directory: string, projectPath: string, prompt: string): Promise<Started> {
    let launched: Started;
    try {
        launched = await effects.launch(directory, projectPath, prompt);
    } catch (err) {
        launched = {ok: false, reason: reasonOf(err, 'Could not start the session')};
    }
    if (launched.ok) {
        effects.pulse(launched.sessionId);
        await window.api.queueErrandStarted(errandId, launched.sessionId).catch(() => undefined);
    } else {
        await window.api.queueErrandAbandoned(errandId).catch(() => undefined);
    }
    return launched;
}

/** The PR a held or failed entry is about, as main is told it. */
interface QueuePr {
    number: number;
    title: string;
    url: string;
}

/**
 * Nudge <reviewer> on a held entry: a plain confirm showing the exact
 * message; on yes main records the nudge and answers the first prompt of a
 * session in the project that finds the reviewer on Slack, sends it and
 * archives itself. Nothing happens on no.
 */
export async function nudgeReviewer(
    projectPath: string,
    repository: string,
    pr: QueuePr,
    reviewer: string,
): Promise<void> {
    const key = queueActionKey('nudge', pr.number, reviewer);
    if (busy(key)) return;
    const message = nudgeMessage(pr, reviewer);
    if (!effects.confirm(nudgeConfirm(reviewer, message))) return;
    dispatch({type: 'projectQueueActionAsked', key});
    try {
        const result = await window.api.queueNudge({
            repository,
            pr: {number: pr.number, title: pr.title, url: pr.url},
            reviewer,
            message,
        });
        if (!result.ok) {
            answered(key, {phase: 'failed', reason: result.reason});
            return;
        }
        const started = await startErrand(result.errandId, projectPath, projectPath, result.prompt);
        answered(key, started.ok ? {phase: 'done'} : {phase: 'failed', reason: started.reason});
    } catch (err) {
        answered(key, {phase: 'failed', reason: reasonOf(err, 'Could not nudge ' + reviewer)});
    }
    await followQueueErrands(repository, null);
}

/**
 * Fix in session on a failed entry, handed the queue's failure: to the PR's
 * own running session when it has one (the row then says so), or to a new
 * session in a worktree on the PR's branch, which pushes the fix and
 * archives itself. A stack's failure goes for the member it failed on.
 */
export async function fixInSession(projectPath: string, repository: string, entry: FailedEntry): Promise<void> {
    const key = queueActionKey('fix', entry.number);
    if (busy(key)) return;
    dispatch({type: 'projectQueueActionAsked', key});
    const member = entry.members.find((candidate) => candidate.number === entry.failedMember) ?? entry;
    try {
        const result = await window.api.queueFix({
            repository,
            projectPath,
            pr: {number: member.number, title: member.title, url: member.url, headRef: member.headRef},
            failure: {kind: entry.kind, reason: entry.reason, checkName: entry.failingCheck},
        });
        if (!result.ok) {
            answered(key, {phase: 'failed', reason: result.reason});
        } else if (result.kind === 'queued') {
            answered(key, {phase: 'sent', sessionId: result.sessionId});
        } else {
            const started = await startErrand(result.errandId, result.worktreePath, projectPath, result.prompt);
            answered(
                key,
                !started.ok
                    ? {phase: 'failed', reason: started.reason}
                    : result.warning
                      ? {phase: 'note', text: result.warning}
                      : {phase: 'done'},
            );
            if (started.ok) effects.reload();
        }
    } catch (err) {
        answered(key, {phase: 'failed', reason: reasonOf(err, 'Could not start the fix')});
    }
    await followQueueErrands(repository, null);
}

/** A label write (Retry, Opt in), then the overview again so the entry shows where it went. */
async function labelWrite(key: string, write: () => Promise<{ok: true} | {ok: false; reason: string}>): Promise<void> {
    if (busy(key)) return;
    dispatch({type: 'projectQueueActionAsked', key});
    let outcome: QueueActionOutcome;
    try {
        const result = await write();
        outcome = result.ok ? {phase: 'done'} : {phase: 'failed', reason: result.reason};
    } catch (err) {
        outcome = {phase: 'failed', reason: reasonOf(err, 'GitHub did not answer')};
    }
    answered(key, outcome);
    if (outcome.phase === 'done') effects.reload();
}

/** Retry on a failed entry: `automerge:failed` removed, so the queue takes it back. */
export function retryQueueEntry(repository: string, number: number): Promise<void> {
    return labelWrite(queueActionKey('retry', number), () => window.api.queueRetry(repository, number));
}

/** + Queue (a PR row): `automerge:opt-in` added. */
export function optInToQueue(repository: string, number: number): Promise<void> {
    return labelWrite(queueActionKey('opt-in', number), () => window.api.queueOptIn(repository, number));
}
