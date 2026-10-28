/**
 * SQLite behind the TaskLinkStore port: the `task_links` table.
 *
 * A partial UNIQUE index on `session_id` holds a session to one link, so
 * `link` replaces the session's row in one statement rather than relying on a
 * delete before it. A repo set by hand is a row without a session. An unlink
 * is remembered in `task_unlinks` until the session is linked again.
 */
import type Database from 'better-sqlite3';
import type { SessionTaskLink, TaskLinkStore } from '../../application/ports/task-link-store';
import type { TaskLink, TaskLinkSource } from '../../domain/tasks/links';

interface Row {
  task_id: string;
  project_path: string;
  session_id: string | null;
  source: string;
  linked_at: number;
}

const SOURCES: readonly string[] = ['start', 'detected', 'manual'];

function toLink(row: Row): TaskLink {
  return {
    taskId: row.task_id,
    projectPath: row.project_path,
    sessionId: row.session_id,
    // Anything another build wrote reads as made by hand.
    source: (SOURCES.includes(row.source) ? row.source : 'manual') as TaskLinkSource,
    linkedAt: row.linked_at,
  };
}

const COLUMNS = 'task_id, project_path, session_id, source, linked_at';

export class SqliteTaskLinkStore implements TaskLinkStore {
  readonly #all;
  readonly #forTask;
  readonly #forSession;
  readonly #link;
  readonly #unlink;
  readonly #unlinkedAt;
  readonly #setRepo;

  constructor(db: Database.Database) {
    this.#all = db.prepare<[], Row>(`SELECT ${COLUMNS} FROM task_links ORDER BY linked_at, id`);
    this.#forTask = db.prepare<[string], Row>(`SELECT ${COLUMNS} FROM task_links WHERE task_id = ? ORDER BY linked_at, id`);
    this.#forSession = db.prepare<[string], Row>(`SELECT ${COLUMNS} FROM task_links WHERE session_id = ?`);
    const upsert = db.prepare<[Row]>(`
      INSERT INTO task_links (${COLUMNS})
      VALUES (@task_id, @project_path, @session_id, @source, @linked_at)
      ON CONFLICT (session_id) WHERE session_id IS NOT NULL DO UPDATE SET
        task_id = excluded.task_id, project_path = excluded.project_path,
        source = excluded.source, linked_at = excluded.linked_at
    `);
    const forgetUnlink = db.prepare<[string]>('DELETE FROM task_unlinks WHERE session_id = ?');
    this.#link = db.transaction((row: Row) => {
      upsert.run(row);
      forgetUnlink.run(row.session_id as string);
    });
    const dropLink = db.prepare<[string]>('DELETE FROM task_links WHERE session_id = ?');
    const rememberUnlink = db.prepare<[string, number]>(`
      INSERT INTO task_unlinks (session_id, unlinked_at) VALUES (?, ?)
      ON CONFLICT (session_id) DO UPDATE SET unlinked_at = excluded.unlinked_at
    `);
    this.#unlink = db.transaction((sessionId: string, at: number) => {
      dropLink.run(sessionId);
      rememberUnlink.run(sessionId, at);
    });
    this.#unlinkedAt = db.prepare<[string], { unlinked_at: number }>('SELECT unlinked_at FROM task_unlinks WHERE session_id = ?');
    const dropRepo = db.prepare<[string]>('DELETE FROM task_links WHERE task_id = ? AND session_id IS NULL');
    const addRepo = db.prepare<[Row]>(`INSERT INTO task_links (${COLUMNS}) VALUES (@task_id, @project_path, @session_id, @source, @linked_at)`);
    this.#setRepo = db.transaction((row: Row) => {
      dropRepo.run(row.task_id);
      addRepo.run(row);
    });
  }

  all(): TaskLink[] {
    return this.#all.all().map(toLink);
  }

  forTask(taskId: string): TaskLink[] {
    return this.#forTask.all(taskId).map(toLink);
  }

  forSession(sessionId: string): TaskLink | null {
    const row = this.#forSession.get(sessionId);
    return row ? toLink(row) : null;
  }

  link(link: SessionTaskLink): void {
    this.#link({
      task_id: link.taskId,
      project_path: link.projectPath,
      session_id: link.sessionId,
      source: link.source,
      linked_at: link.linkedAt,
    });
  }

  unlink(sessionId: string, at: number): void {
    this.#unlink(sessionId, at);
  }

  unlinkedAt(sessionId: string): number | null {
    return this.#unlinkedAt.get(sessionId)?.unlinked_at ?? null;
  }

  setRepo(taskId: string, projectPath: string, at: number): void {
    this.#setRepo({ task_id: taskId, project_path: projectPath, session_id: null, source: 'manual', linked_at: at });
  }
}
