/**
 * Asking a running session's questions, the way Claude's hook does.
 *
 * Each Claude session is launched with `--settings` holding a PreToolUse
 * `http` hook: a URL on the app's loopback server and the per-run token header
 * (src/domain/questions/question.ts). The fake `claude` records that argument,
 * so the test reads the hook from the launch and posts to it itself — exactly
 * the request the real CLI would make, held open until the user answers in
 * the question panel or the request is abandoned.
 */
import { fakeClaude } from './fake-cli';
import type { FixtureHome } from './fixture-home';

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface AskedQuestion {
  question: string;
  /** A chip-sized label, 12 characters at most. */
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

export interface PendingAsk {
  /** The hook's reply: `{}` for no decision, or the answers in `updatedInput`. */
  response: Promise<Record<string, unknown>>;
  /** Drop the request, as the CLI does when it gives up or is interrupted. */
  abandon(): void;
  toolUseId: string;
}

/**
 * Post an AskUserQuestion to the session's hook and return without waiting
 * for the answer.
 *
 * The session must be running under the fake `claude` (it is the launch that
 * carries the hook's address).
 */
export async function askQuestions(
  home: FixtureHome,
  sessionId: string,
  questions: AskedQuestion[],
  { toolUseId = 'toolu_e2e_' + Math.random().toString(36).slice(2, 10) } = {},
): Promise<PendingAsk> {
  const launch = await fakeClaude(home, sessionId).launched();
  const hook = launch.settings?.hooks?.PreToolUse?.find(h => h.matcher === 'AskUserQuestion')?.hooks[0];
  if (!hook) throw new Error(`session ${sessionId} was launched without a question hook`);

  const controller = new AbortController();
  const response = fetch(hook.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...hook.headers },
    body: JSON.stringify({
      session_id: sessionId,
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_use_id: toolUseId,
      tool_input: { questions },
    }),
    signal: controller.signal,
  }).then(async res => {
    if (!res.ok) throw new Error(`question hook answered ${res.status}`);
    return await res.json() as Record<string, unknown>;
  });
  // An abandoned request rejects; that is the point of abandoning it.
  response.catch(() => {});

  return { response, abandon: () => controller.abort(), toolUseId };
}
