/**
 * Picking the project to start a session in: the "New Session" dialog.
 *
 * The session list is flat, so there are no per-directory headers to hang
 * project actions off — this dialog is where they live: project settings,
 * archive-everything, remove a remote, hide a worktree.
 *
 * Filtering is fuzzy, and focus stays in the input the whole time so the user
 * can keep typing while the arrow keys move the highlight. That means the
 * selected row is state here rather than real DOM focus.
 */
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { launchClaudeSession } from '../../features/sessions/session-actions';
import { view } from '../../state/session-store';
import { useStore } from '../use-store';
import { DialogShell } from './DialogShell';
import { ProjectPickerRow } from './ProjectPickerRow';
import { rankProjects } from './rank-projects';
import { clampSelection, nextSelection } from './picker-selection';
import type { JSX, KeyboardEvent } from 'react';
import type { Project } from '../../../domain/project/project';

export interface ProjectPickerProps {
  onClose(): void;
}

export function ProjectPicker({ onClose }: ProjectPickerProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  // The cached projects are not in the store (see `session-store`), so a row
  // action that changes them asks for a redraw once the reload is in.
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const activePtyIds = useStore(state => state.view.activePtyIds);

  const filterRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  /** Set by the arrow keys: the next commit scrolls the highlight into view. Hovering does not. */
  const scrollToSelected = useRef(false);

  const trimmed = query.trim();
  const matches = rankProjects(view.cachedProjects, trimmed);
  const current = clampSelection(selected, matches.length);

  useEffect(() => {
    filterRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!scrollToSelected.current) return;
    scrollToSelected.current = false;
    rowRefs.current[current]?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  const activate = (project: Project): void => {
    onClose();
    void launchClaudeSession(project);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (matches.length === 0) return;
      scrollToSelected.current = true;
      setSelected(nextSelection(current, matches.length, { type: 'stepped', step: e.key === 'ArrowDown' ? 1 : -1 }));
      return;
    }
    if (e.key === 'Enter' && matches[current]) activate(matches[current].project);
  };

  return (
    <DialogShell
      overlayClass="add-project-overlay"
      dialogClass="add-project-dialog project-picker-dialog"
      onClose={onClose}
    >
      <h3>New Session</h3>
      <input
        ref={filterRef}
        type="text"
        className="project-picker-filter"
        placeholder="Filter projects..."
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={e => {
          setQuery(e.target.value);
          setSelected(nextSelection(current, matches.length, { type: 'queried' }));
        }}
        onKeyDown={onKeyDown}
      />
      <div className="project-picker-list">
        {matches.length === 0
          ? <div className="project-picker-empty">No matching projects.</div>
          : matches.map((candidate, index) => (
            <ProjectPickerRow
              key={candidate.project.projectPath}
              ref={el => { rowRefs.current[index] = el; }}
              candidate={candidate}
              highlight={trimmed !== ''}
              selected={index === current}
              running={candidate.project.sessions.filter(s => activePtyIds.has(s.sessionId)).length}
              // Keep the highlight under the pointer, so the mouse and the arrow
              // keys never disagree about which row Enter would open.
              onHover={() => setSelected(nextSelection(current, matches.length, { type: 'hovered', index }))}
              onActivate={() => activate(candidate.project)}
              onClose={onClose}
              onChanged={redraw}
            />
          ))}
      </div>
    </DialogShell>
  );
}
