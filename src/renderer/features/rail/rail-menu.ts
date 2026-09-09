/**
 * The right-click menu on a rail tile.
 *
 * There is no context-menu infrastructure in the renderer — the app's other
 * menus are one-off popovers — so this is a small one, built to the conventions
 * `new-session-popover.ts` already set: a fixed-position panel anchored to what
 * opened it, dismissed by Escape, by a click outside, and by picking anything.
 * A native Electron `Menu` was the alternative and was not taken: it cannot be
 * styled to match, and everything here is a delegation to a renderer function
 * that would have to be reached back over IPC.
 *
 * Every item is a delegation. The rail owns no project actions of its own; it
 * is a second entry point to the ones the project picker and the sidebar
 * already offer, so that scoping to a project and acting on it are the same
 * gesture in the same place.
 */
import { projectLabel } from '../sessions/project-label';
import { reloadProjects } from '../../app/refresh';
import { showNewSessionPopover } from '../dialogs/new-session-popover';
import { openSettingsViewer } from '../settings/settings-panel';
import {
  archiveAllSessions, launchRemoteSession, launchTerminalSession, projectStub,
} from '../sessions/session-actions';
import { view } from '../../state/session-store';
import type { PopoverAnchor } from '../dialogs/new-session-popover';
import type { Project } from '../../../domain/project/project';

/** How far to the right of the tile the menu sits. */
const GAP_PX = 6;

/**
 * The project this menu is about, looked up at click time.
 *
 * `view.cachedAllProjects` is replaced wholesale by every reload, so the rail
 * holds paths and never `Project` objects; the real entry — with its sessions,
 * which "Archive all" needs — is found when the item is picked. A stub covers
 * the project having gone in the meantime, which for the launchers is all they
 * read anyway.
 */
function projectFor(projectPath: string): Project {
  return view.cachedAllProjects.find(p => p.projectPath === projectPath)
    ?? view.cachedProjects.find(p => p.projectPath === projectPath)
    ?? projectStub(projectPath);
}

export function showRailMenu(projectPath: string, anchor: PopoverAnchor): void {
  document.querySelectorAll<HTMLElement>('.rail-menu').forEach(el => el.remove());

  const menu = document.createElement('div');
  menu.className = 'rail-menu';

  const label = document.createElement('div');
  label.className = 'rail-menu-label';
  label.textContent = projectLabel(projectPath);
  menu.appendChild(label);

  let close = (): void => menu.remove();

  const item = (text: string, onPick: () => void): HTMLButtonElement => {
    const button = document.createElement('button');
    button.className = 'rail-menu-item';
    button.type = 'button';
    button.textContent = text;
    button.onclick = () => {
      close();
      onPick();
    };
    menu.appendChild(button);
    return button;
  };

  /**
   * An item that is drawn but does nothing yet.
   *
   * Pinning and groups are the rail's next two features and both need a place
   * to persist to that M1 does not have. Shown disabled rather than left out so
   * the menu does not change shape when they land — and so the tooltip can say
   * which release to expect them in instead of the feature looking missing.
   */
  const inert = (text: string, why: string): void => {
    const button = document.createElement('button');
    button.className = 'rail-menu-item';
    button.type = 'button';
    button.disabled = true;
    button.textContent = text;
    button.title = why;
    menu.appendChild(button);
  };

  const remote = projectFor(projectPath).remote === true;

  item('New session', () => showNewSessionPopover(projectFor(projectPath), anchor));
  item('Open terminal here', () => {
    const project = projectFor(projectPath);
    if (project.remote) void launchRemoteSession(project, 'shell');
    else void launchTerminalSession(project);
  });
  // A remote project's settings live in its connection record, not in a
  // `project:` settings key — the picker omits the item for the same reason.
  if (!remote) {
    item('Project settings…', () => void openSettingsViewer('project', projectPath));
  }

  menu.appendChild(divider());
  inert('Pin', 'Pinning arrives with the rail’s groups');
  inert('Move to group…', 'Groups arrive in a later release');

  menu.appendChild(divider());
  item('Archive all sessions', () => void archiveAllSessions(projectFor(projectPath)));
  item('Remove project', () => void removeProject(projectPath, remote));

  document.body.appendChild(menu);
  position(menu, anchor);
  close = installDismiss(menu, anchor);
  menu.querySelector<HTMLElement>('.rail-menu-item:not([disabled])')?.focus();
}

function divider(): HTMLElement {
  const rule = document.createElement('div');
  rule.className = 'rail-menu-divider';
  return rule;
}

/**
 * Take the project off the list.
 *
 * Two different removals behind one item: a remote project is a connection
 * record, a local one is a tracked folder, and neither deletes anything on
 * disk. The wording is the project picker's, which is where this was the only
 * way to do it before the rail existed.
 */
async function removeProject(projectPath: string, remote: boolean): Promise<void> {
  const message = remote
    ? `Remove ${projectLabel(projectPath)}?\n\n`
      + 'This disconnects open connections. tmux sessions on the remote machine keep running.'
    : `Remove ${projectLabel(projectPath)}?\n\nSession files are not deleted.`;
  if (!confirm(message)) return;
  await (remote
    ? window.api.removeRemoteProject(projectPath)
    : window.api.removeProject(projectPath));
  await reloadProjects();
}

/**
 * Beside the tile, not below it.
 *
 * The rail is 48px of the window's left edge, so a menu that opened downward
 * from a tile would cover the tiles under it. It opens to the right instead,
 * top-aligned with the tile and lifted only as far as it has to be to stay on
 * screen — which for a tile near the bottom is up to the window's edge.
 */
function position(menu: HTMLElement, anchor: PopoverAnchor): void {
  const rect = anchor.getBoundingClientRect();
  const height = menu.offsetHeight;
  const top = Math.max(GAP_PX, Math.min(rect.top, window.innerHeight - height - GAP_PX));
  menu.style.top = top + 'px';
  menu.style.left = rect.right + GAP_PX + 'px';
}

/**
 * Escape, a click outside, or a right-click elsewhere closes it.
 *
 * Returns the close, so picking an item unbinds the document listener too
 * rather than leaving one behind per menu opened.
 */
function installDismiss(menu: HTMLElement, anchor: PopoverAnchor): () => void {
  const close = (): void => {
    menu.remove();
    document.removeEventListener('mousedown', onMouseDown);
    document.removeEventListener('contextmenu', onMouseDown);
    document.removeEventListener('keydown', onKey);
  };

  const onMouseDown = (e: MouseEvent): void => {
    if (menu.contains(e.target as Node) || (e.target as unknown) === anchor) return;
    close();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    close();
  };

  // Deferred: the contextmenu event that opened this is still propagating.
  setTimeout(() => {
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('contextmenu', onMouseDown);
  }, 0);
  document.addEventListener('keydown', onKey);
  return close;
}
