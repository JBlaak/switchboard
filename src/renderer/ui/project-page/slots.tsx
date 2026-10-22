/**
 * What the project page gives each of its sections (#167).
 *
 * The sections themselves live in their own files: `PlansSection.tsx` (#174),
 * `PullRequestsSection.tsx` and `WorktreesSection.tsx` (#175); the settings
 * view is `ProjectSettings.tsx` (#176).
 */

export interface SectionProps {
  /** The repository the page is for (never a worktree). */
  readonly projectPath: string;
}
