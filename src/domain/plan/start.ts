/**
 * Starting a session on a plan's issue (A2, A3): the branch it works on and
 * the prompt Claude starts with.
 */
import {titleSlug} from '../project/branch-worktree';
import type {IssueKey} from './model';

/**
 * `<number>-<slug>`: the slug is the title's first few words, lower case, so
 * `issueFromBranch` reads the number back and the session owns the issue (S1).
 */
export function issueBranchName(issue: IssueKey & {title: string}): string {
    const slug = titleSlug(issue.title);
    return slug ? issue.number + '-' + slug : String(issue.number);
}

/**
 * The fixed prompt (A2). Stacked on a blocker's PR (A3), it also asks for the
 * PR to target that PR's branch.
 */
export function issueSessionPrompt(issue: IssueKey, plan: IssueKey, stackedOn?: number): string {
    const planRef = plan.repository === issue.repository ? '#' + plan.number : plan.repository + '#' + plan.number;
    let prompt =
        `Work on #${issue.number}, part of ${planRef}. Read the epic and the issue first. ` +
        `Open a PR titled with a short summary of what you implemented, with "Closes #${issue.number}" in its description.`;
    if (stackedOn !== undefined) prompt += ` Branch off PR #${stackedOn}'s branch and open your PR against it.`;
    return prompt;
}

/**
 * The prompt for continuing on an issue's branch that exists already: the
 * work so far is on it, so it is read before anything new is done.
 */
export function issueContinuePrompt(issue: IssueKey, plan: IssueKey): string {
    const planRef = plan.repository === issue.repository ? '#' + plan.number : plan.repository + '#' + plan.number;
    return (
        `Continue work on #${issue.number}, part of ${planRef}: this branch already has earlier work on it. ` +
        'Read the epic and the issue, then what the branch has so far (its commits, and any uncommitted changes) before going on. ' +
        `Open a PR titled with a short summary of what you implemented, with "Closes #${issue.number}" in its description, unless one is open already.`
    );
}

/**
 * A loose issue as its session starts on it (#415): the ticket, the newest of
 * its thread, and your notes from the Issue manager.
 */
export interface LooseIssueTicket {
    title: string;
    body: string;
    /** Login; null for a deleted account. */
    author: string | null;
    /** The newest comments, oldest first. */
    comments: readonly {author: string | null; body: string}[];
    /** Your notes; empty for none. */
    notes: string;
}

/**
 * The prompt of a session on a loose issue (#415): no plan, so no epic to
 * read; your notes first, as the context you want it read in, then the
 * ticket and its thread between tags, so they read as material rather than
 * as the request. On a branch that exists already (`continuing`) the work
 * so far is read first.
 */
export function looseIssueSessionPrompt(issue: IssueKey, ticket: LooseIssueTicket, continuing = false): string {
    const n = issue.number;
    const opening = continuing
        ? `Continue work on #${n}, a loose issue in no plan: this branch already has earlier work on it. ` +
          'Read the issue below, then what the branch has so far (its commits, and any uncommitted changes) before going on. ' +
          `Open a PR titled with a short summary of what you implemented, with "Closes #${n}" in its description, unless one is open already.`
        : `Work on #${n}, a loose issue in no plan. Read the issue below first. ` +
          `Open a PR titled with a short summary of what you implemented, with "Closes #${n}" in its description.`;
    const parts = [opening];
    const notes = ticket.notes.trim();
    if (notes) parts.push(['My notes on it:', '<notes>', notes, '</notes>'].join('\n'));
    parts.push(
        [
            'The issue:',
            `<issue number="${n}" author="${ticket.author ?? 'ghost'}">`,
            '# ' + ticket.title,
            ...(ticket.body.trim() ? ['', ticket.body.trim()] : []),
            '</issue>',
        ].join('\n'),
    );
    if (ticket.comments.length > 0) {
        parts.push(
            [
                'Its newest comments, oldest first:',
                ...ticket.comments.map(
                    (comment) => `<comment author="${comment.author ?? 'ghost'}">\n${comment.body.trim()}\n</comment>`,
                ),
            ].join('\n'),
        );
    }
    return parts.join('\n\n');
}

/**
 * A ticket of a wayfinder map is worked with the wayfinder skill, not built to
 * a PR: `/wayfinder <map> <ticket>`, by bare number since the session runs in
 * the map's repository, and by URL for one in another. The skill picks up
 * where an earlier session left off, so it is the prompt for continuing too.
 */
export function wayfinderTicketPrompt(issue: IssueKey, plan: IssueKey): string {
    return `/wayfinder ${skillRef(plan, plan)} ${skillRef(issue, plan)}`;
}

/** What a wayfinder map's launchers start (Tern's launchers for a map). */
export type MapLauncher = 'next' | 'reconcile';

export const MAP_LAUNCHERS: readonly MapLauncher[] = ['next', 'reconcile'];

/** The prompt a map launcher starts its session with. */
export function mapLauncherPrompt(launcher: MapLauncher, plan: IssueKey): string {
    const ref = String(plan.number);
    if (launcher === 'reconcile') return '/reconciling-the-map ' + ref;
    return '/wayfinder ' + ref;
}

/** An issue as a skill takes it: its number in the map's repository, its URL in another. */
function skillRef(issue: IssueKey, plan: IssueKey): string {
    return issue.repository === plan.repository
        ? String(issue.number)
        : `https://github.com/${issue.repository}/issues/${issue.number}`;
}

/** One issue of a level, its worktree made, as the level's session hands it to an agent. */
export interface LevelAgent {
    issue: IssueKey;
    worktreePath: string;
    branch: string;
    /** The issue's own prompt (`issueSessionPrompt`), which its agent works to. */
    prompt: string;
}

/**
 * The prompt of Start level's one session (A1): it governs, and runs one
 * agent per issue, each in the worktree made for it, all at once.
 */
export function levelSessionPrompt(plan: IssueKey, level: number, agents: readonly LevelAgent[]): string {
    const planRef = agents.every((agent) => agent.issue.repository === plan.repository)
        ? '#' + plan.number
        : plan.repository + '#' + plan.number;
    const lines = [
        `You coordinate level ${level} of ${planRef}: ${agents.length === 1 ? 'one issue' : agents.length + ' issues'}, ` +
            'each with a worktree made for it. Do not implement them yourself. Read the epic first, then start one agent ' +
            'per issue with the Agent tool, all in one message so they run at the same time. Tell each agent its worktree, ' +
            'to work and run every command there and nowhere else, and its task:',
        ...agents.map(
            (agent) =>
                `- #${agent.issue.number}: worktree ${agent.worktreePath} (branch ${agent.branch}). ${agent.prompt}`,
        ),
        'When they are all back, check that each opened its PR; send an agent that stopped short back to finish. ' +
            'End with a short summary per issue: its PR, or what stopped it.',
    ];
    return lines.join('\n');
}
