/**
 * What is searchable, and how a query is turned into a match expression.
 *
 * Only sessions are indexed. The type column stays in the schema; rows of
 * other types that older versions wrote are never queried.
 */

export type SearchType = 'session';

/** A row queued for the index. */
export interface SearchEntry {
  id: string;
  type: SearchType;
  folder?: string | null;
  title?: string;
  body?: string;
}

export interface SearchResult {
  id: string;
  /** Highlighted excerpt — contains `<mark>` tags, so it is trusted HTML. */
  snippet: string;
}

/** How many results a query returns before the UI would be scrolling forever. */
export const SEARCH_RESULT_LIMIT = 50;

/**
 * The FTS5 MATCH expression for a user's query.
 *
 * Wrapped in double quotes for exact substring matching with the trigram
 * tokenizer — without it FTS5 splits on punctuation, so "spec.md" becomes
 * "spec" OR "md" and matches far more than the user meant. A `title:` prefix
 * restricts the match to the title column.
 */
export function ftsMatchExpression(query: string, titleOnly = false): string {
  const escaped = '"' + query.replace(/"/g, '""') + '"';
  return titleOnly ? 'title:' + escaped : escaped;
}
