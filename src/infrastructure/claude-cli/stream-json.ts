/**
 * Talking to a `claude -p` process in stream-json, for a warm call (S2).
 *
 * In this mode the CLI boots and then waits on stdin for a user message,
 * printing nothing until one arrives — so a process can be started before the
 * request without spending anything on the model. It answers with one JSON
 * event per line, the last of them a `result` event that carries the same
 * fields `--output-format json` prints. Handing that event on as the run's
 * stdout is what keeps the readers (`readRouteRun`) the same for both paths.
 */
import type { ClaudeRun } from '../../domain/ask/route';

/** Flags whose value the stream-json ones replace. */
const REPLACED = new Set(['--input-format', '--output-format']);

/**
 * Boot args turned into a process waiting for its message: the cold call's
 * `--output-format json` is dropped for the stream-json flags.
 */
export function streamJsonArgs(bootArgs: readonly string[]): string[] {
  const kept = bootArgs.filter((arg, i) => !REPLACED.has(arg) && !REPLACED.has(bootArgs[i - 1]));
  return [...kept, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
}

/** The one stdin line that hands the process its prompt. */
export function userMessageLine(prompt: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n';
}

/**
 * The run once the `result` event is in, or null while it isn't.
 *
 * The process is still alive at that point (it waits for another message), so
 * there is no exit code yet: it is the one a cold call would have exited
 * with, 1 for an error result and 0 otherwise.
 */
export function finishedRun(stdout: string, stderr: string): ClaudeRun | null {
  const result = resultEvent(stdout);
  if (!result) return null;
  return { exitCode: result.is_error === true ? 1 : 0, stdout: JSON.stringify(result) + '\n', stderr };
}

/**
 * The run for a process that ended before its `result` event: killed, or
 * failed on its way up. The events it did print are left out, so a failure
 * reads what the CLI said rather than its `init` event.
 */
export function endedRun(stdout: string, exitCode: number | null, stderr: string): ClaudeRun {
  const said = stdout.split('\n').filter(line => line.trim() !== '' && !line.trim().startsWith('{')).join('\n');
  return { exitCode, stdout: said, stderr };
}

/** The first complete line that is a `result` event. */
function resultEvent(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split('\n');
  // The last piece has no newline after it yet, so it may still be arriving.
  for (const line of lines.slice(0, -1)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null && (parsed as { type?: unknown }).type === 'result') {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Not an event: skipped, like any other stray line.
    }
  }
  return null;
}
