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
import { EVENT } from '../../src/ipc/channels';
import { fakeClaude } from './fake-cli';
import { FIXTURE_NOW } from './fixture-home';
import { pushEvent } from './main-process';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
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

/**
 * Tell the renderer a set is pending, as main would, without a hook request
 * behind it.
 *
 * For what a real ask cannot set up: a deadline a few minutes off (the
 * renderer's clock is frozen at FIXTURE_NOW, so `deadlineInMs` is measured
 * from there), or a tool-use id the renderer has already seen settled.
 * Answering such a set reaches no hook; main says so and the set is withdrawn.
 */
export async function pushQuestions(
  app: ElectronApplication,
  sessionId: string,
  questions: AskedQuestion[],
  { toolUseId = 'toolu_push_' + Math.random().toString(36).slice(2, 10), deadlineInMs = 600_000 } = {},
): Promise<string> {
  const pending = {
    sessionId,
    toolUseId,
    questions: questions.map(q => ({
      question: q.question,
      header: q.header ?? '',
      multiSelect: !!q.multiSelect,
      options: q.options.map(o => ({ label: o.label, description: o.description ?? '' })),
    })),
    askedAt: FIXTURE_NOW,
    deadline: FIXTURE_NOW + deadlineInMs,
  };
  await pushEvent(app, EVENT.questionsAsked, pending);
  return toolUseId;
}

/** Tell the renderer a set is over, as main would. */
export async function pushSettled(
  app: ElectronApplication, sessionId: string, toolUseId: string, outcome: 'answered' | 'withdrawn' = 'withdrawn',
): Promise<void> {
  await pushEvent(app, EVENT.questionsSettled, { sessionId, toolUseId, outcome });
}

/**
 * The question sheet, by its label. It is a `<section>` with an accessible
 * name, so it is a region while it is up — and out of the accessibility tree
 * (aria-hidden) while it is not, which makes this locator miss it then.
 */
export function questionPanel(page: Page): Locator {
  return page.getByRole('region', { name: 'Questions from Claude' });
}

/**
 * The sheet whether or not it is up, for asserting on how it hides itself.
 * Found by its label attribute, since the role is gone while it is hidden.
 */
export function questionSheet(page: Page): Locator {
  return page.locator('[aria-label="Questions from Claude"]');
}

/** An option on the question on screen, by (part of) its label. */
export function option(page: Page, label: string | RegExp): Locator {
  return questionPanel(page).getByRole('button', { name: label });
}

/** One Web Animation the page started, as `recordAnimations` saw it. */
export interface RecordedAnimation {
  /** The animated element's tag and classes, e.g. `div.qp-q`. */
  target: string;
  duration: number;
  delay: number;
  /** `performance.now()` when it was started. */
  at: number;
}

/**
 * Start recording every `Element.animate` call in the window.
 *
 * The panel's motion runs through the Web Animations API and is over in a few
 * hundred milliseconds, too quick to catch by polling `getAnimations()`; this
 * notes each one as it starts instead. The targets are named by tag and
 * class because an animated element is often an anonymous wrapper with no
 * role; the classes are only read back, never used to find anything.
 */
export async function recordAnimations(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __animations: unknown[] };
    w.__animations = [];
    const original = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, keyframes, options) {
      const timing = typeof options === 'number' ? { duration: options } : (options ?? {});
      const classes = this.getAttribute('class') ?? '';
      w.__animations.push({
        target: [this.tagName.toLowerCase(), ...classes.split(/\s+/).filter(Boolean)].join('.'),
        duration: Number(timing.duration ?? 0),
        delay: Number(timing.delay ?? 0),
        at: performance.now(),
      });
      return original.call(this, keyframes, options);
    };
  });
}

/** The animations recorded so far, oldest first; `clear` empties the record. */
export async function recordedAnimations(page: Page, { clear = false } = {}): Promise<RecordedAnimation[]> {
  return await page.evaluate((clear) => {
    const w = window as unknown as { __animations: RecordedAnimation[] };
    const list = [...w.__animations];
    if (clear) w.__animations.length = 0;
    return list;
  }, clear);
}

/** Where the keyboard is: in the question sheet, in a terminal, or elsewhere. */
export async function focusIsIn(page: Page): Promise<'panel' | 'terminal' | 'other'> {
  return await page.evaluate(() => {
    const active = document.activeElement;
    if (active?.closest('[aria-label="Questions from Claude"]')) return 'panel';
    if (active?.classList.contains('xterm-helper-textarea')) return 'terminal';
    return 'other';
  });
}
