/**
 * The project page (#173): what the main area shows while its route is a
 * project. One of the project's views at a time: the overview, one of its
 * plans (the Plan view under a breadcrumb back to the overview), or its
 * settings (#176).
 *
 * Rendered into `#project-page`, which `ui/main-area/install-main-area` shows
 * and hides with the route.
 */
import type { JSX } from 'react';
import { useStore } from '../use-store';
import { PlanPage } from '../plan-page/PlanPage';
import { ProjectOverview } from './ProjectOverview';
import { ProjectSettings } from './ProjectSettings';

export function ProjectPage(): JSX.Element | null {
  const project = useStore(state => (state.mainArea.route.kind === 'project' ? state.mainArea.route : null));
  if (!project) return null;
  switch (project.view.kind) {
    case 'overview':
      return <ProjectOverview projectPath={project.projectPath} />;
    case 'plan':
      return <PlanPage />;
    case 'settings':
      return <ProjectSettings projectPath={project.projectPath} />;
  }
}
