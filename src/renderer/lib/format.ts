/**
 * Formatting and escaping, for the parts of the UI built as strings.
 */

/** A timestamp as a relative label, falling back to a date after a week. */
export function formatDate(date: Date): string {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** The date part of a timestamp, in the local timezone, as `YYYY-MM-DD`. */
export function localDateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Escape text for interpolation into HTML.
 *
 * Uses the DOM's own escaping rather than a substitution table, so it cannot
 * disagree with the parser that will read the result back.
 */
export function escapeHtml(value: string): string {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}
