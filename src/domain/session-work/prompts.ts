/**
 * The prompts the page types into a session's terminal.
 *
 * Every action is a prompt (A1): Claude keeps its context, you can watch it
 * work, and Switchboard never writes to git itself. The texts are fixed in v1
 * (A6), so they live here, word for word, where a test can hold them still.
 */
import type { MergeMethod, ReviewThread } from './model';
import { MAX_AUTO_FIX_ATTEMPTS } from './auto-fix';

export type { MergeMethod };

export interface ShipPrompt {
  action: 'ship';
  number: number;
  url: string;
  base: string;
  method: MergeMethod;
  worktree: string;
  /** The repository's main checkout, where the base branch is pulled afterwards. */
  mainCheckout: string;
}

export interface RebasePrompt {
  action: 'rebase';
  number: number;
  headRef: string;
  base: string;
}

export interface FixCiPrompt {
  action: 'fix-ci';
  number: number;
  url: string;
  checkName: string;
  sha: string;
  logTail: string;
  worktree: string;
  /** Set for an automatic attempt: which one it is, 1-based. */
  automaticAttempt?: number;
}

export interface FixCommentsPrompt {
  action: 'fix-comments';
  number: number;
  url: string;
  threads: readonly ReviewThread[];
  worktree: string;
}

export interface OpenPrPrompt {
  action: 'open-pr';
  branch: string;
  worktree: string;
  base: string;
}

export interface CreatePrPrompt {
  action: 'create-pr';
  /** The branch checked out in `worktree` now, perhaps the default branch. */
  branch: string;
  worktree: string;
}

/** Everything one of the six prompts needs, by action. */
export type PromptRequest = ShipPrompt | RebasePrompt | FixCiPrompt | FixCommentsPrompt | OpenPrPrompt | CreatePrPrompt;

/**
 * One review thread as a line of the Fix comments prompt.
 *
 * The thread's first comment is the request; replies are discussion Claude
 * can read on GitHub. Its body is folded onto one line so each thread stays one
 * line of the list. The id goes last because Claude needs it to reply and resolve.
 */
export function threadLine(thread: ReviewThread): string {
  const first = thread.comments[0];
  const where = thread.line === null ? thread.path : `${thread.path}:${thread.line}`;
  const author = first?.author ?? 'unknown';
  const body = (first?.body ?? '').replace(/\s+/g, ' ').trim();
  return `${where} — ${author}: ${body} (${thread.id})`;
}

/**
 * The review threads a Fix comments prompt hands over, read back from its
 * text: each thread line ends with the thread's id in brackets (`threadLine`).
 * The stored action keeps only its prompt, so this is how a queued Fix
 * comments still knows its threads after a restart.
 */
export function promptThreadIds(prompt: string): string[] {
  const ids: string[] = [];
  for (const line of prompt.split('\n')) {
    if (!line.includes(' — ')) continue;
    const match = /\(([^()\s]+)\)$/.exec(line);
    if (match && !ids.includes(match[1])) ids.push(match[1]);
  }
  return ids;
}

/** The prompt for an action, in the exact words of the epic's prompt table. */
export function renderPrompt(request: PromptRequest): string {
  switch (request.action) {
    case 'ship': {
      const { number: n, url, base, method, worktree, mainCheckout } = request;
      // A PR worked on in the main checkout has no worktree of its own to remove.
      const cleanup = worktree === mainCheckout ? '' : `remove the worktree ${worktree} if nothing else is in it, and `;
      return `Ship PR #${n} (${url}). If it is behind origin/${base}, rebase it onto origin/${base} and force-push with lease. ` +
        `Wait for CI with gh pr checks ${n} --watch. If a check fails, fix it and push, at most twice; if it still fails, stop and tell me. ` +
        `When everything is green, merge it with gh pr merge ${n} --${method} --delete-branch, ` +
        `${cleanup}pull ${base} in ${mainCheckout}.`;
    }
    case 'rebase': {
      const { number: n, headRef, base } = request;
      return `Rebase PR #${n} (${headRef}) onto origin/${base} and force-push with lease. ` +
        'Resolve conflicts if there are any; if a conflict needs a decision from me, stop and ask.';
    }
    case 'fix-ci': {
      const { number: n, url, checkName, sha, logTail, worktree, automaticAttempt } = request;
      const prompt = `CI is failing on PR #${n} (${url}): ${checkName} failed on ${sha}. Log tail:\n${logTail}\nFix it in ${worktree} and push.`;
      return automaticAttempt === undefined
        ? prompt
        : `${prompt} This is automatic attempt ${automaticAttempt} of ${MAX_AUTO_FIX_ATTEMPTS}.`;
    }
    case 'fix-comments': {
      const { number: n, url, threads, worktree } = request;
      // A thread resolved since the button was drawn has nothing left to address.
      const open = threads.filter((thread) => !thread.resolved);
      return `Address the open review threads on PR #${n} (${url}):\n${open.map(threadLine).join('\n')}\n` +
        `For each one, fix it in ${worktree}, push, then reply on the thread with what you changed and the commit, and resolve it. ` +
        'If you disagree or need my input, reply explaining why and leave it open.';
    }
    case 'open-pr': {
      const { branch, worktree, base } = request;
      return `Push ${branch} from ${worktree} and open a pull request for it against ${base}, following this repo's PR conventions.`;
    }
    case 'create-pr': {
      const { branch, worktree } = request;
      return `Commit the uncommitted changes in ${worktree}, on a new branch if ${branch} is the default branch, ` +
        "then push it and open a pull request for it, following this repo's commit and PR conventions.";
    }
  }
}
