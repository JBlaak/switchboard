/**
 * The memory tab: every file that instructs Claude, grouped by project.
 *
 * Editable in place, like the plans tab — these are the files the user writes to
 * change how Claude behaves, so being able to fix one without leaving the app
 * is the whole feature.
 *
 * Schedule files get one extra affordance: a run-now button, because a cron
 * expression is hard to trust until you have seen the task work once.
 */
import { memoryContent } from '../../lib/dom';
import { formatDate } from '../../lib/format';
import { ICONS } from '../../lib/icons';
import { memoryPanel } from '../panel/panels';
import { showViewer } from '../panel/viewers';
import type { AgentFile, AgentFileIndex } from '../../../domain/agent-files/agent-file';

/** How long the run-now button shows its confirmation before resetting. */
const RUN_FEEDBACK_MS = 2000;

const SVG = {
  brain: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/><path d="M17.599 6.5a3 3 0 0 0 .399-1.375"/><path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/><path d="M3.477 10.896a4 4 0 0 1 .585-.396"/><path d="M19.938 10.5a4 4 0 0 1 .585.396"/><path d="M6 18a4 4 0 0 1-1.967-.516"/><path d="M19.967 17.484A4 4 0 0 1 18 18"/></svg>',
  play: '<svg width="12" height="12" viewBox="0 0 384 512" fill="currentColor" stroke="currentColor" stroke-width="0"><path d="M73 39c-14.8-9.1-33.4-9.4-48.5-.9S0 62.6 0 80L0 432c0 17.4 9.4 33.4 24.5 41.9s33.7 8.1 48.5-.9L361 297c14.3-8.7 23-24.2 23-41s-8.7-32.2-23-41L73 39z"></path></svg>',
  spinner: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>',
  check: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
};

/** The label the user's own `~/.claude` group is shown under. */
const GLOBAL_GROUP_KEY = '__global__';

let index: AgentFileIndex = { global: { files: [] }, projects: [] };

/**
 * Which groups the user collapsed.
 *
 * Kept in memory rather than persisted: it is per-visit state, and the tab is
 * rebuilt from scratch every time it opens.
 */
const collapsed = new Map<string, boolean>();

export async function loadMemories(): Promise<void> {
  index = await window.api.getMemories();
  renderMemories();
}

/** Draw the tab, optionally narrowed to the paths a search matched. */
export function renderMemories(matchedPaths?: Set<string> | null): void {
  memoryContent.innerHTML = '';

  const total = index.global.files.length
    + index.projects.reduce((n, p) => n + p.files.length, 0);
  if (total === 0) {
    const empty = document.createElement('div');
    empty.className = 'plans-empty';
    empty.textContent = 'No memory files found.';
    memoryContent.appendChild(empty);
    return;
  }

  const narrow = (files: readonly AgentFile[]): AgentFile[] =>
    matchedPaths ? files.filter(f => matchedPaths.has(f.filePath)) : [...files];

  const globalFiles = narrow(index.global.files);
  if (globalFiles.length) {
    memoryContent.appendChild(buildGroup(GLOBAL_GROUP_KEY, 'Global', globalFiles));
  }

  for (const project of index.projects) {
    const files = narrow(project.files);
    if (files.length === 0) continue;
    memoryContent.appendChild(buildGroup(project.folder, project.shortName, files));
  }
}

function buildGroup(key: string, label: string, files: readonly AgentFile[]): HTMLElement {
  const group = document.createElement('div');
  group.className = 'project-group';
  // Expanded by default: the point of the tab is to see what is there.
  if (collapsed.get(key) === true) group.classList.add('collapsed');

  const header = document.createElement('div');
  header.className = 'project-header';

  const arrow = document.createElement('span');
  arrow.className = 'arrow';
  arrow.innerHTML = '&#9660;';

  const name = document.createElement('span');
  name.className = 'project-name';
  name.textContent = label;

  const count = document.createElement('span');
  count.className = 'memory-file-count';
  count.textContent = String(files.length);

  header.append(arrow, name, count);
  header.addEventListener('click', () => {
    const nowCollapsed = !group.classList.contains('collapsed');
    group.classList.toggle('collapsed');
    collapsed.set(key, nowCollapsed);
  });

  const list = document.createElement('div');
  list.className = 'project-sessions';
  for (const file of files) list.appendChild(buildFileItem(file));

  group.append(header, list);
  return group;
}

function buildFileItem(file: AgentFile): HTMLElement {
  const isSchedule = file.filename.startsWith('schedule-');

  const item = document.createElement('div');
  item.className = 'session-item memory-item';
  item.dataset.filepath = file.filePath;

  const icon = document.createElement('span');
  icon.className = isSchedule ? 'memory-schedule-icon' : 'memory-brain-icon';
  icon.innerHTML = isSchedule ? ICONS.schedule(15) : SVG.brain;

  const info = document.createElement('div');
  info.className = 'session-info';

  const title = document.createElement('div');
  title.className = 'session-summary';
  title.textContent = file.filename;

  const path = document.createElement('div');
  path.className = 'session-id';
  path.textContent = file.displayPath ?? '';

  const meta = document.createElement('div');
  meta.className = 'session-meta';
  meta.textContent = formatDate(new Date(file.modified));

  info.append(title, path, meta);

  const row = document.createElement('div');
  row.className = 'session-row';
  row.append(icon, info);
  if (isSchedule) row.appendChild(buildRunNowButton(file));

  item.appendChild(row);
  item.addEventListener('click', () => void openFile(file));
  return item;
}

/**
 * The run-now button for a schedule.
 *
 * A scheduled run is headless and produces no window, so the button's own
 * states are the only feedback there is that anything happened.
 */
function buildRunNowButton(file: AgentFile): HTMLElement {
  const button = document.createElement('button');
  button.className = 'schedule-play-btn';
  button.title = 'Run now';
  button.innerHTML = SVG.play;

  button.addEventListener('click', async (e: MouseEvent) => {
    e.stopPropagation();

    button.classList.add('running');
    button.innerHTML = SVG.spinner;
    button.title = 'Running...';

    const result = await window.api.runScheduleNow(file.filePath);

    button.classList.remove('running');
    button.classList.add('done');
    button.innerHTML = SVG.check;
    button.title = 'Launched!';
    setTimeout(() => {
      button.classList.remove('done');
      button.innerHTML = SVG.play;
      button.title = 'Run now';
    }, RUN_FEEDBACK_MS);

    if (result && !result.ok) console.error('Schedule run failed:', result.error);
  });

  return button;
}

async function openFile(file: AgentFile): Promise<void> {
  memoryContent.querySelectorAll<HTMLElement>('.memory-item.active')
    .forEach(el => el.classList.remove('active'));
  memoryContent.querySelector<HTMLElement>(
    `.memory-item[data-filepath="${CSS.escape(file.filePath)}"]`)?.classList.add('active');

  const content = await window.api.readMemory(file.filePath);
  showViewer('memory');
  memoryPanel.open(file.filename, file.filePath, content ?? '');
}
