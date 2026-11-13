/**
 * Fix (#414, for #409): the branch and the prompt a Fix session starts with.
 *
 * The prompt states the `/fix-bugsnag` conventions itself, so a Fix session
 * needs no skill: reproduce with a failing test first, fix, commit with the
 * `Bugsnag-Error` trailer, open a PR, and link it on the error with the
 * bugsnag MCP's `link_issue`. Switchboard follows the work from the branch
 * and its PR, so the session must keep to the branch it is given.
 */
import type {BugFacts} from './model';

/** The branch a Fix works on: `fix/bugsnag-` and the error id's first 8 characters. */
export function fixBranch(errorId: string): string {
    return `fix/bugsnag-${errorId.slice(0, 8)}`;
}

/** The trailer every Fix commit carries. */
export function bugsnagTrailer(facts: Pick<BugFacts, 'projectId' | 'errorId'>): string {
    return `Bugsnag-Error: ${facts.projectId} ${facts.errorId}`;
}

/** The error on the Bugsnag dashboard: by its project's dashboard URL when known. */
export function bugsnagErrorUrl(projectUrl: string | null, errorId: string): string | null {
    return projectUrl ? `${projectUrl.replace(/\/+$/, '')}/errors/${encodeURIComponent(errorId)}` : null;
}

export interface FixPromptInput {
    readonly facts: BugFacts;
    /** The Bugsnag project's name. */
    readonly projectName: string;
    readonly branch: string;
    /** The error on the dashboard, when known. */
    readonly url: string | null;
    /** The top in-project frames, `file:line method`, when read. */
    readonly frames: readonly string[];
}

/** The prompt a Fix session starts with. */
export function fixPrompt(input: FixPromptInput): string {
    const {facts} = input;
    const title = [facts.errorClass, facts.message].filter(Boolean).join(': ');
    const lines = [
        `Fix this Bugsnag error from ${input.projectName}.`,
        '',
        `Error: ${title}`,
        `Bugsnag project id: ${facts.projectId}`,
        `Bugsnag error id: ${facts.errorId}`,
    ];
    if (facts.context) lines.push(`Context: ${facts.context}`);
    if (input.url) lines.push(`On Bugsnag: ${input.url}`);
    lines.push(`Events: ${facts.events} (${facts.events24h} in the last 24 h), users: ${facts.users}`);
    if (input.frames.length > 0) {
        lines.push('', 'Top in-project frames:', ...input.frames.map((frame) => `- ${frame}`));
    }
    lines.push(
        '',
        `You are on the branch \`${input.branch}\` in a worktree of its own. Keep all work on this branch.`,
        '',
        'How to fix it:',
        '1. Read the error with the bugsnag MCP (its events, stack trace and breadcrumbs) and find the cause in this repository.',
        '2. Reproduce it with a failing test first, and run the test to see it fail.',
        '3. Fix the cause, not the symptom, and run the test again to see it pass, together with the tests around it.',
        `4. Commit with a message that says what was wrong, ending with the trailer line \`${bugsnagTrailer(facts)}\`.`,
        `5. Push the branch and open a pull request for it; mention the Bugsnag error in its description.`,
        `6. Link the pull request on the error with the bugsnag MCP's \`link_issue\` (project ${facts.projectId}, error ${facts.errorId}, the PR's URL).`,
        '',
        'Do not mark the error fixed in Bugsnag: Switchboard does that when the pull request merges.',
        'If the error cannot be reproduced or fixed from this repository, say why and stop without opening a pull request.',
    );
    return lines.join('\n');
}
