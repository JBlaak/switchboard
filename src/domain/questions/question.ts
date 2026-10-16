/**
 * The questions Claude asks with its AskUserQuestion tool, and the hook that
 * lets Switchboard answer them.
 *
 * A Claude session runs the plain CLI in a PTY, so the only seam into a
 * question is a PreToolUse hook. Switchboard passes one per launch with
 * `--settings`: an `http` hook that posts the tool input to a server in the
 * main process and waits. Answering means replying with the tool input plus an
 * `answers` map; the CLI then never shows its own prompt. Not answering in time
 * makes the CLI give up on the hook and ask in the terminal, as it always did.
 */

/** One choice on a question. */
export interface QuestionOption {
  /**
   * What the option says, and what goes back to Claude when it is picked.
   * Claude marks the one it would pick with a trailing "(Recommended)"; that
   * suffix stays in the label sent back and is only stripped for display.
   */
  label: string;
  /** May be empty: Claude is asked for one but does not always give it. */
  description: string;
  /** Optional mockup or code shown beside the option; not rendered yet. */
  preview?: string;
}

export interface Question {
  /** The full question, and the key its answer is sent back under. */
  question: string;
  /** A chip-sized label (12 characters at most). May be empty. */
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

/** What a hook request carried, once checked. */
export interface AskedQuestions {
  toolUseId: string;
  questions: Question[];
  /**
   * The tool input exactly as received. The hook's answer replaces the whole
   * input, so it is echoed back with `answers` added, never rebuilt.
   */
  toolInput: Record<string, unknown>;
}

/** Question text → the answer: an option label, labels joined with ", ", or free text. */
export type Answers = Record<string, string>;

/** A set of questions a session is blocked on, as the renderer sees it. */
export interface PendingQuestions {
  /** The session's current id (what the renderer knows it as). */
  sessionId: string;
  toolUseId: string;
  questions: Question[];
  /** Epoch ms the hook request arrived. */
  askedAt: number;
  /** Epoch ms the CLI gives up on the hook and asks in the terminal instead. */
  deadline: number;
}

/**
 * How a pending set ended: answered from Switchboard, or withdrawn because the
 * hook request went away (timed out, session stopped, CLI interrupted).
 */
export type QuestionsOutcome = 'answered' | 'withdrawn';

export interface QuestionsSettled {
  sessionId: string;
  toolUseId: string;
  outcome: QuestionsOutcome;
}

/** How long the CLI waits on the hook before asking in the terminal. */
export const QUESTION_HOOK_TIMEOUT_SECONDS = 600;

/** The CLI shows this in its spinner while the hook waits. */
export const QUESTION_HOOK_STATUS = 'Waiting for your answer in Switchboard';

/** The header carrying the per-run secret, so only our own sessions can post. */
export const QUESTION_HOOK_TOKEN_HEADER = 'X-Switchboard-Token';

/**
 * Check a hook request body and pull out the questions.
 *
 * Null for anything that is not an AskUserQuestion PreToolUse call with at
 * least one well-formed question (a question string and two or more labelled
 * options). Missing `header`/`description` become empty strings and a missing
 * `multiSelect` is false, since the CLI does not always send them.
 */
export function parseQuestionHookInput(body: unknown): AskedQuestions | null {
  if (!isRecord(body)) return null;
  if (body.hook_event_name !== 'PreToolUse' || body.tool_name !== 'AskUserQuestion') return null;
  const toolInput = body.tool_input;
  if (!isRecord(toolInput) || !Array.isArray(toolInput.questions)) return null;

  const questions: Question[] = [];
  for (const raw of toolInput.questions) {
    const question = parseQuestion(raw);
    if (!question) return null;
    questions.push(question);
  }
  if (questions.length === 0) return null;

  const toolUseId = typeof body.tool_use_id === 'string' ? body.tool_use_id : '';
  return { toolUseId, questions, toolInput };
}

function parseQuestion(raw: unknown): Question | null {
  if (!isRecord(raw) || typeof raw.question !== 'string' || !raw.question.trim()) return null;
  if (!Array.isArray(raw.options)) return null;
  const options: QuestionOption[] = [];
  for (const option of raw.options) {
    if (!isRecord(option) || typeof option.label !== 'string' || !option.label.trim()) return null;
    options.push({
      label: option.label,
      description: typeof option.description === 'string' ? option.description : '',
      ...(typeof option.preview === 'string' ? { preview: option.preview } : {}),
    });
  }
  if (options.length < 2) return null;
  return {
    question: raw.question,
    header: typeof raw.header === 'string' ? raw.header : '',
    options,
    multiSelect: raw.multiSelect === true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The JSON a hook replies with to answer the questions.
 *
 * `{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision:
 * 'allow', permissionDecisionReason: 'Answered in Switchboard', updatedInput:
 * { ...toolInput, answers } } }` — `allow` alone is not enough for this tool,
 * the CLI needs the answers in `updatedInput`.
 */
export function questionHookResponse(toolInput: Record<string, unknown>, answers: Answers): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'Answered in Switchboard',
      updatedInput: { ...toolInput, answers },
    },
  };
}

/**
 * The `--settings` value that installs the hook for one session.
 *
 * A PreToolUse hook matched to AskUserQuestion only, of type `http`, posting to
 * `url` with the token header, a `statusMessage` of QUESTION_HOOK_STATUS and a
 * `timeout` of QUESTION_HOOK_TIMEOUT_SECONDS. Hooks merge with the user's own
 * settings rather than replacing them.
 */
export function questionHookSettings(url: string, token: string): string {
  return JSON.stringify({
    hooks: {
      PreToolUse: [{
        matcher: 'AskUserQuestion',
        hooks: [{
          type: 'http',
          url,
          headers: { [QUESTION_HOOK_TOKEN_HEADER]: token },
          statusMessage: QUESTION_HOOK_STATUS,
          timeout: QUESTION_HOOK_TIMEOUT_SECONDS,
        }],
      }],
    },
  });
}
