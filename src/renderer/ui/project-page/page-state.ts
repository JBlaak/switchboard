/**
 * Which of the project page's edge states (#175) it is in, from the
 * overview's answer: what the GitHub part has to say, and so which sections
 * show, which are left out, and what stands in their place.
 *
 * - `remote`: an ssh project. Sessions and settings only, with the host named.
 * - `loading`: no answer yet. The local Sessions show at once; the sections
 *   that wait for the answer shimmer.
 * - `none`: no GitHub remote. The GitHub sections and button are left out.
 * - `unavailable`: `gh` missing, signed out, or GitHub unreachable with
 *   nothing read before. One message in place of Plans and Pull requests.
 * - `ok`: the sections, each with one quiet line when it has nothing; `stale`
 *   when the last refresh failed and this is the answer before it, dimmed
 *   under a line saying how old it is.
 *
 * Pure, so it is tested in node.
 */
import { isRemoteProjectPath, parseRemoteProjectPath } from '../../../domain/project/remote-target';
import type { GitHubUnavailableReason, ProjectOverview } from '../../../domain/project/overview';

export type GitHubPart =
  | { readonly kind: 'remote'; readonly host: string }
  | { readonly kind: 'loading' }
  | { readonly kind: 'none' }
  | { readonly kind: 'unavailable'; readonly reason: GitHubUnavailableReason }
  | { readonly kind: 'ok'; readonly stale: boolean; readonly fetchedAt: number };

/** What the page shows of GitHub for `projectPath`, given the overview it holds (for any project). */
export function githubPart(overview: ProjectOverview | null, projectPath: string): GitHubPart {
  if (isRemoteProjectPath(projectPath)) return { kind: 'remote', host: remoteHost(projectPath) };
  const answer = overview?.projectPath === projectPath ? overview : null;
  if (!answer) return { kind: 'loading' };
  const github = answer.github;
  if (!github) return { kind: 'none' };
  if (!github.ok) return { kind: 'unavailable', reason: github.reason };
  return { kind: 'ok', stale: github.stale, fetchedAt: github.fetchedAt };
}

/** Whether the Worktrees section shows: not for a remote project, nor for one with no checkouts (not a git repository). */
export function showsWorktrees(overview: ProjectOverview | null, projectPath: string): boolean {
  if (isRemoteProjectPath(projectPath)) return false;
  const answer = overview?.projectPath === projectPath ? overview : null;
  return !answer || answer.worktrees.length > 0;
}

/** `user@host:port`, as the header names a remote project's host. */
export function remoteHost(projectPath: string): string {
  const remote = parseRemoteProjectPath(projectPath);
  return remote ? `${remote.user}@${remote.host}:${remote.port}` : projectPath.replace(/^ssh:\/\//, '');
}

/** The command that signs `gh` in, which the message shows and Copy command copies. */
export const AUTH_COMMAND = 'gh auth login';

/** The one message that stands in for Plans and Pull requests when GitHub could not be asked. */
export interface UnavailableMessage {
  readonly title: string;
  /** The line under it, before and after the command it names (none: no command). */
  readonly before: string;
  readonly command: string | null;
  readonly after: string;
}

export function unavailableMessage(reason: GitHubUnavailableReason): UnavailableMessage {
  switch (reason) {
    case 'signed-out':
      return {
        title: 'Plans, issues and pull requests come from the GitHub CLI',
        before: 'Run ', command: AUTH_COMMAND, after: ' in a terminal, then try again.',
      };
    case 'no-gh':
      return {
        title: 'Plans, issues and pull requests come from the GitHub CLI',
        before: 'Install the GitHub CLI and run ', command: AUTH_COMMAND, after: ' in a terminal, then try again.',
      };
    case 'unreachable':
      return {
        title: 'Couldn’t reach GitHub',
        before: 'The page asks again every minute.', command: null, after: '',
      };
  }
}

/** "Couldn’t reach GitHub. Showing what it said 6 minutes ago." */
export function staleLine(fetchedAt: number, now: number): string {
  return 'Couldn’t reach GitHub. Showing what it said ' + ageInWords(now - fetchedAt) + '.';
}

/** How long ago, in words: "just now", "1 minute ago", "3 hours ago", "2 days ago". */
export function ageInWords(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return plural(minutes, 'minute') + ' ago';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return plural(hours, 'hour') + ' ago';
  return plural(Math.floor(hours / 24), 'day') + ' ago';
}

function plural(count: number, noun: string): string {
  return count + ' ' + noun + (count === 1 ? '' : 's');
}
