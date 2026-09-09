/**
 * Plans: the markdown files Claude writes when a plan is accepted.
 */

/** A plan as the plans tab lists it. */
export interface PlanSummary {
  filename: string;
  title: string;
  /** ISO-8601 mtime. */
  modified: string;
}

/**
 * A plan's title: its first heading, or its filename.
 *
 * Plans are written by the CLI and normally open with an `# H1`; the filename
 * is the fallback for one that does not.
 */
export function planTitle(content: string, filename: string): string {
  const firstLine = content.split('\n').find(l => l.trim());
  return firstLine?.startsWith('# ')
    ? firstLine.slice(2).trim()
    : filename.replace(/\.md$/, '');
}

/** Most recently modified first. */
export function byNewestFirst(a: { modified: string }, b: { modified: string }): number {
  return new Date(b.modified).getTime() - new Date(a.modified).getTime();
}
