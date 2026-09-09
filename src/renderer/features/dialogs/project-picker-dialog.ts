/**
 * Picking the project to start a session in.
 *
 * The session list is flat, so there are no per-directory headers to hang
 * project actions off — this dialog is where they live: project settings,
 * archive-everything, remove a remote, hide a worktree.
 *
 * Filtering is fuzzy, and focus stays in the input the whole time so the user
 * can keep typing while the arrow keys move the highlight. That means the
 * selected row is tracked here rather than with real DOM focus.
 */
import { fuzzyMatch } from '../../../domain/search/fuzzy';
import { reloadProjects } from '../../app/refresh';
import { archiveAllSessions } from '../sessions/session-actions';
import { isWorktreeProject, projectLabel } from '../sessions/project-label';
import { view } from '../../state/session-store';
import { ICONS } from '../../lib/icons';
import { openSettingsViewer } from '../settings/settings-panel';
import { openDialog, setTooltip } from './dialog-shell';
import { showNewSessionPopover } from './new-session-popover';
import type { Project } from '../../../domain/project/project';

const CLOSE_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

/** One filtered project, with what the ranking used to get there. */
interface Candidate {
  project: Project;
  label: string;
  /** The short label matched, rather than only the full path. */
  onLabel: boolean;
  score: number;
  positions: number[];
}

interface Row {
  element: HTMLElement;
  activate(options?: { keyboard?: boolean }): void;
}

export function showProjectPickerDialog(): void {
  const handle = openDialog({
    overlayClass: 'add-project-overlay',
    dialogClass: 'add-project-dialog project-picker-dialog',
    html: `
      <h3>New Session</h3>
      <input type="text" class="project-picker-filter" placeholder="Filter projects..." autocomplete="off" spellcheck="false">
      <div class="project-picker-list"></div>
    `,
  });

  const filterInput = handle.field<HTMLInputElement>('.project-picker-filter');
  const listEl = handle.field('.project-picker-list');

  let rows: Row[] = [];
  let selected = 0;

  const setSelected = (index: number, { scroll = true } = {}): void => {
    if (rows.length === 0) {
      selected = 0;
      return;
    }
    selected = Math.max(0, Math.min(index, rows.length - 1));
    rows.forEach((row, i) => row.element.classList.toggle('selected', i === selected));
    if (scroll) rows[selected].element.scrollIntoView({ block: 'nearest' });
  };

  function render(): void {
    const query = filterInput.value.trim();
    const matches = rank(query);

    listEl.innerHTML = '';
    rows = [];

    if (matches.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'project-picker-empty';
      empty.textContent = 'No matching projects.';
      listEl.appendChild(empty);
      return;
    }

    for (const candidate of matches) {
      const row = buildRow(candidate, query, handle.close, render);
      const index = rows.length;
      // Keep the highlight under the pointer, so the mouse and the arrow keys
      // never disagree about which row Enter would open.
      row.element.addEventListener('mouseenter', () => setSelected(index, { scroll: false }));
      rows.push(row);
      listEl.appendChild(row.element);
    }

    setSelected(selected, { scroll: false });
  }

  filterInput.addEventListener('input', () => {
    // A new query reorders everything, so start from the best match again.
    selected = 0;
    render();
  });

  filterInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (rows.length === 0) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setSelected((selected + step + rows.length) % rows.length);
      return;
    }
    if (e.key === 'Enter') rows[selected]?.activate({ keyboard: true });
  });

  render();
  filterInput.focus();
}

/**
 * Rank the projects against the query.
 *
 * Anything the *label* matched comes first, however well a long path happened
 * to score — "sb" means switchboard, not the /Users/…/website whose path
 * happens to contain an s before a b. Then best score, then most recent.
 */
function rank(query: string): Candidate[] {
  const matches: Candidate[] = [];

  for (const project of view.cachedProjects) {
    const label = projectLabel(project.projectPath);
    const labelMatch = fuzzyMatch(query, label);
    const match = labelMatch || fuzzyMatch(query, project.projectPath);
    if (!match) continue;
    matches.push({
      project,
      label,
      onLabel: !!labelMatch,
      score: match.score,
      positions: labelMatch ? match.positions : [],
    });
  }

  matches.sort((a, b) =>
    (Number(b.onLabel) - Number(a.onLabel))
    || (b.score - a.score)
    || (lastActivity(b.project) - lastActivity(a.project)));

  return matches;
}

function lastActivity(project: Project): number {
  let newest = 0;
  for (const session of project.sessions) {
    const at = new Date(session.modified).getTime();
    if (at > newest) newest = at;
  }
  return newest;
}

function buildRow(
  { project, label, positions }: Candidate,
  query: string,
  close: () => void,
  rerender: () => void,
): Row {
  const element = document.createElement('div');
  element.className = 'project-picker-row';

  const name = document.createElement('div');
  name.className = 'project-picker-name';
  paintLabel(name, label, query ? positions : null);
  name.title = project.projectPath;
  if (project.remote) {
    const badge = document.createElement('span');
    badge.className = 'remote-badge';
    badge.textContent = 'SSH';
    name.appendChild(badge);
  }

  const count = document.createElement('span');
  count.className = 'project-picker-count';
  const live = project.sessions.filter(s => view.activePtyIds.has(s.sessionId)).length;
  const total = project.sessions.length;
  count.textContent = live > 0 ? `${live} running` : `${total} session${total === 1 ? '' : 's'}`;
  if (live > 0) count.classList.add('running');

  element.append(name, count, buildActions(project, close, rerender));

  const activate = ({ keyboard = false } = {}): void => {
    // Capture the anchor rect before closing — the row is detached by then, and
    // a detached element measures as 0x0 at the top-left corner.
    const rect = element.getBoundingClientRect();
    close();
    showNewSessionPopover(project, { getBoundingClientRect: () => rect }, { keyboard });
  };
  element.onclick = () => activate();

  return { element, activate };
}

function buildActions(project: Project, close: () => void, rerender: () => void): HTMLElement {
  const actions = document.createElement('div');
  actions.className = 'project-picker-actions';

  const button = (className: string, tooltip: string, html: string, onClick: (e: MouseEvent) => void): HTMLButtonElement => {
    const el = document.createElement('button');
    el.className = className;
    el.innerHTML = html;
    setTooltip(el, tooltip);
    el.onclick = (e: MouseEvent) => {
      e.stopPropagation();
      onClick(e);
    };
    return el;
  };

  if (project.remote) {
    // A remote project has no local settings to edit; it gets a remove button
    // instead, since it lives in settings and nothing else offers removal.
    actions.appendChild(button('picker-remove-btn', 'Remove remote project', CLOSE_ICON, () => {
      const message = `Remove ${projectLabel(project.projectPath)}?\n\n`
        + 'This disconnects open connections. tmux sessions on the remote machine keep running.';
      if (!confirm(message)) return;
      void window.api.removeRemoteProject(project.projectPath)
        .then(() => reloadProjects())
        .then(rerender);
    }));
  } else {
    actions.appendChild(button('picker-settings-btn', 'Project settings', ICONS.gear(16), () => {
      close();
      void openSettingsViewer('project', project.projectPath);
    }));
  }

  actions.appendChild(button(
    'picker-archive-btn', 'Archive all sessions in this project', ICONS.archive(18),
    () => void archiveAllSessions(project, rerender)));

  if (isWorktreeProject(project.projectPath)) {
    actions.appendChild(button('picker-hide-btn', 'Hide worktree', CLOSE_ICON, () => {
      const name = project.projectPath.split('/').pop();
      if (!confirm(`Hide worktree "${name}"?\n\nSession files are not deleted.`)) return;
      void window.api.removeProject(project.projectPath)
        .then(() => reloadProjects())
        .then(rerender);
    }));
  }

  return actions;
}

/**
 * Paint the label with the fuzzy-matched characters picked out.
 *
 * Runs are coalesced, so a contiguous match is one span rather than one per
 * character.
 */
function paintLabel(el: HTMLElement, label: string, positions: number[] | null): void {
  el.textContent = '';
  if (!positions || positions.length === 0) {
    el.textContent = label;
    return;
  }

  const matched = new Set(positions);
  let i = 0;
  while (i < label.length) {
    const isMatch = matched.has(i);
    let j = i + 1;
    while (j < label.length && matched.has(j) === isMatch) j++;
    const part = label.slice(i, j);
    if (isMatch) {
      const mark = document.createElement('span');
      mark.className = 'project-picker-match';
      mark.textContent = part;
      el.appendChild(mark);
    } else {
      el.appendChild(document.createTextNode(part));
    }
    i = j;
  }
}
