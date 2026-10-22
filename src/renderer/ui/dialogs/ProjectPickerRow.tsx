/**
 * One project in the Projects modal: its name with the matched characters
 * picked out, how many sessions it has or has running, and, on the
 * highlighted row only, its buttons: start a session, the → into its plans,
 * and the ⋯ menu that holds the rest (#171).
 *
 * The buttons never open the row: each stops its click from reaching it, and
 * none takes the focus from the filter.
 */
import { isWorktreeProject } from '../../features/sessions/project-label';
import { labelRuns } from './rank-projects';
import { sessionCountLabel } from './picker-selection';
import type { JSX, MouseEvent, ReactNode, Ref } from 'react';
import type { Candidate } from './rank-projects';

export interface ProjectPickerRowProps {
  ref?: Ref<HTMLDivElement>;
  candidate: Candidate;
  /** A worktree listed under its repository. */
  nested: boolean;
  /** Pick out the matched characters; off while the filter is empty. */
  highlight: boolean;
  selected: boolean;
  /** How many of its sessions have a live PTY. */
  running: number;
  /** What ↵ does here: "New session", or "Start here" with a prompt waiting. */
  startLabel: string;
  /** Opens its plans (F1); absent for a project that cannot have any, which shows no → cue. */
  onOpenPlans?(): void;
  /** The ⋯ button, for the menu to hang off. */
  moreRef?: Ref<HTMLButtonElement>;
  menuOpen: boolean;
  onToggleMenu(): void;
  onHover(): void;
  onActivate(): void;
}

export function ProjectPickerRow({
  ref, candidate, nested, highlight, selected, running, startLabel, onOpenPlans, moreRef, menuOpen,
  onToggleMenu, onHover, onActivate,
}: ProjectPickerRowProps): JSX.Element {
  const { project, label, positions } = candidate;
  const total = project.sessions.length;

  return (
    <div
      ref={ref}
      className={'project-picker-row' + (selected ? ' selected' : '') + (nested ? ' nested' : '')}
      onMouseEnter={onHover}
      onClick={onActivate}
    >
      <div className="project-picker-name" title={project.projectPath}>
        {labelRuns(label, highlight ? positions : []).map((run, i) => run.matched
          ? <span key={i} className="project-picker-match">{run.text}</span>
          : run.text)}
        {project.remote && <span className="remote-badge">SSH</span>}
      </div>
      {isWorktreeProject(project.projectPath) && <span className="worktree-badge">WORKTREE</span>}
      <span className={'project-picker-count' + (running > 0 ? ' running' : '')}>
        {sessionCountLabel(total, running)}
      </span>
      {selected && (
        <>
          <RowButton className="projects-go" onClick={onActivate}>
            {startLabel} <kbd className="sw-kbd" aria-hidden="true">↵</kbd>
          </RowButton>
          {onOpenPlans && (
            <RowButton className="project-picker-plans-cue" label="Show plans" title="Plans (→ or Tab)" onClick={onOpenPlans}>
              →
            </RowButton>
          )}
          <RowButton
            ref={moreRef}
            className={'projects-more' + (menuOpen ? ' open' : '')}
            label={`More for ${label}`}
            title="More (⌘.)"
            expanded={menuOpen}
            onClick={onToggleMenu}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
          </RowButton>
        </>
      )}
    </div>
  );
}

interface RowButtonProps {
  ref?: Ref<HTMLButtonElement>;
  className: string;
  label?: string;
  title?: string;
  expanded?: boolean;
  onClick(): void;
  children: ReactNode;
}

/** A button on the row that keeps the focus in the filter and the click off the row. */
function RowButton({ ref, className, label, title, expanded, onClick, children }: RowButtonProps): JSX.Element {
  return (
    <button
      ref={ref}
      type="button"
      className={className}
      aria-label={label}
      aria-haspopup={expanded === undefined ? undefined : 'menu'}
      aria-expanded={expanded}
      title={title}
      onMouseDown={(e: MouseEvent) => e.preventDefault()}
      onClick={(e: MouseEvent) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}
