/**
 * One project in the picker: its name with the matched characters picked out,
 * how many sessions it has or has running, and its actions.
 *
 * The actions never open the row: each stops its click from reaching it.
 */
import { ICONS } from '../../lib/icons';
import { isWorktreeProject } from '../../features/sessions/project-label';
import { openSettings } from '../settings/actions';
import { archiveAllSessions, hideWorktree, removeRemoteProject } from './actions';
import { tooltip } from './DialogShell';
import { labelRuns } from './rank-projects';
import { sessionCountLabel } from './picker-selection';
import type { JSX, MouseEvent, Ref } from 'react';
import type { Candidate } from './rank-projects';
import type { Project } from '../../../domain/project/project';

const CLOSE_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

export interface ProjectPickerRowProps {
  ref?: Ref<HTMLDivElement>;
  candidate: Candidate;
  /** Pick out the matched characters; off while the filter is empty. */
  highlight: boolean;
  selected: boolean;
  /** How many of its sessions have a live PTY. */
  running: number;
  onHover(): void;
  onActivate(): void;
  /** Close the picker, for an action that leads somewhere else. */
  onClose(): void;
  /** An action changed the project list; the picker redraws. */
  onChanged(): void;
}

export function ProjectPickerRow({
  ref, candidate, highlight, selected, running, onHover, onActivate, onClose, onChanged,
}: ProjectPickerRowProps): JSX.Element {
  const { project, label, positions } = candidate;
  const total = project.sessions.length;

  return (
    <div
      ref={ref}
      className={'project-picker-row' + (selected ? ' selected' : '')}
      onMouseEnter={onHover}
      onClick={onActivate}
    >
      <div className="project-picker-name" title={project.projectPath}>
        {labelRuns(label, highlight ? positions : []).map((run, i) => run.matched
          ? <span key={i} className="project-picker-match">{run.text}</span>
          : run.text)}
        {project.remote && <span className="remote-badge">SSH</span>}
      </div>
      <span className={'project-picker-count' + (running > 0 ? ' running' : '')}>
        {sessionCountLabel(total, running)}
      </span>
      <RowActions project={project} onClose={onClose} onChanged={onChanged} />
    </div>
  );
}

interface RowActionsProps {
  project: Project;
  onClose(): void;
  onChanged(): void;
}

function RowActions({ project, onClose, onChanged }: RowActionsProps): JSX.Element {
  const redrawIfChanged = (done: Promise<boolean>): void => {
    void done.then(changed => { if (changed) onChanged(); });
  };

  return (
    <div className="project-picker-actions">
      {project.remote
        // A remote project has no local settings to edit; it gets a remove
        // button instead, since it lives in settings and nothing else offers
        // removal.
        ? <ActionButton className="picker-remove-btn" label="Remove remote project" icon={CLOSE_ICON}
            onClick={() => redrawIfChanged(removeRemoteProject(project))} />
        : <ActionButton className="picker-settings-btn" label="Project settings" icon={ICONS.gear(16)}
            onClick={() => {
              onClose();
              void openSettings('project', project.projectPath);
            }} />}
      <ActionButton className="picker-archive-btn" label="Archive all sessions in this project"
        icon={ICONS.archive(18)} onClick={() => redrawIfChanged(archiveAllSessions(project))} />
      {isWorktreeProject(project.projectPath) && (
        <ActionButton className="picker-hide-btn" label="Hide worktree" icon={CLOSE_ICON}
          onClick={() => redrawIfChanged(hideWorktree(project))} />
      )}
    </div>
  );
}

interface ActionButtonProps {
  className: string;
  label: string;
  /** Trusted markup from `lib/icons`, or the close glyph above. */
  icon: string;
  onClick(): void;
}

function ActionButton({ className, label, icon, onClick }: ActionButtonProps): JSX.Element {
  return (
    <button
      className={className}
      {...tooltip(label)}
      dangerouslySetInnerHTML={{ __html: icon }}
      onClick={(e: MouseEvent) => {
        e.stopPropagation();
        onClick();
      }}
    />
  );
}
