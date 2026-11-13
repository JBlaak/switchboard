/**
 * SQLite behind the InboxStore port: the `inbox_items` and `inbox_sources`
 * tables (#413).
 *
 * An item is kept as JSON, read and written whole, like `vm_transcripts`: the
 * inbox only ever reads all of it at launch and writes what a poll or an
 * action changed. A row that does not parse as an item (another build's, or
 * a damaged one) is skipped rather than failing the launch; the next poll
 * brings its item back unread.
 */
import type Database from 'better-sqlite3';
import type {InboxStore} from '../../application/ports/inbox-store';
import type {InboxItem} from '../../domain/inbox/model';

interface Row {
    key: string;
    manager: string;
    item: string;
}

const STATES: readonly string[] = ['unread', 'read', 'snoozed', 'backlog', 'inProgress', 'done'];

function toItem(row: Row): InboxItem | null {
    try {
        const item = JSON.parse(row.item) as InboxItem;
        if (
            item?.key !== row.key ||
            (item.manager !== 'bug' && item.manager !== 'issue') ||
            !STATES.includes(item.state?.kind) ||
            item.facts?.kind !== item.manager
        ) {
            return null;
        }
        return {...item, notes: typeof item.notes === 'string' ? item.notes : ''};
    } catch {
        return null;
    }
}

export class SqliteInboxStore implements InboxStore {
    private readonly allStatement;
    private readonly applyTransaction;
    private readonly sinceStatement;
    private readonly setSinceStatement;

    constructor(db: Database.Database, now: () => number = Date.now) {
        this.allStatement = db.prepare<[], Row>('SELECT key, manager, item FROM inbox_items ORDER BY key');
        const upsert = db.prepare<[{key: string; manager: string; item: string; updated_at: number}]>(`
      INSERT INTO inbox_items (key, manager, item, updated_at) VALUES (@key, @manager, @item, @updated_at)
      ON CONFLICT (key) DO UPDATE SET manager = excluded.manager, item = excluded.item, updated_at = excluded.updated_at
    `);
        const drop = db.prepare<[string]>('DELETE FROM inbox_items WHERE key = ?');
        this.applyTransaction = db.transaction((save: readonly InboxItem[], remove: readonly string[]) => {
            const at = now();
            for (const item of save) {
                upsert.run({key: item.key, manager: item.manager, item: JSON.stringify(item), updated_at: at});
            }
            for (const key of remove) drop.run(key);
        });
        this.sinceStatement = db.prepare<[string], {watching_since: number}>(
            'SELECT watching_since FROM inbox_sources WHERE source = ?',
        );
        this.setSinceStatement = db.prepare<[string, number]>(`
      INSERT INTO inbox_sources (source, watching_since) VALUES (?, ?)
      ON CONFLICT (source) DO UPDATE SET watching_since = excluded.watching_since
    `);
    }

    public all(): InboxItem[] {
        return this.allStatement
            .all()
            .map(toItem)
            .filter((item): item is InboxItem => item !== null);
    }

    public apply(save: readonly InboxItem[], remove: readonly string[]): void {
        if (save.length === 0 && remove.length === 0) return;
        this.applyTransaction(save, remove);
    }

    public watchingSince(source: string): number | null {
        return this.sinceStatement.get(source)?.watching_since ?? null;
    }

    public setWatchingSince(source: string, at: number): void {
        this.setSinceStatement.run(source, at);
    }
}
