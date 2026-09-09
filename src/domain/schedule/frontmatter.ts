/**
 * The frontmatter block at the top of a schedule (or command) markdown file.
 *
 * Deliberately not a YAML parser: schedule files are written by Claude from a
 * template this app ships, so the grammar in play is scalars plus one level of
 * nesting under a bare key. A real YAML dependency would buy nothing and would
 * accept far more than the rest of the pipeline is prepared to handle.
 */

/** A frontmatter value: a scalar, or the nested map under a bare key. */
export type FrontmatterValue = string | Record<string, string>;

export interface Frontmatter {
  meta: Record<string, FrontmatterValue>;
  body: string;
}

export function parseFrontmatter(content: string): Frontmatter {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: content.trim() };

  const meta: Record<string, FrontmatterValue> = {};
  const nested: Record<string, Record<string, string>> = {};
  let currentKey: string | null = null;

  for (const line of match[1].split('\n')) {
    // An indented `key: value` belongs to the last bare key we saw.
    if (currentKey && line.match(/^\s+/) && line.includes(':')) {
      const m = line.match(/^\s+([^:]+):\s*(.*)$/);
      if (m && !m[1].trim().startsWith('#')) {
        if (!nested[currentKey]) nested[currentKey] = {};
        nested[currentKey][m[1].trim()] = m[2].trim();
      }
      continue;
    }
    const kv = line.match(/^([^:]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].trim();
    const val = kv[2].trim();
    if (val === '') {
      // A bare key opens a nested block.
      currentKey = key;
    } else {
      meta[key] = val;
      currentKey = null;
    }
  }

  for (const [k, v] of Object.entries(nested)) meta[k] = v;
  return { meta, body: match[2].trim() };
}

/** Read a frontmatter value as a string, or fall back. */
export function scalar(meta: Record<string, FrontmatterValue>, key: string, fallback: string): string {
  const value = meta[key];
  return typeof value === 'string' ? value : fallback;
}

/** Read a nested frontmatter block, or an empty one. */
export function block(meta: Record<string, FrontmatterValue>, key: string): Record<string, string> {
  const value = meta[key];
  return typeof value === 'object' && value !== null ? value : {};
}
