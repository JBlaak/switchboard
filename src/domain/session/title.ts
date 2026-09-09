/**
 * Which of a session's several names wins.
 *
 * A session can carry up to four: a rename the user typed in Switchboard, a
 * `/title` the user typed in the CLI, an AI-generated title the CLI wrote, and
 * the first user message. The precedence between them was applied in three
 * places — the incremental indexer, the cold-start indexer, and the sidebar —
 * and drifting copies are how an AI title ends up overwriting a user's rename.
 */
import type { Session, SessionMeta } from './session';

/** The name inputs a title decision is made from. */
export interface TitleSources {
  /** The rename the user typed in Switchboard. */
  storedName?: string | null;
  /** `/title` in the CLI — a genuine user title, written into the transcript. */
  customTitle?: string | null;
  /** The CLI's own generated title. */
  aiTitle?: string | null;
}

/**
 * The name to show, or '' when only the first prompt is available.
 *
 * Precedence: user rename > CLI `/title` > AI title. Deliberately excludes the
 * summary — callers that want a guaranteed label append it themselves, and the
 * search index needs the two parts separately.
 */
export function resolveSessionName(sources: TitleSources): string {
  return sources.storedName || sources.customTitle || sources.aiTitle || '';
}

/**
 * The title text a session is indexed under: its name plus its first prompt.
 *
 * Both go in so a search matches either what the user called the session or
 * what they actually asked it.
 */
export function searchTitleFor(sources: TitleSources, summary: string): string {
  const name = resolveSessionName(sources);
  return (name ? name + ' ' : '') + summary;
}

/**
 * The name to persist as the user-facing one after indexing a transcript.
 *
 * Only a CLI `/title` promotes — an AI title must never be written into the
 * user-name column or the next index pass would overwrite a rename the user
 * typed here. Returns null when nothing should be written.
 */
export function nameToPersist(session: Pick<Session, 'customTitle'>): string | null {
  return session.customTitle || null;
}

/** The title sources for a transcript, given whatever metadata is stored for it. */
export function titleSourcesFor(
  session: Pick<Session, 'customTitle' | 'aiTitle'>,
  meta: Pick<SessionMeta, 'name'> | null | undefined,
): TitleSources {
  return {
    storedName: meta?.name ?? null,
    customTitle: session.customTitle,
    aiTitle: session.aiTitle,
  };
}

/**
 * Tidy a name for display: drop the plan-implementation preamble and any
 * markup that leaked in from a transcript.
 */
export function cleanDisplayName(name: string | null | undefined): string | null | undefined {
  if (!name) return name;
  const prefix = 'Implement the following plan:';
  let cleaned = name.startsWith(prefix) ? name.slice(prefix.length).trim() : name;
  // Strip XML/HTML-like tags (e.g. <command>, </message>, <system-reminder>)
  cleaned = cleaned.replace(/<\/?[a-zA-Z][a-zA-Z0-9_-]*(?:\s[^>]*)?\/?>/g, ' ');
  return cleaned.replace(/\s+/g, ' ').trim();
}
