/**
 * The viewer panel's file access, and the host capabilities the UI reaches for.
 *
 * The panel's paths come from the renderer, which got them from the CLI over
 * MCP or from a link in terminal output — so a write only ever overwrites a
 * file that already exists, and never creates one.
 */
import { INVOKE } from '../../ipc/channels';
import { isRemoteProjectPath } from '../../domain/project/remote-target';
import type { FileSystem } from '../../application/ports/file-system';
import type { Container } from '../composition-root';
import type { IpcRegistrar } from './registrar';

/** What `resolveRevealTarget` decided, and the path to hand the shell if it said yes. */
export type RevealDecision =
  | { ok: true; path: string }
  | { ok: false; error: string };

/**
 * Whether this path may be shown in the file manager, and where.
 *
 * The renderer supplies the path — today from a rail tile, tomorrow from
 * wherever else a "reveal" ends up — so it is not trusted. Three questions, in
 * this order:
 *
 *  - Is it a local path at all? An `ssh://` project's directory is on the far
 *    host and there is nothing here to open.
 *  - Is it inside a project the app already knows about? This is the real
 *    guard. `showItemInFolder` cannot run anything, but it can open a window on
 *    any directory on the machine, and a renderer that can name one is a
 *    renderer that can enumerate the disk one refusal at a time. A worktree
 *    under `.claude/worktrees/` passes because it is inside its parent; a
 *    sibling checkout outside every project does not, and neither does `/etc`.
 *  - Does it exist? Checked last, because it is the answer that changes: a
 *    checkout deleted a moment ago is an ordinary event, and the message for it
 *    should say that rather than "not a known project".
 *
 * `fs.isInside` resolves both sides, so `..` inside the argument cannot walk
 * out of a project and back in on paper.
 */
export function resolveRevealTarget(
  fs: FileSystem, knownProjectPaths: Iterable<string>, target: unknown,
): RevealDecision {
  if (typeof target !== 'string' || target.trim() === '') {
    return { ok: false, error: 'No path to reveal' };
  }
  if (isRemoteProjectPath(target)) {
    return { ok: false, error: 'That project lives on another machine' };
  }

  const resolved = fs.resolve(target);
  const known = [...knownProjectPaths].some(
    projectPath => !isRemoteProjectPath(projectPath) && fs.isInside(projectPath, resolved),
  );
  if (!known) return { ok: false, error: 'That path is not inside a known project' };
  if (!fs.exists(resolved)) return { ok: false, error: 'That path is no longer on disk' };

  return { ok: true, path: resolved };
}

export function registerHostHandlers(ipc: IpcRegistrar, app: Container): void {
  // ── The viewer panel ──
  ipc.handle(INVOKE.readFileForPanel, (filePath: string) => {
    try {
      return { ok: true, content: app.fs.readText(filePath) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipc.handle(INVOKE.saveFileForPanel, (filePath: string, content: string) => {
    const resolved = app.fs.resolve(filePath);
    if (!app.fs.exists(resolved)) return { ok: false, error: 'File does not exist' };
    try {
      app.fs.writeText(resolved, content);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipc.handle(INVOKE.watchFile, (filePath: string) => app.fileWatches.watch(filePath));
  ipc.handle(INVOKE.unwatchFile, (filePath: string) => {
    app.fileWatches.unwatch(filePath);
    return { ok: true };
  });

  // ── Host ──
  ipc.handle(INVOKE.openExternal, (url: string) => app.system.openExternal(url));

  // The project list is read per reveal rather than cached: it is a user
  // gesture, once, and a stale list would refuse the project they just added.
  // `true` includes the archived ones — a project whose sessions are all
  // archived is still a folder on disk the user may want to look at.
  ipc.handle(INVOKE.revealPath, (target: string) => {
    const decision = resolveRevealTarget(
      app.fs, app.projects.list(true).map(project => project.projectPath), target,
    );
    if (!decision.ok) return decision;
    app.system.revealPath(decision.path);
    return { ok: true };
  });

  ipc.handle(INVOKE.writeClipboard, (text: string) => {
    app.system.writeClipboard(text);
  });
  ipc.handle(INVOKE.getAppVersion, () => app.system.appVersion());

  ipc.handle(INVOKE.updaterCheck, () => app.updater.check());
  ipc.handle(INVOKE.updaterDownload, () => app.updater.download());
  ipc.handle(INVOKE.updaterInstall, () => {
    app.updater.install();
  });
}
