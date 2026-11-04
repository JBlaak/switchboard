/**
 * The merge queue's errands (#315): Nudge and Fix in session, the two buttons
 * on the Merge queue section that run their job in a Claude session.
 *
 * A **nudge** asks a held entry's reviewer on Slack to review it. The renderer
 * shows `nudgeMessage` in a plain confirm, word for word; on yes a session in
 * the project finds the reviewer on Slack, sends that message, and archives
 * itself.
 *
 * A **fix** hands the queue's failure to Claude: to the PR's own session when
 * one is running (as a queued action, never told to archive), else to a new
 * session in a worktree on the PR's branch, which pushes the fix and archives
 * itself.
 *
 * Sessions started for either are errands: the UI shows them as such, and as
 * "Needs you" once one stops at its prompt without having asked to be archived
 * (`errandState`).
 *
 * Pure: the words of every prompt are here, where a test can hold them still.
 */
import {ARCHIVE_TOOL_QUALIFIED_NAME} from '../session/archive-tool';
import {renderPrompt} from '../session-work/prompts';
import type {ReviewThread, WorkAction} from '../session-work/model';
import type {FailureKind} from './merge-queue';
import type {ExistingBranch} from './branch-worktree';

/** What the sidebar says of an errand's session. */
export const ERRAND_LABEL = 'errand · archives itself';

/** The PR an errand is about. */
export interface ErrandPullRequest {
    number: number;
    title: string;
    url: string;
}

export type ErrandKind = 'nudge' | 'fix';

/** A session started by Nudge or by Fix in session, as it is kept. */
export interface QueueErrand {
    id: string;
    kind: ErrandKind;
    /** `owner/repo`. */
    repository: string;
    number: number;
    title: string;
    url: string;
    /** A nudge's reviewer (GitHub login); null for a fix. */
    reviewer: string | null;
    /** The exact message a nudge sends; null for a fix. */
    message: string | null;
    /** The session it runs in, once the renderer has started it; null until then. */
    sessionId: string | null;
    /** Epoch ms it was asked for. */
    createdAt: number;
    /**
     * Epoch ms a nudge's review request changed (reviewed, re-requested, no
     * longer asked): from then on a new nudge for it is allowed. Null while it
     * still stands, and always for a fix.
     */
    settledAt: number | null;
}

/**
 * How far an errand got:
 * - `starting`: asked for, its session not started yet;
 * - `running`: its session is working, or has asked to be archived at the end of its turn;
 * - `needs-you`: its session stopped at its prompt without asking to be archived,
 *   or ended without being archived: it is stuck, or wants a decision;
 * - `done`: its session is archived.
 */
export type ErrandState = 'starting' | 'running' | 'needs-you' | 'done';

/** An errand with how far it got, as the renderer reads it. */
export interface QueueErrandView extends QueueErrand {
    state: ErrandState;
}

/** What decides an errand's state, read off its session. */
export interface ErrandFacts {
    /** The renderer has said which session it runs in. */
    started: boolean;
    archived: boolean;
    running: boolean;
    /** Mid-turn, or not at its prompt yet. */
    busy: boolean;
    /** It called `archive_session`; it is archived once its turn ends. */
    archiveRequested: boolean;
    /** A turn of it ended (the Stop hook) without it having asked to be archived. */
    stoppedWithoutArchive: boolean;
}

export function errandState(facts: ErrandFacts): ErrandState {
    if (!facts.started) return 'starting';
    if (facts.archived) return 'done';
    if (!facts.running) return 'needs-you';
    if (facts.archiveRequested) return 'running';
    if (facts.stoppedWithoutArchive && !facts.busy) return 'needs-you';
    return 'running';
}

// ── What the renderer asks main (IPC) ──

/** Ask for a nudge, after the user said yes to `message` in the confirm. */
export interface NudgeRequest {
    /** `owner/repo`. */
    repository: string;
    pr: ErrandPullRequest;
    /** The reviewer's GitHub login. */
    reviewer: string;
    /** The message the confirm showed; it must be `nudgeMessage(pr, reviewer)`. */
    message: string;
}

/** The first prompt of the nudge's session, to start in the project; or why there is none. */
export type NudgeResult = {ok: true; errandId: string; prompt: string} | {ok: false; reason: string};

/** Ask for Fix in session on a PR that left the queue. */
export interface FixRequest {
    /** `owner/repo`. */
    repository: string;
    /** The project the page is for: a new worktree goes under its repository. */
    projectPath: string;
    /** The PR that failed: a stack's failed member, when the queue named one. */
    pr: ErrandPullRequest & {headRef: string; baseRef?: string};
    failure: QueueFailure;
}

/**
 * Queued in the PR's own running session (`queued`); or a worktree on the
 * PR's branch and the first prompt of a new session there (`start`), which
 * the renderer starts and reports with `started`; or why neither.
 */
export type FixResult =
    | {ok: true; kind: 'queued'; sessionId: string; activityId: string}
    | {
          ok: true;
          kind: 'start';
          errandId: string;
          worktreePath: string;
          branch: string;
          prompt: string;
          /** Something to show: it is ready, but not quite as asked. */
          warning?: string;
      }
    | {ok: false; reason: string; existing?: ExistingBranch};

/** What a label write, `started` or `abandon` came to. */
export type ErrandResult = {ok: true} | {ok: false; reason: string};

// ── Nudge ──

/** The Slack message a nudge sends, shown word for word in the confirm first. */
export function nudgeMessage(pr: ErrandPullRequest, reviewer: string): string {
    return `Hey ${reviewer}, could you review #${pr.number} ${pr.title}? It's waiting on your review to get through the merge queue. ${pr.url}`;
}

/** The first prompt of a nudge's session. */
export function nudgePrompt(reviewer: string, message: string): string {
    return (
        `Send a Slack message for me. First find the Slack user who is GitHub user ${reviewer}: ` +
        `search Slack's users with the Slack MCP tools by that login and by the name on their GitHub profile ` +
        `(gh api users/${reviewer} --jq .name). ` +
        'If you cannot tell for sure which Slack user it is, or the Slack tools are not connected, send nothing, ' +
        'say why in one line, and stop: do not archive this session. ' +
        'Otherwise send them this exact message as a direct message, word for word:\n\n' +
        `${message}\n\n` +
        `Once it is sent, call the ${ARCHIVE_TOOL_QUALIFIED_NAME} tool to archive this session.`
    );
}

// ── Fix in session ──

/** The queue's failure, as the renderer hands it over (from the queue's `FailedEntry`). */
export interface QueueFailure {
    kind: FailureKind;
    /** The queue's own words. */
    reason: string;
    /** The failing check's name, for a CI failure; null when the queue did not say. */
    checkName: string | null;
    /** The failing check run's page, when known; main looks it up otherwise. */
    checkRunUrl?: string | null;
}

/** Everything the fix prompt says. */
export interface FixPromptRequest {
    pr: {number: number; url: string; headRef: string; baseRef: string};
    failure: {
        kind: FailureKind;
        reason: string;
        checkName: string | null;
        /** The head commit, when `gh` said. */
        sha: string | null;
        logTail: string | null;
        /** The PR's review threads, when `gh` said; the open ones are handed over. */
        threads: readonly ReviewThread[];
    };
    /** Where the fix is made. */
    worktree: string;
    /**
     * A new session started for the fix, which archives itself once it has
     * pushed; false for the PR's own running session, which is never told to.
     */
    errand: boolean;
}

/** The prompt that hands the queue's failure to Claude, in the Session work actions' forms. */
export function fixPrompt({pr, failure, worktree, errand}: FixPromptRequest): string {
    const parts = [`The merge queue took PR #${pr.number} (${pr.url}) out of the queue: ${failure.reason}`];
    if (errand) {
        parts.push(
            `You are in ${worktree}, on ${pr.headRef}. First bring it up to date with origin/${pr.headRef} (fetch, then fast-forward).`,
        );
    }
    parts.push(fixBody(pr, failure, worktree));
    parts.push(
        `Push to ${pr.headRef} only (git push origin HEAD:${pr.headRef}), and never merge the PR. ` +
            'Do not add or remove any merge-queue label (automerge:*, autorebase:*, bot: first in queue, bot: merges with stack): ' +
            'the new commit is what puts it back in the queue.',
    );
    parts.push(
        errand
            ? `Once the fix is pushed, call the ${ARCHIVE_TOOL_QUALIFIED_NAME} tool to archive this session. ` +
                  'If you are stuck, or the fix needs a decision from me, say why in one line and do not archive.'
            : 'If you are stuck, or the fix needs a decision from me, stop and tell me why in one line.',
    );
    return parts.join('\n');
}

function fixBody(pr: FixPromptRequest['pr'], failure: FixPromptRequest['failure'], worktree: string): string {
    switch (failure.kind) {
        case 'ci':
            return renderPrompt({
                action: 'fix-ci',
                number: pr.number,
                url: pr.url,
                checkName: failure.checkName ?? 'a required check',
                sha: failure.sha ?? 'the head commit',
                logTail: failure.logTail ?? '(no log available; read it with gh run view)',
                worktree,
            });
        case 'conflict':
            return (
                renderPrompt({action: 'rebase', number: pr.number, headRef: pr.headRef, base: pr.baseRef}) +
                ` Work in ${worktree}.`
            );
        case 'changes-requested':
        case 'unresolved-thread': {
            const open = failure.threads.filter((thread) => !thread.resolved);
            if (open.length > 0) {
                return renderPrompt({action: 'fix-comments', number: pr.number, url: pr.url, threads: open, worktree});
            }
            return `Read the review on PR #${pr.number} with gh pr view ${pr.number} --comments, address what it asks for in ${worktree}, and push.`;
        }
        case 'merge-refused':
        case 'other':
            return `Find out why with gh pr view ${pr.number} and gh pr checks ${pr.number}, fix it in ${worktree}, and push.`;
    }
}

/**
 * The Session work action a fix is queued as in the PR's own session, so its
 * Session work page shows it as the work it is.
 */
export function fixAction(kind: FailureKind): WorkAction {
    switch (kind) {
        case 'conflict':
            return 'rebase';
        case 'changes-requested':
        case 'unresolved-thread':
            return 'fix-comments';
        case 'ci':
        case 'merge-refused':
        case 'other':
            return 'fix-ci';
    }
}
