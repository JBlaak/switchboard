/**
 * SQLite behind the ActivityStore port: the `session_actions` table.
 *
 * Rows are ordered by when they were queued, and by insertion within the same
 * millisecond, which is the order each session's queue sends them in.
 */
import type Database from 'better-sqlite3';
import type { ActivityDetails, ActivityStore, StoredAction } from '../../application/ports/activity-store';

interface Row {
  id: string;
  session: string;
  repository: string;
  item_key: string;
  action: StoredAction['action'];
  origin: StoredAction['origin'];
  phase: StoredAction['phase'];
  prompt: string;
  queued_at: string;
  sent_at: string | null;
  done_at: string | null;
  details: string | null;
}

export class SqliteActivityStore implements ActivityStore {
  readonly #insert;
  readonly #update;
  readonly #remove;
  readonly #unfinished;

  constructor(db: Database.Database) {
    this.#insert = db.prepare<[Row]>(`
      INSERT INTO session_actions
        (id, session, repository, item_key, action, origin, phase, prompt, queued_at, sent_at, done_at, details)
      VALUES
        (@id, @session, @repository, @item_key, @action, @origin, @phase, @prompt, @queued_at, @sent_at, @done_at, @details)
    `);
    this.#update = db.prepare<[{ id: string; phase: string | null; sent_at: string | null; done_at: string | null }]>(`
      UPDATE session_actions SET
        phase = COALESCE(@phase, phase),
        sent_at = COALESCE(@sent_at, sent_at),
        done_at = COALESCE(@done_at, done_at)
      WHERE id = @id
    `);
    this.#remove = db.prepare<[string]>('DELETE FROM session_actions WHERE id = ?');
    this.#unfinished = db.prepare<[], Row>(
      "SELECT * FROM session_actions WHERE phase IN ('queued', 'sent', 'gave-up') ORDER BY queued_at, rowid");
  }

  add(action: StoredAction): void {
    this.#insert.run({
      id: action.id,
      session: action.sessionId,
      repository: action.repository,
      item_key: action.itemKey,
      action: action.action,
      origin: action.origin,
      phase: action.phase,
      prompt: action.prompt,
      queued_at: action.queuedAt,
      sent_at: action.sentAt,
      done_at: action.doneAt,
      details: action.details ? JSON.stringify(action.details) : null,
    });
  }

  update(id: string, changes: Partial<Pick<StoredAction, 'phase' | 'sentAt' | 'doneAt'>>): void {
    this.#update.run({
      id,
      phase: changes.phase ?? null,
      sent_at: changes.sentAt ?? null,
      done_at: changes.doneAt ?? null,
    });
  }

  remove(id: string): void {
    this.#remove.run(id);
  }

  unfinished(): StoredAction[] {
    return this.#unfinished.all().map((row) => ({
      id: row.id,
      sessionId: row.session,
      repository: row.repository,
      itemKey: row.item_key,
      action: row.action,
      origin: row.origin,
      phase: row.phase,
      prompt: row.prompt,
      queuedAt: row.queued_at,
      sentAt: row.sent_at,
      doneAt: row.done_at,
      details: decodeDetails(row.details),
    }));
  }
}

/** A row's details, or null for none or for anything a stray build could have left there. */
function decodeDetails(json: string | null): ActivityDetails | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed as ActivityDetails : null;
  } catch {
    return null;
  }
}
