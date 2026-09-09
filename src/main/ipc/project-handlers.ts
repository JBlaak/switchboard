/**
 * Listing, adding and removing projects.
 */
import { INVOKE } from '../../ipc/channels';
import { encodeProjectPath } from '../../domain/project/project-path';
import {
  normalizeRemoteDir, remoteProjectPath, validateRemoteInput,
} from '../../domain/project/remote-target';
import { uuidGenerator } from '../../application/ports/ids';
import type { RemoteProjectSetting } from '../../domain/settings/settings';
import type { Container } from '../composition-root';
import type { IpcRegistrar } from './registrar';

export function registerProjectHandlers(ipc: IpcRegistrar, app: Container): void {
  /**
   * The project list.
   *
   * On a first launch (or after a migration emptied the index) the answer is an
   * empty list and a rebuild is started: the renderer is told when it lands
   * through `projects-changed`, which is better than blocking the window on a
   * scan of years of history.
   */
  ipc.handle(INVOKE.getProjects, (showArchived: boolean) => {
    if (app.sessionIndex.needsRebuild()) {
      app.sessionIndex.rebuild();
      return [];
    }
    // Cheap when nothing changed, and what keeps a folder written while the app
    // was closed from silently going missing.
    app.sessionIndex.reconcile();
    return app.projects.list(showArchived);
  });

  ipc.handle(INVOKE.browseFolder, () => app.dialogs.chooseDirectory('Select Project Folder'));

  /**
   * Add a project.
   *
   * Switchboard cannot create a project in Claude Code's world — only the CLI
   * writes transcripts — so "adding" one means making its transcript folder and
   * seeding it, which is what makes the project resolvable and gives it a row
   * to launch the first session from.
   */
  ipc.handle(INVOKE.addProject, (projectPath: string) => {
    if (!app.fs.exists(projectPath)) return { error: 'Path does not exist' };
    if (!app.fs.isDirectory(projectPath)) return { error: 'Path is not a directory' };

    // Adding a project the user previously removed un-removes it.
    app.settings.unhideProject(projectPath);

    const folder = app.transcripts.ensureProjectFolder(projectPath, {
      sessionId: uuidGenerator.newId(),
      messageId: uuidGenerator.newId(),
      nowIso: new Date().toISOString(),
    });

    // Index it now, so the row is there by the time the renderer re-renders.
    app.sessionIndex.refreshFolder(folder);
    app.renderer.projectsChanged();

    return { ok: true, folder, projectPath };
  });

  /**
   * Remove a project.
   *
   * Nothing is deleted: the transcripts belong to the CLI. The project goes on
   * a hide list and its cached rows are dropped, so it stops costing anything
   * until the user adds it back.
   */
  ipc.handle(INVOKE.removeProject, (projectPath: string) => {
    app.settings.hideProject(projectPath);
    app.sessionIndex.forgetFolder(encodeProjectPath(projectPath));
    app.settings.forgetProject(projectPath);
    app.renderer.projectsChanged();
    return { ok: true };
  });

  ipc.handle(INVOKE.addRemoteProject, (config: Record<string, unknown>) => {
    const error = validateRemoteInput(config || {});
    if (error) return { error };

    const remote = {
      user: String(config.user),
      host: String(config.host),
      port: Number(config.port) || 22,
      dir: normalizeRemoteDir(config.dir) ?? '',
      sessions: [],
    } satisfies RemoteProjectSetting;

    if (!app.settings.addRemoteProject(remote)) {
      return { error: 'This remote is already added.' };
    }
    app.renderer.projectsChanged();
    return { ok: true, projectPath: remoteProjectPath(remote) };
  });

  /**
   * Remove a remote project.
   *
   * Its connections are dropped, but the tmux sessions on the far end live on —
   * this is a local forget, not a remote teardown.
   */
  ipc.handle(INVOKE.removeRemoteProject, (projectPath: string) => {
    app.settings.removeRemoteProject(projectPath);

    for (const [sessionId, session] of app.registry.snapshot()) {
      if (session.projectPath !== projectPath) continue;
      app.remote.markDisconnected(session);
      if (session.exited) {
        app.lifecycle.retire(sessionId, session, 0);
      } else {
        app.lifecycle.stop(sessionId, session);
      }
    }

    app.renderer.projectsChanged();
    return { ok: true };
  });
}
