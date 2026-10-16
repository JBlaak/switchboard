/**
 * Copy-on-write helpers for the id-keyed records the slices hold.
 *
 * Each answers the record it was given when nothing would change, which is
 * what lets a reducer return its input untouched and the store skip the
 * notification.
 */

export type IdRecord<T> = Readonly<Record<string, T>>;

export function withEntry<T>(record: IdRecord<T>, id: string, value: T): IdRecord<T> {
  if (Object.prototype.hasOwnProperty.call(record, id) && Object.is(record[id], value)) return record;
  return { ...record, [id]: value };
}

export function withoutEntry<T>(record: IdRecord<T>, id: string): IdRecord<T> {
  if (!Object.prototype.hasOwnProperty.call(record, id)) return record;
  const next = { ...record };
  delete next[id];
  return next;
}

export function hasEntry(record: IdRecord<unknown>, id: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, id);
}

/**
 * The record with `oldId`'s entry filed under `newId` instead — the move every
 * slice makes when a session is re-keyed.
 *
 * An entry already under `newId` wins: main sends later events under the new
 * id, so anything it said there is newer than what it said under the old one.
 * Either way nothing is left under `oldId`.
 */
export function movedEntry<T>(record: IdRecord<T>, oldId: string, newId: string): IdRecord<T> {
  if (oldId === newId || !hasEntry(record, oldId)) return record;
  const next = withoutEntry(record, oldId);
  return hasEntry(next, newId) ? next : { ...next, [newId]: record[oldId] };
}
