/**
 * The project list (#249): every local repository Switchboard knows, to start
 * a task in ("Other project…", or when Ask Patch found no match) or to link it
 * to (the detail's Change repo). Typing narrows it; ↑/↓ and Enter pick, Esc
 * puts it away.
 */
import { useLayoutEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import { projectLabel } from '../../features/sessions/project-label';
import { matchesFilter } from '../project-page/page-rows';
import type { TaskRow } from '../../../domain/tasks/model';
import { closeProjectList, pickableProjects, pickProject } from './actions';

/** How many projects show before typing narrows them. */
const SHOWN = 8;

export function ProjectList({ task }: { task: TaskRow }): JSX.Element {
  const input = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState('');
  const [at, setAt] = useState(0);
  const all = useMemo(() => pickableProjects(), []);
  const shown = all.filter(path => matchesFilter(projectLabel(path) + ' ' + path, filter)).slice(0, SHOWN);

  useLayoutEffect(() => { input.current?.focus({ preventScroll: true }); }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      closeProjectList();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setAt(Math.max(0, Math.min(shown.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1))));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const path = shown[at] ?? shown[0];
      if (path) void pickProject(task, path);
    }
  };

  return (
    <div className="tk-projects" role="listbox" aria-label="Projects">
      <input
        ref={input}
        type="text"
        className="tk-projects-filter"
        placeholder="Find a project"
        aria-label="Find a project"
        value={filter}
        spellCheck={false}
        onChange={e => { setFilter(e.target.value); setAt(0); }}
        onKeyDown={onKeyDown}
      />
      {shown.length === 0 && <div className="tk-quiet">No project matches.</div>}
      {shown.map((path, i) => (
        <button
          type="button"
          key={path}
          role="option"
          aria-selected={i === at}
          className={'tk-project' + (i === at ? ' is-cursor' : '')}
          onMouseEnter={() => setAt(i)}
          onClick={() => void pickProject(task, path)}
        >
          <span className="tk-project-name">{projectLabel(path)}</span>
          <span className="tk-project-path">{path}</span>
        </button>
      ))}
    </div>
  );
}
