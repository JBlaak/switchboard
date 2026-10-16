/**
 * When a failing check is handed to Claude without asking (W2, W3).
 *
 * Auto-fix is what keeps a swarm's PRs green while you are elsewhere, and also
 * what could burn an afternoon of tokens on a check Claude cannot fix. So it
 * is bounded: two automatic tries per PR per check, then the PR is yours. The
 * history is stored by the caller and survives restarts; this only reads it.
 */
import type { CheckRun, PullRequestStatus } from './model';

/** Automatic Fix CI attempts per `(repository, PR, check)` before giving up. */
export const MAX_AUTO_FIX_ATTEMPTS = 2;

/** One thing that happened to a check, as the CI watch records it. */
export type AutoFixEvent =
  | {
    kind: 'attempt';
    repository: string;
    number: number;
    checkName: string;
    /** The head commit the check failed on when the attempt was queued. */
    headSha: string;
    origin: 'manual' | 'auto';
  }
  | {
    /** The check went green; earlier attempts no longer count. */
    kind: 'passed';
    repository: string;
    number: number;
    checkName: string;
  };

/** What to do about a PR's failing checks this poll. */
export type AutoFixDecision =
  | { action: 'queue'; checkName: string; headSha: string; /** 1-based, for the prompt. */ attempt: number }
  | { action: 'give-up'; checkName: string; attempts: number }
  | { action: 'skip' };

/**
 * Queue a Fix CI, give up, or leave it.
 *
 * Attempts are counted per head commit: once one is queued for a commit, that
 * commit's failure has been handed over, and the next poll seeing the same red
 * check must not queue it again. A new push that fails again is the next
 * attempt. A manual Fix CI on the commit also means it has been handed over,
 * but it is your call, so it does not use up an automatic try. A check going
 * green wipes the slate: a failure next week is a new problem.
 *
 * Checks are taken in the order `gh` lists them. One that can still be queued
 * wins over one that has run out, so a PR with two broken checks gets both
 * tried; when nothing can be queued and a check has run out, the PR is given up.
 */
export function autoFixDecision(pr: PullRequestStatus, history: readonly AutoFixEvent[]): AutoFixDecision {
  if (pr.state !== undefined && pr.state !== 'open' && pr.state !== 'draft') return { action: 'skip' };
  const headSha = pr.headSha;
  if (!headSha) return { action: 'skip' };

  let exhausted: { checkName: string; attempts: number } | null = null;
  for (const check of failingChecks(pr.checks)) {
    const attempts = attemptsSinceGreen(pr, check.name, history);
    if (attempts.some((attempt) => attempt.headSha === headSha)) continue;
    const automatic = new Set(attempts.filter((a) => a.origin === 'auto').map((a) => a.headSha)).size;
    if (automatic < MAX_AUTO_FIX_ATTEMPTS) {
      return { action: 'queue', checkName: check.name, headSha, attempt: automatic + 1 };
    }
    exhausted ??= { checkName: check.name, attempts: automatic };
  }
  return exhausted ? { action: 'give-up', ...exhausted } : { action: 'skip' };
}

function failingChecks(checks: readonly CheckRun[] | undefined): CheckRun[] {
  const seen = new Set<string>();
  const failing: CheckRun[] = [];
  for (const check of checks ?? []) {
    if (check.state === 'failing' && !seen.has(check.name)) {
      seen.add(check.name);
      failing.push(check);
    }
  }
  return failing;
}

/** This check's attempts on this PR since it last went green. */
function attemptsSinceGreen(
  pr: PullRequestStatus,
  checkName: string,
  history: readonly AutoFixEvent[],
): Array<Extract<AutoFixEvent, { kind: 'attempt' }>> {
  let attempts: Array<Extract<AutoFixEvent, { kind: 'attempt' }>> = [];
  for (const event of history) {
    if (event.repository !== pr.repository || event.number !== pr.number || event.checkName !== checkName) continue;
    if (event.kind === 'passed') attempts = [];
    else attempts.push(event);
  }
  return attempts;
}
