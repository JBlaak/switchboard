/**
 * The project page's places for what GitHub knows about the project (#167):
 * empty until the project overview (#172) is there to fill them.
 *
 * - `PlansSection`, the plans and the issues outside them: #174.
 * - `PullRequestsSection` and `WorktreesSection`: #175.
 *
 * The route `project → settings` (#176) is `ProjectSettings`.
 *
 * Each renders nothing for now, so the page shows only what the renderer
 * already has. Their props are what the page gives each of them; the overview
 * itself is for them to read from the store once #172 puts it there.
 */
import type { JSX } from 'react';

export interface SectionProps {
  /** The repository the page is for (never a worktree). */
  readonly projectPath: string;
}

/** Plans & issues, at the top of the left column (#174). */
export function PlansSection(_props: SectionProps): JSX.Element | null {
  return null;
}

/** Pull requests, under the plans in the left column (#175). */
export function PullRequestsSection(_props: SectionProps): JSX.Element | null {
  return null;
}

/** Worktrees, under the sessions in the right column (#175). */
export function WorktreesSection(_props: SectionProps): JSX.Element | null {
  return null;
}
