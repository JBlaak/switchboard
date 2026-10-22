/**
 * What the Projects modal's search text is (#171): a filter over the projects,
 * a local folder to add, or a machine to add over SSH.
 *
 * Pure, so the rules run under the node test runner without a DOM.
 */

export type ProjectsQuery =
  /** Fuzzy-match the projects, as the picker always has. */
  | { readonly kind: 'filter'; readonly text: string }
  /** Starts with `/` or `~`: offer to add that folder. */
  | { readonly kind: 'path'; readonly path: string }
  /** `user@host` or `user@host:port`: offer to add that machine. */
  | { readonly kind: 'ssh'; readonly user: string; readonly host: string; readonly port: string };

/** One run of characters that are neither space, `@`, `/` nor `:`. */
const PART = '[^\\s@/:]+';
const SSH_TARGET = new RegExp(`^(${PART})@(${PART})(?::(\\d{1,5}))?$`);

/** Read the search text, trimmed: a path, an ssh target, or a filter. */
export function classifyQuery(query: string): ProjectsQuery {
  const text = query.trim();
  if (text.startsWith('/') || text.startsWith('~')) return { kind: 'path', path: text };
  const ssh = SSH_TARGET.exec(text);
  if (ssh) return { kind: 'ssh', user: ssh[1], host: ssh[2], port: ssh[3] ?? '' };
  return { kind: 'filter', text };
}
