/**
 * The project page's header (#173): Close, the project's name and where it
 * is, and the GitHub, Settings and New session buttons.
 *
 * The subline has the path for now. The GitHub repository, the current branch
 * and "Updated …" come from the project overview (#172) and join it there; a
 * remote project, which has no GitHub, shows no GitHub button.
 */
import type { JSX } from 'react';
import { projectLabel } from '../../features/sessions/project-label';
import {
  closeProject, isRemoteProject, openProjectOnGitHub, openProjectSettings, startProjectSession,
} from './actions';

export function ProjectHeader({ projectPath }: { projectPath: string }): JSX.Element {
  const remote = isRemoteProject(projectPath);
  return (
    <header className="sw-header pp-header">
      <div className="sw-header-row">
        <button type="button" className="sw-btn sw-back" onClick={closeProject} aria-label="Close project (Esc)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
          Close <kbd className="sw-kbd">esc</kbd>
        </button>
        <div className="sw-heading">
          <h1 className="sw-title pp-title">{projectLabel(projectPath)}</h1>
          <div className="sw-subline">
            <span className="pp-path">{projectPath}</span>
          </div>
        </div>
        <div className="pp-header-actions">
          {!remote && (
            <button type="button" className="sw-btn" onClick={() => openProjectOnGitHub(projectPath)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
              </svg>
              GitHub
            </button>
          )}
          <button type="button" className="sw-btn" onClick={() => openProjectSettings(projectPath)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12" />
              <circle cx="16" cy="6" r="2" />
              <circle cx="10" cy="12" r="2" />
              <circle cx="18" cy="18" r="2" />
            </svg>
            Settings
          </button>
          <button type="button" className="sw-btn is-primary" onClick={() => startProjectSession(projectPath)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            New session
          </button>
        </div>
      </div>
    </header>
  );
}
