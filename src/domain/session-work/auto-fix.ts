/**
 * When a failing check is handed to Claude without asking (W2, W3).
 *
 * Auto-fix is what keeps a swarm's PRs green while you are elsewhere. It hands
 * a check over once, when it goes red; whether to try again — push another
 * fix, re-run a flaky job, or stop and tell you — is Claude's call, made in its
 * own turn with the run in front of it. Switchboard never types the same Fix CI
 * in again: the check has to go green before a new failure is handed over. The
 * history is stored by the caller and survives restarts; this only reads it.
 */
import type {CheckRun, PullRequestStatus} from './model';

/** One thing that happened to a check, as the CI watch records it. */
export type AutoFixEvent =
    | {
          kind: 'attempt';
          repository: string;
          number: number;
          checkName: string;
          /** The head commit the check failed on when it was handed over. */
          headSha: string;
          origin: 'manual' | 'auto';
      }
    | {
          /** The check went green; a failure after this is a new one. */
          kind: 'passed';
          repository: string;
          number: number;
          checkName: string;
      };

/** What to do about a PR's failing checks this poll. */
export type AutoFixDecision = {action: 'queue'; checkName: string; headSha: string} | {action: 'skip'};

/**
 * Hand a failing check to Claude, or leave it.
 *
 * A check is handed over once per red spell: when it has been handed to Claude
 * since it was last green — automatically, or by your own Fix CI — it is
 * Claude's, finished turn or not. Checks are taken in the order `gh` lists
 * them; one is handed over per poll, and the next waits until Claude is free.
 */
export function autoFixDecision(pr: PullRequestStatus, history: readonly AutoFixEvent[]): AutoFixDecision {
    if (pr.state !== undefined && pr.state !== 'open' && pr.state !== 'draft') return {action: 'skip'};
    const headSha = pr.headSha;
    if (!headSha) return {action: 'skip'};

    for (const check of failingChecks(pr.checks)) {
        if (!handedOver(pr, check.name, history)) return {action: 'queue', checkName: check.name, headSha};
    }
    return {action: 'skip'};
}

/**
 * The checks that went green this poll after being handed over, each once.
 *
 * GitHub can list a check under one name more than once — a run cancelled by
 * the re-run that replaced it, or a job of that name in two workflows. A name
 * with a failing copy is not green: calling it green would let the failing
 * copy be handed over again on the next poll, and the next.
 */
export function wentGreen(pr: PullRequestStatus, history: readonly AutoFixEvent[]): string[] {
    const failing = new Set(failingChecks(pr.checks).map((check) => check.name));
    const green = new Set<string>();
    for (const check of pr.checks ?? []) {
        if (check.state !== 'passing' || failing.has(check.name)) continue;
        if (handedOver(pr, check.name, history)) green.add(check.name);
    }
    return [...green];
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

/** Has this check on this PR been handed to Claude since it was last green? */
function handedOver(pr: PullRequestStatus, checkName: string, history: readonly AutoFixEvent[]): boolean {
    let handed = false;
    for (const event of history) {
        if (event.repository !== pr.repository || event.number !== pr.number || event.checkName !== checkName) continue;
        handed = event.kind === 'attempt';
    }
    return handed;
}
