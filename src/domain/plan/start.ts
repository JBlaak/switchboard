/**
 * Starting a session on a plan's issue (A2, A3): the branch it works on and
 * the prompt Claude starts with.
 */
import type { IssueKey } from './model';

const SLUG_WORDS = 5;

/**
 * `<number>-<slug>`: the slug is the title's first few words, lower case, so
 * `issueFromBranch` reads the number back and the session owns the issue (S1).
 */
export function issueBranchName(issue: IssueKey & { title: string }): string {
  const words = issue.title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0)
    .slice(0, SLUG_WORDS);
  return words.length ? issue.number + '-' + words.join('-') : String(issue.number);
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
