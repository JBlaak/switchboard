/**
 * When a failing check is handed to Claude without asking (W2, W3).
 *
 * Auto-fix is what keeps a swarm's PRs green while you are elsewhere, and also
 * what could burn an afternoon of tokens on a check Claude cannot fix. So it
 * is bounded: two automatic tries per PR per check, then the PR is yours. The
 * history is stored by the caller and survives restarts; this only reads it.
 */
import type { AutoFixAttemptSummary, CheckRun, PullRequestStatus } from './model';

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
    /**
     * The attempt's action is still queued or with Claude. Once Claude has
     * finished its turn the attempt is spent, whether or not it pushed.
     */
    inFlight: boolean;
  }
  | {
    /** The check went green; earlier attempts no longer count. */
    kind: 'passed';
    repository: string;
    number: number;
    checkName: string;
  }
  | {
    /** The attempts ran out and the PR was handed back to you; said once per streak. */
    kind: 'gave-up';
    repository: string;
    number: number;
    checkName: string;
  };

type Attempt = Extract<AutoFixEvent, { kind: 'attempt' }>;

/** What to do about a PR's failing checks this poll. */
export type AutoFixDecision =
  | { action: 'queue'; checkName: string; headSha: string; /** 1-based, for the prompt. */ attempt: number }
  | { action: 'give-up'; checkName: string; attempts: number }
  | { action: 'skip' };

/**
 * Queue a Fix CI, give up, or leave it.
 *
 * A check is in hand while an attempt on it is queued or with Claude, manual
 * or automatic: the next poll seeing the same red check must not queue it
 * again. Once Claude finished its turn the attempt is spent. If it pushed, the
 * new commit failing is the next attempt; if it did not, the same commit still
 * failing is the next attempt too — otherwise a turn that ended without a push
 * would leave the check waiting forever. Only automatic attempts count towards
 * the limit: a manual Fix CI is your call, and is always allowed. A check going
 * green wipes the slate: a failure next week is a new problem.
 *
 * Checks are taken in the order `gh` lists them. One that can still be queued
 * wins over one that has run out, so a PR with two broken checks gets both
 * tried; when nothing can be queued and a check has run out, the PR is given
 * up — once: a check already given up on is left alone until it goes green.
 */
export function autoFixDecision(pr: PullRequestStatus, history: readonly AutoFixEvent[]): AutoFixDecision {
  if (pr.state !== undefined && pr.state !== 'open' && pr.state !== 'draft') return { action: 'skip' };
  const headSha = pr.headSha;
  if (!headSha) return { action: 'skip' };

  let exhausted: { checkName: string; attempts: number } | null = null;
  for (const check of failingChecks(pr.checks)) {
    const { attempts, gaveUp } = sinceGreen(pr, check.name, history);
    if (attempts.some((attempt) => attempt.inFlight)) continue;
    const automatic = attempts.filter((attempt) => attempt.origin === 'auto').length;
    if (automatic < MAX_AUTO_FIX_ATTEMPTS) {
      return { action: 'queue', checkName: check.name, headSha, attempt: automatic + 1 };
    }
    if (!gaveUp) exhausted ??= { checkName: check.name, attempts: automatic };
  }
  return exhausted ? { action: 'give-up', ...exhausted } : { action: 'skip' };
}

/**
 * The automatic attempts on a check since it was last green, for the card
 * that says auto-fix gave up: the commit each was handed, and what Claude
 * pushed in answer — the commit the next attempt (or, for the last one, the
 * PR's head now) failed on, or null when the head did not move.
 */
export function autoFixAttempts(
  pr: PullRequestStatus, checkName: string, history: readonly AutoFixEvent[],
): AutoFixAttemptSummary[] {
  const automatic = sinceGreen(pr, checkName, history).attempts.filter((attempt) => attempt.origin === 'auto');
  return automatic.map((attempt, i) => {
    const next = i + 1 < automatic.length ? automatic[i + 1].headSha : pr.headSha;
    return { attempt: i + 1, failedOn: attempt.headSha, pushed: next && next !== attempt.headSha ? next : null };
  });
}

/** Has anything happened to the check since it was last green, that a green run now wipes? */
export function hasAutoFixStreak(pr: PullRequestStatus, checkName: string, history: readonly AutoFixEvent[]): boolean {
  const { attempts, gaveUp } = sinceGreen(pr, checkName, history);
  return attempts.length > 0 || gaveUp;
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

/** This check's attempts on this PR since it last went green, and whether it was given up on since. */
function sinceGreen(
  pr: PullRequestStatus,
  checkName: string,
  history: readonly AutoFixEvent[],
): { attempts: Attempt[]; gaveUp: boolean } {
  let attempts: Attempt[] = [];
  let gaveUp = false;
  for (const event of history) {
    if (event.repository !== pr.repository || event.number !== pr.number || event.checkName !== checkName) continue;
    if (event.kind === 'passed') {
      attempts = [];
      gaveUp = false;
    } else if (event.kind === 'gave-up') {
      gaveUp = true;
    } else {
      attempts.push(event);
    }
  }
  return { attempts, gaveUp };
}
