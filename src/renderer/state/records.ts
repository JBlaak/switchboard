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
