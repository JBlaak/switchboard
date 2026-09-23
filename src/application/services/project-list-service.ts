/**
 * Answering "what projects are there?".
 *
 * Gathers the four sources a project row can come from and hands them to the
 * domain's list builder. The only judgement here is about cost: the folder →
 * project-path mapping is read from the index rather than by re-parsing a
 * transcript per directory on every render, and a folder the indexer has not
 * seen yet is resolved once and written back so later renders stay pure reads.
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
    return buildProjectList({
      cached: repository.getAllCached(),
      meta: repository.getAllMeta(),
      hiddenProjects: settings.hiddenProjects(),
      knownProjectPaths: this.#knownProjectPaths(),
      activeTerminals: this.#activeTerminals(registry),
      remoteProjects: settings.remoteProjects(),
      showArchived,
    });
  }

  /**
   * A project path for every transcript folder on disk, so a project with no
   * sessions yet still gets a row to launch the first one from.
   *
   * Resolved through the index where possible; a folder it has not seen is read
   * off disk once and written back with a zero mtime, which leaves the
   * incremental re-index free to index it properly later.
   */
  #knownProjectPaths(): string[] {
    const { repository, transcripts } = this.deps;
    const paths: string[] = [];
    try {
      const meta = repository.getAllFolderMeta();
      for (const folder of transcripts.listFolders()) {
        let projectPath = meta.get(folder)?.projectPath ?? null;
        if (!projectPath) {
          projectPath = transcripts.resolveProjectPath(folder);
          if (projectPath) repository.setFolderMeta(folder, projectPath, 0);
        }
        if (projectPath) paths.push(projectPath);
      }
    } catch {
      // A directory that vanished mid-scan is not worth failing the list over.
    }
    return paths;
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
