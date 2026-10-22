/**
 * The project page's places still to be filled (#167).
 *
 * The sections that read the project overview (#172) live in their own files:
 * `PlansSection.tsx` (#174), `PullRequestsSection.tsx` and
 * `WorktreesSection.tsx` (#175).
 *
 * - `ProjectSettingsSlot`, the route `project → settings`: #176. Until then
 *   the header's Settings button opens the settings panel instead, so nothing
 *   routes here yet.
 */
import type { JSX } from 'react';

export interface SectionProps {
  /** The repository the page is for (never a worktree). */
  readonly projectPath: string;
}

/** The project's settings, as the page's `settings` view (#176). */
export function ProjectSettingsSlot(_props: SectionProps): JSX.Element | null {
  return null;
}
