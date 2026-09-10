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
import { forgetWorktree } from '../../state/scope-store';
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
 * What this platform calls its file manager.
 *
 * "Reveal in Finder" on a Windows machine is an item nobody can act on, and the
 * three names are different enough that a generic "Show in file manager" would
 * read as a translation on the two platforms that have a name for it.
 */
function revealLabel(): string {
  const platform = typeof window === 'undefined' ? '' : window.api?.platform;
  if (platform === 'darwin') return 'Reveal in Finder';
  if (platform === 'win32') return 'Show in Explorer';
  return 'Show in file manager';
}

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

/** The three ways to put a line in a menu, handed to whoever is filling one. */
interface MenuBuilder {
  /** A live item. Picking it closes the menu first, then acts. */
  item(text: string, onPick: () => void): HTMLButtonElement;
  /**
   * An item that is drawn but does nothing yet.
   *
   * Pinning and groups are the rail's next two features and both need a place
   * to persist to that M1 does not have. Shown disabled rather than left out so
   * the menu does not change shape when they land — and so the tooltip can say
   * which release to expect them in instead of the feature looking missing.
   */
  inert(text: string, why: string): void;
  divider(): void;
  /** A line of prose, for a menu that has something to explain. */
  note(text: string): void;
}

/**
 * Open one popover beside `anchor`, filled by `fill`.
 *
 * Both of the rail's menus are the same panel with different lines in it, so
 * the shell — the label, the dismissal, the placement, the focus — is written
 * once and neither of them owns it.
 */
function openMenu(labelText: string, anchor: PopoverAnchor, fill: (menu: MenuBuilder) => void): void {
  document.querySelectorAll<HTMLElement>('.rail-menu').forEach(el => el.remove());

  const menu = document.createElement('div');
  menu.className = 'rail-menu';

  const label = document.createElement('div');
  label.className = 'rail-menu-label';
  label.textContent = labelText;
  menu.appendChild(label);

  // Reassigned once the dismissal is installed, so an item picked before that
  // still closes the panel it is in.
  let close = (): void => menu.remove();

  fill({
    item(text, onPick) {
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
    },
    inert(text, why) {
      const button = document.createElement('button');
      button.className = 'rail-menu-item';
      button.type = 'button';
      button.disabled = true;
      button.textContent = text;
      button.title = why;
      menu.appendChild(button);
    },
    divider() {
      menu.appendChild(divider());
    },
    note(text) {
      const line = document.createElement('div');
      line.className = 'rail-menu-note';
      line.textContent = text;
      line.title = text;
      menu.appendChild(line);
    },
  });

  document.body.appendChild(menu);
  position(menu, anchor);
  close = installDismiss(menu, anchor);
  menu.querySelector<HTMLElement>('.rail-menu-item:not([disabled])')?.focus();
}

export function showRailMenu(projectPath: string, anchor: PopoverAnchor): void {
  const remote = projectFor(projectPath).remote === true;

  openMenu(projectLabel(projectPath), anchor, menu => {
    menu.item('New session', () => showNewSessionPopover(projectFor(projectPath), anchor));
    menu.item('Open terminal here', () => {
      const project = projectFor(projectPath);
      if (project.remote) void launchRemoteSession(project, 'shell');
      else void launchTerminalSession(project);
    });
    // A remote project's directory is a path on the far host, so there is
    // nothing on this machine to reveal.
    if (!remote) {
      menu.item(revealLabel(), () => void revealPath(projectPath));
    }
    // A remote project's settings live in its connection record, not in a
    // `project:` settings key — the picker omits the item for the same reason.
    if (!remote) {
      menu.item('Project settings…', () => void openSettingsViewer('project', projectPath));
    }

    menu.divider();
    menu.inert('Pin', 'Pinning arrives with the rail’s groups');
    menu.inert('Move to group…', 'Groups arrive in a later release');

    menu.divider();
    menu.item('Archive all sessions', () => void archiveAllSessions(projectFor(projectPath)));
    menu.item('Remove project', () => void removeProject(projectPath, remote));
  });
}

/**
 * The menu behind a checkout that is no longer on disk.
 *
 * Two items, and only one of them does anything. `Forget` is the whole point:
 * the tile is kept precisely so the user can decide, and this is the deciding.
 * `Recreate` is drawn and disabled because there is no channel that writes to
 * git — every git path in the app is a read — and an item that quietly does
 * nothing is worse than one that says why.
 */
export function showMissingWorktreeMenu(
  projectPath: string, worktreePath: string, anchor: PopoverAnchor,
): void {
  openMenu('Worktree removed', anchor, menu => {
    menu.note(worktreePath);
    menu.divider();
    menu.item('Forget', () => forgetWorktree(projectPath, worktreePath));
    menu.inert('Recreate', 'Switchboard only reads git; recreate the checkout with '
      + '`git worktree add` and it will come back');
  });
}

/**
 * Show a directory in the platform's file manager.
 *
 * The main process checks the path before it hands it to the shell — see
 * `resolveRevealTarget` — so a refusal here is a bug naming itself rather than
 * something to put in front of the user.
 */
async function revealPath(target: string): Promise<void> {
  const result = await window.api.revealPath(target);
  if (result?.ok !== true) console.warn('reveal failed:', result?.error);
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
