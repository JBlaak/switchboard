/**
 * Writing an upsert out by hand.
 *
 * The statement names every column three times — in the insert, its
 * placeholders and the update — and a column missed in the update is a value
 * that silently never changes again. Built from one list, it cannot drift.
 */

/**
 * An `INSERT` of `key` and `columns` that, when a row with that key exists,
 * overwrites just those columns and leaves the rest of the row alone.
 *
 * The placeholders take the key first, then the columns in the order given.
 */
export function upsertSql(table: string, key: string, columns: readonly string[]): string {
    const names = [key, ...columns];
    const placeholders = names.map(() => '?').join(', ');
    const updates = columns.map((column) => `${column} = excluded.${column}`).join(', ');
    return `INSERT INTO ${table} (${names.join(', ')}) VALUES (${placeholders}) ON CONFLICT(${key}) DO UPDATE SET ${updates}`;
}
