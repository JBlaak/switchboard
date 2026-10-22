/**
 * The project page's overview (#173): the header, and the body's two columns,
 * the sections on the left and a 340 px column on the right.
 *
 * Only the Sessions section has its data yet, from the cached projects; the
 * others are slots (`slots.tsx`) that the project overview (#172) fills.
 * Esc closes the page, back to the session it covered, focused.
 */
import { useLayoutEffect, useRef } from 'react';
import type { JSX, KeyboardEvent } from 'react';
import { projectLabel } from '../../features/sessions/project-label';
import { ProjectHeader } from './ProjectHeader';
import { SessionsSection } from './SessionsSection';
import { PlansSection, PullRequestsSection, WorktreesSection } from './slots';
import { closeProject } from './actions';

export function ProjectOverview({ projectPath }: { projectPath: string }): JSX.Element {
  const root = useRef<HTMLDivElement>(null);

  // Into the page as it opens, so Esc reaches it without a click.
  useLayoutEffect(() => {
    root.current?.focus({ preventScroll: true });
  }, [projectPath]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if ((e.target as HTMLElement).matches('input, textarea, select, [contenteditable="true"]')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeProject();
    }
  };

  return (
    <div
      ref={root}
      className="sw-page project-page"
      tabIndex={-1}
      role="region"
      aria-label={'Project ' + projectLabel(projectPath)}
      onKeyDown={onKeyDown}
    >
      <ProjectHeader projectPath={projectPath} />
      <div className="pp-body">
        <div className="pp-column">
          <PlansSection projectPath={projectPath} />
          <PullRequestsSection projectPath={projectPath} />
        </div>
        <div className="pp-column pp-side">
          <SessionsSection projectPath={projectPath} />
          <WorktreesSection projectPath={projectPath} />
        </div>
      </div>
    </div>
  );
}
