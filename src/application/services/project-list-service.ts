/**
 * Answering "what projects are there?".
 *
 * Gathers the four sources a project row can come from and hands them to the
 * domain's list builder. The only judgement here is about cost: the folder →
 * project-path mapping is read from the index rather than by re-parsing a
 * transcript per directory on every render, and a folder the indexer has not
 * seen yet — or saw before it recorded a cwd — is resolved once and written
 * back so later renders stay pure reads.
 */
import { buildProjectList } from '../../domain/project/project-list';
import type { Project } from '../../domain/project/project';
import type { ActiveTerminalRow } from '../../domain/project/project-list';
import type { SessionRegistry } from '../model/session-registry';
import type { SessionRepository } from '../ports/session-repository';
import type { TranscriptStore } from '../ports/transcript-store';
import type { SettingsService } from './settings-service';

export interface ProjectListDeps {
  repository: SessionRepository;
  transcripts: TranscriptStore;
  settings: SettingsService;
  registry: SessionRegistry;
}

export class ProjectListService {
  constructor(private readonly deps: ProjectListDeps) {}

  list(showArchived: boolean): Project[] {
    const { repository, settings, registry } = this.deps;
    const { knownProjectPaths, folderCwds } = this.#folderGate();
    return buildProjectList({
      cached: repository.getAllCached(),
      meta: repository.getAllMeta(),
      hiddenProjects: settings.hiddenProjects(),
      knownProjectPaths,
      folderCwds,
      activeTerminals: this.#activeTerminals(registry),
      remoteProjects: settings.remoteProjects(),
      showArchived,
    });
  }

  /**
   * What the list needs from the folder gate: a project path for every
   * transcript folder on disk, so a project with no sessions yet still gets a
   * row to launch the first one from, and the cwd each folder's sessions ran
   * in, so a row can be scoped to the worktree it belongs to.
   *
   * Resolved through the index where possible. A folder the indexer has not
   * seen is read off disk once and written back with a zero mtime, which leaves
   * the incremental re-index free to index it properly later.
   *
   * A folder indexed before the gate recorded a cwd is re-resolved the same way
   * but keeps its mtime: its cached sessions are still good, only the gate row
   * lacks a column, and re-reading every transcript on the first paint after an
   * upgrade is exactly the cost this avoids. Either way the write happens once
   * per folder, ever — the next list finds the cwd in the index.
   */
  #folderGate(): { knownProjectPaths: string[]; folderCwds: Map<string, string | null> } {
    const { repository, transcripts } = this.deps;
    const knownProjectPaths: string[] = [];
    const folderCwds = new Map<string, string | null>();
    try {
      const meta = repository.getAllFolderMeta();
      // Seeded from every gate row, not only the folders on disk: cached rows
      // for a folder that has since vanished keep their cwd until the index
      // drops them.
      for (const [folder, { cwd }] of meta) folderCwds.set(folder, cwd);

      for (const folder of transcripts.listFolders()) {
        const known = meta.get(folder);
        let projectPath = known?.projectPath ?? null;
        if (!projectPath || !known?.cwd) {
          const resolved = transcripts.resolveProjectPath(folder);
          if (resolved) {
            const indexMtimeMs = known?.projectPath ? known.indexMtimeMs : 0;
            repository.setFolderMeta(folder, resolved.projectPath, resolved.cwd, indexMtimeMs);
            projectPath = resolved.projectPath;
            folderCwds.set(folder, resolved.cwd);
          }
        }
        if (projectPath) knownProjectPaths.push(projectPath);
      }
    } catch {
      // A directory that vanished mid-scan is not worth failing the list over.
    }
    return { knownProjectPaths, folderCwds };
  }

  /** Plain terminals, which exist only in memory while they run. */
  #activeTerminals(registry: SessionRegistry): ActiveTerminalRow[] {
    const rows: ActiveTerminalRow[] = [];
    for (const [sessionId, session] of registry.snapshot()) {
      if (session.exited || !session.isPlainTerminal || !session.projectPath) continue;
      rows.push({ sessionId, projectPath: session.projectPath, openedAt: session.openedAt });
    }
    return rows;
  }
}
