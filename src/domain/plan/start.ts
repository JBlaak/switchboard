/**
 * Starting a session on a plan's issue (A2, A3): the branch it works on and
 * the prompt Claude starts with.
 */
import { titleSlug } from '../project/branch-worktree';
import type { IssueKey } from './model';

/**
 * `<number>-<slug>`: the slug is the title's first few words, lower case, so
 * `issueFromBranch` reads the number back and the session owns the issue (S1).
 */
export function issueBranchName(issue: IssueKey & { title: string }): string {
  const slug = titleSlug(issue.title);
  return slug ? issue.number + '-' + slug : String(issue.number);
}

/**
 * The fixed prompt (A2). Stacked on a blocker's PR (A3), it also asks for the
 * PR to target that PR's branch.
 */
export function issueSessionPrompt(issue: IssueKey, plan: IssueKey, stackedOn?: number): string {
  const planRef = plan.repository === issue.repository ? '#' + plan.number : plan.repository + '#' + plan.number;
  let prompt = `Work on #${issue.number}, part of ${planRef}. Read the epic and the issue first. ` +
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
  return `Continue work on #${issue.number}, part of ${planRef}: this branch already has earlier work on it. ` +
    'Read the epic and the issue, then what the branch has so far (its commits, and any uncommitted changes) before going on. ' +
    `Open a PR titled with a short summary of what you implemented, with "Closes #${issue.number}" in its description, unless one is open already.`;
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
    ? '#' + plan.number : plan.repository + '#' + plan.number;
  const lines = [
    `You coordinate level ${level} of ${planRef}: ${agents.length === 1 ? 'one issue' : agents.length + ' issues'}, ` +
      'each with a worktree made for it. Do not implement them yourself. Read the epic first, then start one agent ' +
      'per issue with the Agent tool, all in one message so they run at the same time. Tell each agent its worktree, ' +
      'to work and run every command there and nowhere else, and its task:',
    ...agents.map((agent) => `- #${agent.issue.number}: worktree ${agent.worktreePath} (branch ${agent.branch}). ${agent.prompt}`),
    'When they are all back, check that each opened its PR; send an agent that stopped short back to finish. ' +
      'End with a short summary per issue: its PR, or what stopped it.',
  ];
  return lines.join('\n');
}
