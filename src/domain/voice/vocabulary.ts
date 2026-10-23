/**
 * The words a dictation is likely to hold that Whisper and the cleanup would
 * otherwise get wrong: the project names the user talks about, and the names
 * of the tools themselves.
 *
 * Whisper reads its prompt as the text that came before, so a word in it is
 * more likely to be heard as spelled there. Its prompt is limited to a couple
 * of hundred tokens, so the list is capped, with the session's own project
 * first so it is never the one cut.
 */

/** Always there: what the user is talking to and about. */
export const FIXED_VOCABULARY = ['Claude', 'Switchboard', 'Patch'];

/** Enough for anyone's project list and well inside Whisper's prompt. */
export const MAX_VOCABULARY = 40;

/** The fixed words, the session's project, then the other projects; without repeats, ignoring case. */
export function voiceVocabulary(sessionProject: string | null, projects: readonly string[]): string[] {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const word of [...FIXED_VOCABULARY, ...(sessionProject ? [sessionProject] : []), ...projects]) {
    const trimmed = word.trim();
    const key = trimmed.toLowerCase();
    if (trimmed === '' || seen.has(key)) continue;
    seen.add(key);
    words.push(trimmed);
    if (words.length === MAX_VOCABULARY) break;
  }
  return words;
}
