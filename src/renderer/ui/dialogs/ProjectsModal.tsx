/**
 * The Projects modal (#171): start a session in a project, open its page, or
 * add one.
 *
 * It was the "New Session" picker. ↵ still starts a session in the
 * highlighted project, and → opens the project's page (#177), except while a
 * prompt is waiting, which leaving would lose. The rest of a project's actions sit in one ⋯ menu on
 * the highlighted row (⌘.): its settings, its GitHub page, archiving all its
 * sessions, and hiding it (or, for a remote, removing it). "Add project…" is
 * always the last row (⌘↵) and opens the add step in the same modal. Search
 * text that is a path offers to add that folder; `user@host` offers to add
 * that machine. A project added either way opens on its page.
 *
 * Filtering is fuzzy, and focus stays in the input the whole time so the user
 * can keep typing while the arrow keys move the highlight. That means the
 * selected row is state here rather than real DOM focus.
 */
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { projectLabel } from '../../features/sessions/project-label';
import { view } from '../../state/session-store';
import { useStore } from '../use-store';
import { openProjectPage, openProjectSettings } from '../project-page/actions';
import { DialogShell } from './DialogShell';
import { ProjectPickerRow } from './ProjectPickerRow';
import { AddProjectStep } from './AddProjectStep';
import { clampSelection, nextSelection, pickerKeyAction, rowMenuKeyAction } from './picker-selection';
import { classifyQuery } from './projects-query';
import { projectsRows } from './projects-rows';
import { folderSummary } from './add-project-request';
import {
  addLocalProject, archiveAllSessions, checkProjectFolder, hideProject, launchFromPicker,
  openProjectOnGitHub, removeRemoteProject,
} from './actions';
import type { JSX, KeyboardEvent, MouseEvent } from 'react';
import type { Project } from '../../../domain/project/project';
import type { ProjectFolderCheck } from '../../../domain/project/folder-check';
import type { AddStepStart } from './AddProjectStep';
import type { ProjectsQuery } from './projects-query';
import type { ProjectsRow } from './projects-rows';
import type { PickerKey } from './picker-selection';

export interface ProjectsModalProps {
  onClose(): void;
  /** The prompt a session started from here begins on. */
  initialPrompt?: string;
}

/** One entry of a row's ⋯ menu. */
interface MenuItem {
  readonly label: string;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly separatorBefore?: boolean;
  run(): void;
}

/** The open ⋯ menu: which entry the arrows are on, and where it hangs. */
interface MenuState {
  readonly item: number;
  readonly top: number;
  readonly right: number;
}

/** How long typing a path has to pause before the folder is checked. */
const CHECK_DELAY_MS = 150;

const NO_REMOTE = { user: '', host: '', port: '', dir: '' };

export function ProjectsModal({ onClose, initialPrompt }: ProjectsModalProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [addStep, setAddStep] = useState<AddStepStart | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  /** The last folder check, and the path text it answered. */
  const [folder, setFolder] = useState<{ typed: string; check: ProjectFolderCheck } | null>(null);
  /** Why adding the typed folder failed, for the path it failed on. */
  const [addError, setAddError] = useState<{ path: string; error: string } | null>(null);
  // The cached projects are not in the store (see `session-store`), so a row
  // action that changes them asks for a redraw once the reload is in.
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const activePtyIds = useStore(state => state.view.activePtyIds);

  const bodyRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  /** Set by the arrow keys: the next commit scrolls the highlight into view. Hovering does not. */
  const scrollToSelected = useRef(false);
  /** The query as it is now, for an answer that comes back after it may have changed. */
  const queryRef = useRef(query);
  queryRef.current = query;

  const trimmed = query.trim();
  const classified = classifyQuery(query);
  const rows = addStep ? [] : projectsRows(view.cachedProjects, classified);
  const count = rows.length;
  const current = clampSelection(selected, count);
  const highlightedRow = addStep ? undefined : rows[current];
  const highlighted = highlightedRow?.kind === 'project' ? highlightedRow.candidate.project : null;
  const pathTyped = classified.kind === 'path' ? classified.path : null;
  /** A prompt from Quick Ask is waiting: leaving for a page would lose it. */
  const promptWaiting = initialPrompt !== undefined;

  // The filter has the focus whenever the list is showing: on opening, and back from the add step.
  useEffect(() => {
    if (!addStep) filterRef.current?.focus();
  }, [addStep]);

  useLayoutEffect(() => {
    if (!scrollToSelected.current) return;
    scrollToSelected.current = false;
    rowRefs.current[current]?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  // A path is checked once typing pauses; a late answer for older text is dropped.
  useEffect(() => {
    if (pathTyped === null) return;
    let live = true;
    const timer = setTimeout(() => {
      void checkProjectFolder(pathTyped).then(check => { if (live) setFolder({ typed: pathTyped, check }); });
    }, CHECK_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [pathTyped]);

  const activate = (project: Project): void => {
    onClose();
    void launchFromPicker(project, initialPrompt);
  };

  /** → or Open: the project's page (a worktree's repository's); never with a prompt waiting. */
  const openPage = (project: Project): void => {
    if (promptWaiting) return;
    onClose();
    openProjectPage(project.projectPath);
  };

  // ── Adding ──

  const openAddStep = (from: ProjectsQuery): void => {
    setMenu(null);
    setAddStep(from.kind === 'ssh'
      ? { tab: 'remote', path: '', remote: { user: from.user, host: from.host, port: from.port, dir: '' } }
      : { tab: 'local', path: from.kind === 'path' ? from.path : '', remote: NO_REMOTE });
  };

  /** A project was added: its new page, in place of the modal. */
  const added = (projectPath: string): void => {
    onClose();
    openProjectPage(projectPath);
  };

  const addFolder = async (path: string): Promise<void> => {
    setAddError(null);
    const outcome = await addLocalProject(path);
    if ('error' in outcome) setAddError({ path, error: outcome.error });
    else added(outcome.projectPath);
  };

  /** Tab on a path: as far as the folders there agree. */
  const completePath = async (typed: string): Promise<void> => {
    const check = folder?.typed === typed ? folder.check : await checkProjectFolder(typed);
    if (!check.completion || queryRef.current.trim() !== typed) return;
    setQuery(check.completion);
    setSelected(0);
  };

  // ── The rows ──

  const activateRow = (row: ProjectsRow | undefined): void => {
    if (!row) return;
    switch (row.kind) {
      case 'project':
        activate(row.candidate.project);
        return;
      case 'add-folder':
        void addFolder(row.path);
        return;
      case 'add-remote':
        openAddStep({ kind: 'ssh', user: row.user, host: row.host, port: row.port });
        return;
      case 'add-project':
        openAddStep(classified);
        return;
    }
  };

  // ── The ⋯ menu ──

  const menuItems = highlighted ? rowMenu(highlighted, { close: onClose, changed: redraw }) : [];

  const openMenu = (): void => {
    const body = bodyRef.current?.getBoundingClientRect();
    const more = moreRef.current?.getBoundingClientRect();
    if (!body || !more || menuItems.length === 0) return;
    const first = menuItems.findIndex(item => !item.disabled);
    setMenu({ item: Math.max(first, 0), top: more.bottom - body.top + 4, right: body.right - more.right });
  };

  const choose = (index: number): void => {
    const item = menuItems[index];
    if (!item || item.disabled) return;
    // The menu goes as soon as something is chosen, before any confirm it asks.
    setMenu(null);
    item.run();
  };

  const stepMenu = (step: 1 | -1): void => {
    if (!menu) return;
    let next = menu.item;
    for (let i = 0; i < menuItems.length; i++) {
      next = (next + step + menuItems.length) % menuItems.length;
      if (!menuItems[next].disabled) break;
    }
    setMenu({ ...menu, item: next });
  };

  // ── The keys ──

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    const input = e.currentTarget;
    const collapsed = input.selectionStart === input.selectionEnd;
    const key: PickerKey = {
      key: e.key,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
      caretAtStart: collapsed && input.selectionStart === 0,
      caretAtEnd: collapsed && input.selectionEnd === input.value.length,
    };

    if (menu) {
      const menuAction = rowMenuKeyAction(key);
      if (!menuAction) return;
      e.preventDefault();
      // Esc closes the menu, not the modal behind it.
      e.stopPropagation();
      if (menuAction === 'up' || menuAction === 'down') stepMenu(menuAction === 'down' ? 1 : -1);
      else if (menuAction === 'choose') choose(menu.item);
      else if (menuAction === 'close') setMenu(null);
      return;
    }

    const action = pickerKeyAction('projects', key, !!highlighted && !promptWaiting, pathTyped !== null);
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
        activateRow(highlightedRow);
        return;
      case 'open-project':
        if (highlighted) openPage(highlighted);
        return;
      case 'add-project':
        openAddStep(classified);
        return;
      case 'row-menu':
        openMenu();
        return;
      case 'complete-path':
        if (pathTyped !== null) void completePath(pathTyped);
        return;
      case 'back-to-projects':
      case 'swallow':
        return;
    }
  };

  const hover = (index: number): void => {
    // With the menu open, the highlight stays on the row the menu belongs to.
    if (menu) return;
    setSelected(nextSelection(current, count, { type: 'hovered', index }));
  };

  // A press anywhere outside the menu and its ⋯ button puts the menu away.
  const onBodyMouseDown = (e: MouseEvent<HTMLDivElement>): void => {
    if (menu && !(e.target as Element).closest('.projects-menu, .projects-more')) setMenu(null);
  };

  const backFromAdd = (): void => setAddStep(null);

  const title = promptWaiting && !addStep ? 'Start this in…' : 'Projects';
  const startLabel = promptWaiting ? 'Start here' : 'New session';
  const alreadyAdded = folder !== null && view.cachedAllProjects.some(p => p.projectPath === folder.check.path);
  const hasProjectRows = rows.some(row => row.kind === 'project');

  return (
    <DialogShell
      overlayClass="add-project-overlay"
      dialogClass={'add-project-dialog project-picker-dialog' + (addStep ? ' is-adding' : '')}
      onClose={onClose}
    >
      <div className="projects-modal" ref={bodyRef} onMouseDown={onBodyMouseDown}>
        {addStep
          ? (
            <h3 className="projects-crumb">
              <button type="button" className="projects-crumb-back" title="Back (⌘[)" onClick={backFromAdd}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 6-6 6 6 6" /></svg>
                Projects
              </button>
              <span className="projects-crumb-sep" aria-hidden="true">/</span>
              <span>Add project</span>
            </h3>
          )
          : <h3>{title}</h3>}
        <kbd className="sw-kbd projects-esc" aria-hidden="true">esc</kbd>
        {addStep
          ? <AddProjectStep start={addStep} onBack={backFromAdd} onClose={onClose} onAdded={added} />
          : (
            <>
              {promptWaiting && (
                <p className="project-picker-prompt" title={initialPrompt}>“{initialPrompt}”</p>
              )}
              <input
                ref={filterRef}
                type="text"
                className={'project-picker-filter' + (pathTyped !== null ? ' is-path' : '')}
                placeholder={promptWaiting ? 'Find a project' : 'Find a project, or paste a path to add one'}
                aria-label="Filter projects"
                autoComplete="off"
                spellCheck={false}
                value={query}
                onChange={e => {
                  setQuery(e.target.value);
                  setMenu(null);
                  setSelected(nextSelection(current, count, { type: 'queried' }));
                }}
                onKeyDown={onKeyDown}
              />
              <div className="project-picker-list">
                {rows.map((row, index) => {
                  const common = {
                    ref: (el: HTMLDivElement | null) => { rowRefs.current[index] = el; },
                    selected: index === current,
                    // Keep the highlight under the pointer, so the mouse and the arrow
                    // keys never disagree about which row Enter would open.
                    onHover: () => hover(index),
                    onActivate: () => activateRow(row),
                  };
                  switch (row.kind) {
                    case 'project':
                      return (
                        <ProjectPickerRow
                          key={row.candidate.project.projectPath}
                          {...common}
                          candidate={row.candidate}
                          nested={row.nested}
                          highlight={classified.kind === 'filter' && trimmed !== ''}
                          running={row.candidate.project.sessions.filter(s => activePtyIds.has(s.sessionId)).length}
                          startLabel={startLabel}
                          onOpenProject={promptWaiting ? undefined : () => openPage(row.candidate.project)}
                          moreRef={index === current ? moreRef : undefined}
                          menuOpen={index === current && menu !== null}
                          onToggleMenu={() => (menu ? setMenu(null) : openMenu())}
                        />
                      );
                    case 'add-folder': {
                      const error = addError?.path === row.path ? addError.error : null;
                      const check = folder?.typed === row.path ? folder.check : null;
                      return (
                        <AddRow key="add-folder" {...common} className="projects-add-folder" icon={<FolderPlusIcon />}
                          title={<>Add folder <span className="projects-path">{row.path}</span></>}
                          detail={error ?? folderSummary(check, alreadyAdded)} failed={!!error} action="Add" />
                      );
                    }
                    case 'add-remote': {
                      const target = `${row.user}@${row.host}${row.port ? ':' + row.port : ''}`;
                      return (
                        <AddRow key="add-remote" {...common} className="projects-add-remote" icon={<FolderPlusIcon />}
                          title={<>Add remote <span className="projects-path">{target}</span></>}
                          detail="Opens the SSH form, filled in" action="Add" />
                      );
                    }
                    case 'add-project':
                      return (
                        <div key="add-project">
                          {!hasProjectRows && (
                            <div className="project-picker-empty">
                              {classified.kind === 'path' ? 'No projects match that path.' : 'No matching projects.'}
                            </div>
                          )}
                          <div className="projects-sep" />
                          <AddRow {...common} className="projects-add-project" icon={<PlusIcon />}
                            title="Add project…" hint="Local folder or SSH" />
                        </div>
                      );
                  }
                })}
              </div>
            </>
          )}
        <Footer
          mode={addStep ? 'add' : pathTyped !== null ? 'path' : 'projects'}
          prompt={promptWaiting}
        />
        {menu && highlighted && (
          <div className="projects-menu" role="menu" aria-label={`More for ${projectLabel(highlighted.projectPath)}`}
            style={{ top: menu.top, right: menu.right }}>
            {menuItems.map((item, index) => (
              <div key={item.label} className="projects-menu-group">
                {item.separatorBefore && <div className="projects-menu-sep" role="separator" />}
                <button
                  type="button"
                  role="menuitem"
                  className={'projects-menu-item' + (index === menu.item ? ' highlighted' : '') + (item.danger ? ' danger' : '')}
                  disabled={item.disabled}
                  onMouseDown={e => e.preventDefault()}
                  onMouseEnter={() => !item.disabled && setMenu({ ...menu, item: index })}
                  onClick={() => choose(index)}
                >
                  {item.label}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </DialogShell>
  );
}

/** The ⋯ menu for a project: what used to be the icons on every row. */
function rowMenu(project: Project, on: { close(): void; changed(): void }): MenuItem[] {
  // The cached projects are outside the store, so a change asks for a redraw.
  const redrawIfChanged = (done: Promise<boolean>): void => {
    void done.then(changed => { if (changed) on.changed(); });
  };
  const unarchived = project.sessions.filter(s => !s.archived).length;
  const archive: MenuItem = {
    label: `Archive all ${unarchived} session${unarchived === 1 ? '' : 's'}…`,
    disabled: unarchived === 0,
    run: () => redrawIfChanged(archiveAllSessions(project)),
  };

  // A remote project has no local settings or GitHub page; it is removed rather than hidden.
  if (project.remote) {
    return [
      archive,
      { label: 'Remove project', danger: true, run: () => redrawIfChanged(removeRemoteProject(project)) },
    ];
  }
  return [
    {
      label: 'Project settings',
      run: () => {
        on.close();
        openProjectSettings(project.projectPath);
      },
    },
    { label: 'Open on GitHub', run: () => openProjectOnGitHub(project) },
    { ...archive, separatorBefore: true },
    { label: 'Hide project', danger: true, run: () => redrawIfChanged(hideProject(project)) },
  ];
}

interface AddRowProps {
  ref(el: HTMLDivElement | null): void;
  className: string;
  icon: JSX.Element;
  title: JSX.Element | string;
  /** A second line under the title. */
  detail?: string;
  /** The second line says what went wrong. */
  failed?: boolean;
  /** The quiet text on the right. */
  hint?: string;
  /** The button the highlighted row shows. */
  action?: string;
  selected: boolean;
  onHover(): void;
  onActivate(): void;
}

/** A row that adds something rather than naming a project. */
function AddRow({
  ref, className, icon, title, detail, failed, hint, action, selected, onHover, onActivate,
}: AddRowProps): JSX.Element {
  return (
    <div
      ref={ref}
      className={'project-picker-row projects-add-row ' + className + (selected ? ' selected' : '')}
      onMouseEnter={onHover}
      onClick={onActivate}
    >
      <span className="projects-add-icon">{icon}</span>
      <div className="projects-add-text">
        <div className="project-picker-name">{title}</div>
        {detail && <div className={'projects-add-detail' + (failed ? ' failed' : '')}>{detail}</div>}
      </div>
      {hint && <span className="projects-add-hint">{hint}</span>}
      {selected && action && (
        <span className="projects-go">{action} <kbd className="sw-kbd" aria-hidden="true">↵</kbd></span>
      )}
    </div>
  );
}

/** The keys that work in each part of the modal. */
function Footer({ mode, prompt }: { mode: 'projects' | 'path' | 'add'; prompt: boolean }): JSX.Element {
  const key = (keys: string, what: string, off = false): JSX.Element => (
    <span key={keys} className={off ? 'is-off' : undefined} aria-disabled={off || undefined}>
      <kbd className="sw-kbd">{keys}</kbd>{what}
    </span>
  );
  switch (mode) {
    case 'add':
      return <div className="projects-footer">{key('↵', 'add')}{key('⌘[', 'back')}{key('esc', 'close')}</div>;
    case 'path':
      return <div className="projects-footer">{key('↵', 'add folder')}{key('⇥', 'complete the path')}{key('esc', 'close')}</div>;
    case 'projects':
      return (
        <div className="projects-footer">
          {key('↑↓', 'move')}
          {key('↵', prompt ? 'start with this prompt' : 'new session')}
          {/* With a prompt waiting, → would lose it: still shown, greyed and inert. */}
          {key('→', 'open project', prompt)}
          {key('⌘↵', 'add project')}
          {key('⌘.', 'more')}
        </div>
      );
  }
}

function PlusIcon(): JSX.Element {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>;
}

function FolderPlusIcon(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h9A1.5 1.5 0 0 1 21 10v8.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" />
      <path d="M12 11.5v5M9.5 14h5" />
    </svg>
  );
}
