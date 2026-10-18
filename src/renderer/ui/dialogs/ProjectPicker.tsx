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
 *
 * It also finds a plan again (F1, F3): → or Tab on a project that can have
 * plans lists them, the filter then matching titles and `#number`; ← or
 * Shift-Tab goes back. Picking a plan opens it in the main area without a
 * session (F2).
 */
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { projectLabel } from '../../features/sessions/project-label';
import { view } from '../../state/session-store';
import { useStore } from '../use-store';
import { openPlanPage } from '../plan-page/actions';
import { DialogShell } from './DialogShell';
import { ProjectPickerRow } from './ProjectPickerRow';
import { PickerPlans } from './PickerPlans';
import { rankProjects } from './rank-projects';
import { clampSelection, nextSelection, pickerKeyAction } from './picker-selection';
import { filterPlans, orderPlans } from './plan-list';
import { recentPlansIn } from './recent-plans';
import { askProjectPlans, canHavePlans, launchFromPicker } from './actions';
import type { JSX, KeyboardEvent } from 'react';
import type { Project } from '../../../domain/project/project';
import type { PickerPlansState, PlanPickerItem } from './PickerPlans';

export interface ProjectPickerProps {
  onClose(): void;
  /** The prompt a session started from here begins on. */
  initialPrompt?: string;
}

/** The plans of the project → was pressed on, and the project list to go back to. */
interface PlansMode {
  readonly project: Project;
  /** The project filter and highlight as they were, for ←. */
  readonly projectQuery: string;
  readonly projectSelected: number;
}

export function ProjectPicker({ onClose, initialPrompt }: ProjectPickerProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [plansMode, setPlansMode] = useState<PlansMode | null>(null);
  const [plans, setPlans] = useState<PickerPlansState>({ phase: 'loading' });
  // The cached projects are not in the store (see `session-store`), so a row
  // action that changes them asks for a redraw once the reload is in.
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const activePtyIds = useStore(state => state.view.activePtyIds);

  const filterRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  /** Set by the arrow keys: the next commit scrolls the highlight into view. Hovering does not. */
  const scrollToSelected = useRef(false);
  /** Bumped on every → and ←, so a late answer for a project left behind is dropped. */
  const asked = useRef(0);

  const trimmed = query.trim();
  const matches = plansMode ? [] : rankProjects(view.cachedProjects, trimmed);
  const planItems = plansMode ? planPickerItems(plans, plansMode.project, trimmed) : [];
  const count = plansMode ? planItems.length : matches.length;
  const current = clampSelection(selected, count);

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
    void launchFromPicker(project, initialPrompt);
  };

  const intoPlans = (project: Project): void => {
    const token = ++asked.current;
    setPlansMode({ project, projectQuery: query, projectSelected: current });
    setPlans({ phase: 'loading' });
    setQuery('');
    setSelected(0);
    filterRef.current?.focus();
    void askProjectPlans(project, false).then(answer => {
      if (token !== asked.current) return;
      setPlans('plans' in answer
        ? { phase: 'loaded', open: answer.plans, closed: null, closedLoading: false }
        : { phase: 'unavailable', reason: answer.reason });
      // A project that turned out to have none loses its cue; redraw the rows behind.
      if (!('plans' in answer)) redraw();
    });
  };

  const backToProjects = (): void => {
    if (!plansMode) return;
    asked.current++;
    setQuery(plansMode.projectQuery);
    setSelected(plansMode.projectSelected);
    setPlansMode(null);
    filterRef.current?.focus();
  };

  const showClosed = (): void => {
    if (!plansMode || plans.phase !== 'loaded' || plans.closed || plans.closedLoading) return;
    const token = asked.current;
    setPlans({ ...plans, closedLoading: true });
    // `closed: true` answers the open plans and the closed ones together.
    void askProjectPlans(plansMode.project, true).then(answer => {
      if (token !== asked.current) return;
      setPlans(was => was.phase !== 'loaded' ? was : 'plans' in answer
        ? { ...was, closed: answer.plans.filter(plan => plan.state === 'closed'), closedLoading: false }
        : { ...was, closed: [], closedLoading: false });
    });
  };

  const activatePlanItem = (index: number): void => {
    const item = planItems[index];
    if (!item || !plansMode) return;
    if (item.kind === 'show-closed') {
      showClosed();
      return;
    }
    onClose();
    openPlanPage({ projectPath: plansMode.project.projectPath, repository: item.plan.repository, number: item.plan.number });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    const input = e.currentTarget;
    const collapsed = input.selectionStart === input.selectionEnd;
    const highlighted = plansMode ? null : matches[current]?.project ?? null;
    const action = pickerKeyAction(plansMode ? 'plans' : 'projects', {
      key: e.key,
      shiftKey: e.shiftKey,
      caretAtStart: collapsed && input.selectionStart === 0,
      caretAtEnd: collapsed && input.selectionEnd === input.value.length,
    }, !!highlighted && canHavePlans(highlighted));
    if (!action) return;
    e.preventDefault();
    switch (action) {
      case 'up':
      case 'down':
        if (count === 0) return;
        scrollToSelected.current = true;
        setSelected(nextSelection(current, count, { type: 'stepped', step: action === 'down' ? 1 : -1 }));
        return;
      case 'open':
        if (plansMode) activatePlanItem(current);
        else if (highlighted) activate(highlighted);
        return;
      case 'into-plans':
        if (highlighted) intoPlans(highlighted);
        return;
      case 'back-to-projects':
        backToProjects();
        return;
      case 'swallow':
        return;
    }
  };

  const hover = (index: number): void => setSelected(nextSelection(current, count, { type: 'hovered', index }));

  return (
    <DialogShell
      overlayClass="add-project-overlay"
      dialogClass={'add-project-dialog project-picker-dialog' + (plansMode ? ' is-plans' : '')}
      onClose={onClose}
    >
      <h3>New Session</h3>
      {initialPrompt !== undefined && !plansMode && (
        <p className="project-picker-prompt" title={initialPrompt}>{initialPrompt}</p>
      )}
      <div className="project-picker-search">
        {plansMode && (
          <button type="button" className="project-picker-back" aria-label="Back to projects" onClick={backToProjects}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M10 3 5 8l5 5" /></svg>
            <span>{projectLabel(plansMode.project.projectPath)}</span>
          </button>
        )}
        <input
          ref={filterRef}
          type="text"
          className="project-picker-filter"
          placeholder={plansMode ? 'Filter plans by title or #number' : 'Filter projects...'}
          aria-label={plansMode ? 'Filter plans' : 'Filter projects'}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={e => {
            setQuery(e.target.value);
            setSelected(nextSelection(current, count, { type: 'queried' }));
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="project-picker-list" role={plansMode ? 'listbox' : undefined} aria-label={plansMode ? 'Plans' : undefined}>
        {plansMode
          ? (
            <PickerPlans
              state={plans}
              items={planItems}
              selected={current}
              filtered={trimmed !== ''}
              rowRef={index => (el) => { rowRefs.current[index] = el; }}
              onHover={hover}
              onActivate={activatePlanItem}
            />
          )
          : matches.length === 0
            ? <div className="project-picker-empty">No matching projects.</div>
            : matches.map((candidate, index) => (
              <ProjectPickerRow
                key={candidate.project.projectPath}
                ref={el => { rowRefs.current[index] = el; }}
                candidate={candidate}
                highlight={trimmed !== ''}
                selected={index === current}
                running={candidate.project.sessions.filter(s => activePtyIds.has(s.sessionId)).length}
                onOpenPlans={canHavePlans(candidate.project) ? () => intoPlans(candidate.project) : undefined}
                // Keep the highlight under the pointer, so the mouse and the arrow
                // keys never disagree about which row Enter would open.
                onHover={() => hover(index)}
                onActivate={() => activate(candidate.project)}
                onClose={onClose}
                onChanged={redraw}
              />
            ))}
      </div>
      {plansMode && (
        <div className="plan-picker-footer">
          <span><kbd className="sw-kbd">↵</kbd>open plan</span>
          <span><kbd className="sw-kbd">←</kbd>projects</span>
          <span><kbd className="sw-kbd">↑</kbd><kbd className="sw-kbd">↓</kbd>move</span>
          <span className="plan-picker-gap" />
          <span>Opens the plan without starting a session</span>
        </div>
      )}
    </DialogShell>
  );
}

/** The plan list's rows: the open plans in order, then the closed ones, or Show closed (F1, F3). */
function planPickerItems(state: PickerPlansState, project: Project, query: string): PlanPickerItem[] {
  if (state.phase !== 'loaded') return [];
  const recent = recentPlansIn(project.projectPath);
  const open = filterPlans(orderPlans(state.open, recent), query);
  const items: PlanPickerItem[] = open.map(plan => ({ kind: 'plan', plan }));
  if (state.closed) {
    for (const plan of filterPlans(orderPlans(state.closed, recent), query)) items.push({ kind: 'plan', plan });
  } else {
    items.push({ kind: 'show-closed' });
  }
  return items;
}
