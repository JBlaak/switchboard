/**
 * Running whisper.cpp's `whisper-cli` and reading what it prints.
 *
 * It comes from Homebrew (`brew install whisper-cpp`). An app started from
 * the Finder has launchd's PATH, without Homebrew's directories, so those are
 * looked in first and PATH after.
 */

export const WHISPER_BINARY = 'whisper-cli';

/** Apple silicon's Homebrew, Intel's, then wherever PATH says. */
export function whisperCandidates(pathEnv: string | undefined): string[] {
  const dirs = ['/opt/homebrew/bin', '/usr/local/bin', ...(pathEnv ?? '').split(':').filter(dir => dir !== '')];
  return [...new Set(dirs)].map(dir => `${dir.replace(/\/+$/, '')}/${WHISPER_BINARY}`);
}

/** Whisper's prompt: the vocabulary, as text it reads as having come before. */
export function whisperPrompt(vocabulary: readonly string[]): string {
  return vocabulary.join(', ');
}

/**
 * The argv after `whisper-cli`. Metal and the thread count are left at their
 * defaults; `-nt` and `-np` leave only the transcript on stdout, and `-l auto`
 * lets Whisper tell Dutch from English per recording.
 */
export function whisperArgs(request: { model: string; wav: string; prompt: string }): string[] {
  return [
    '-m', request.model,
    '-f', request.wav,
    '-l', 'auto',
    '-nt',
    '-np',
    ...(request.prompt ? ['--prompt', request.prompt] : []),
  ];
}

/**
 * The transcript in what `whisper-cli` printed, or '' when nothing was said.
 *
 * On silence and noise Whisper writes markers instead of words —
 * `[BLANK_AUDIO]`, `[ Silence ]`, `(music)`, `*coughs*` — which are no one's
 * dictation, so they are taken out and what is left decides.
 */
export function readTranscript(stdout: string): string {
  return stdout
    .split('\n')
    .map(line => line
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/^\s*(\([^)]*\)|\*[^*]*\*)\s*$/, ' ')
      .trim())
    .filter(line => line !== '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Why `whisper-cli` failed, from its stderr: it prints `error: …` and then
 * its whole usage text, so the error line is looked for rather than the last.
 */
export function whisperFailure(stderr: string, fallback: string): string {
  const lines = stderr.split('\n').map(line => line.trim()).filter(line => line !== '');
  const error = lines.find(line => /^error\b/i.test(line));
  return (error ?? fallback).replace(/^error:\s*/i, '');
}
