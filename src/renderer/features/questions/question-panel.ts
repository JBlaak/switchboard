/**
 * The question panel: Claude's questions as a sheet over the terminal area,
 * with Patch beside them.
 *
 * One panel, rebound to whichever session's set is on screen. It owns no
 * state of its own worth keeping — the draft and the view mode live on the
 * store's entry — so binding another session's entry is all a session switch
 * takes, and coming back finds the draft where it was left.
 *
 * Every way of answering (keys, clicks, typing) becomes a `reduceDraft`
 * action; the panel repaints from the draft that comes back and plays the
 * event. The DOM for a question is built once when it comes on screen and
 * repainted in place after that, so the Other field keeps its caret and the
 * entrance animations are not restarted by a keypress.
 */
import { mountPatch } from '@jblaak/patch';
import type { PatchHandle, PatchSky } from '@jblaak/patch';
import {
  answeredCount, displayLabel, isAnswered, isRecommended, reduceDraft,
} from '../../../domain/questions/answer-draft';
import { questionBeat } from '../../../domain/companion/question-beats';
import { timeOfDay } from '../../../domain/companion/patch';
import { answeredFoot, keyHints, questionCounter } from './question-copy';
import {
  SHEET_SETTLE_MS, patchArrive, popMark, questionIn, questionOut, settle,
} from './question-motion';
import type { DraftAction, DraftEvent } from '../../../domain/questions/answer-draft';
import type { QuestionBeat, QuestionMoment } from '../../../domain/companion/question-beats';
import type { Question } from '../../../domain/questions/question';
import type { QuestionEntry } from '../../state/question-store';
import type { Direction } from './question-motion';

/** Why a set is coming on screen, which decides how Patch greets it. */
export type ShowReason =
  /** First time this set is shown. */
  | 'arrived'
  /** Back from the terminal view. */
  | 'returned'
  /** The user switched to this session; the set was already up there. */
  | 'switched';

export interface QuestionPanelHooks {
  /** Everything is answered and the user asked to send. */
  submit(entry: QuestionEntry): void;
  /** Esc: answer in the terminal instead. */
  toTerminal(entry: QuestionEntry): void;
}

export interface QuestionPanel {
  element: HTMLElement;
  /** The entry on the panel, whether or not it is up. */
  readonly entry: QuestionEntry | null;
  readonly isUp: boolean;
  show(entry: QuestionEntry, reason: ShowReason): void;
  hide(): void;
  /** Patch reacts to something that did not come from the panel (the doze timer). */
  say(moment: QuestionMoment): void;
  /** Put the keyboard on the panel (or the Other field, if that is where the cursor is). */
  focus(): void;
  /** The weather to dress Patch for. */
  setSky(sky: PatchSky | null): void;
}

const CHECK_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>';

/** The last thing Patch said beside each set, replayed when the user switches back to it. */
const lastBeats = new WeakMap<QuestionEntry, QuestionBeat>();

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

export function createQuestionPanel(hooks: QuestionPanelHooks): QuestionPanel {
  // ── Static markup ──
  const sheet = make('section', 'qp');
  sheet.tabIndex = -1;
  sheet.setAttribute('aria-label', 'Questions from Claude');
  sheet.setAttribute('aria-hidden', 'true');
  sheet.inert = true;

  const inner = make('div', 'qp-inner');

  const patchCol = make('div', 'qp-patch-col');
  const patchStage = make('div', 'qp-patch');
  const status = make('div', 'qp-sr');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const foot = make('span', 'qp-foot');
  patchCol.append(patchStage, foot, status);

  const col = make('div', 'qp-col');
  const tabs = make('nav', 'qp-tabs');
  tabs.setAttribute('aria-label', 'Questions');

  const block = make('div', 'qp-q');
  const head = make('div', 'qp-head');
  const counter = make('span', 'qp-counter');
  const title = make('h1', 'qp-question');
  head.append(counter, title);
  const group = make('div', 'qp-options');
  group.setAttribute('role', 'group');
  block.append(head, group);

  const footer = make('div', 'qp-footer');
  const hints = make('span', 'qp-hints');
  const spacer = make('span', 'qp-spacer');
  const back = make('button', 'qp-back', 'Back');
  back.type = 'button';
  back.tabIndex = -1;
  const primary = make('button', 'qp-primary');
  primary.type = 'button';
  primary.tabIndex = -1;
  const primaryLabel = make('span', 'qp-primary-label');
  const enterKey = make('span', 'qp-primary-key', '↵');
  enterKey.setAttribute('aria-hidden', 'true');
  primary.append(primaryLabel, enterKey);
  footer.append(hints, spacer, back, primary);

  col.append(tabs, block, footer);
  inner.append(patchCol, col);
  sheet.appendChild(inner);

  const patch: PatchHandle = mountPatch(patchStage, { onPoke: poke });
  let sky: PatchSky | null = null;

  // ── What is on screen ──
  let entry: QuestionEntry | null = null;
  let up = false;
  /** The question built into the DOM; trails `draft.step` while one leaves. */
  let shownStep = 0;
  /** A question is leaving: keys are held until the next one is in. */
  let leaving = false;
  /** Bumped per bind, so a swap that outlives its entry does not land on another. */
  let generation = 0;

  let rows: HTMLButtonElement[] = [];
  let otherRow: HTMLLabelElement | null = null;
  let otherInput: HTMLInputElement | null = null;
  let tabButtons: HTMLButtonElement[] = [];

  const questions = (): Question[] => entry?.pending.questions ?? [];

  // ── Building ──

  function buildTabs(): void {
    const qs = questions();
    tabs.style.setProperty('--qp-tab-count', String(qs.length));
    tabButtons = qs.map((q, i) => {
      const tab = make('button', 'qp-tab');
      tab.type = 'button';
      tab.tabIndex = -1;
      const bar = make('span', 'qp-tab-bar');
      bar.setAttribute('aria-hidden', 'true');
      bar.appendChild(make('span', 'qp-tab-fill'));
      tab.append(bar, make('span', 'qp-tab-label', q.header || `Question ${i + 1}`));
      tab.addEventListener('click', () => dispatch({ kind: 'goto', step: i }));
      return tab;
    });
    tabs.replaceChildren(...tabButtons);
  }

  function buildQuestion(): void {
    const qs = questions();
    const q = qs[shownStep];
    if (!q) return;
    counter.textContent = questionCounter(shownStep, qs.length, q);
    title.textContent = q.question;
    group.setAttribute('aria-label', q.question);
    group.classList.toggle('is-multi', q.multiSelect);

    rows = q.options.map((option, i) => {
      const row = make('button', 'qp-option');
      row.type = 'button';
      row.tabIndex = -1;
      row.dataset.row = String(i);

      const key = make('span', 'qp-key', String(i + 1));
      key.setAttribute('aria-hidden', 'true');

      const text = make('span', 'qp-option-text');
      const labelLine = make('span', 'qp-option-line');
      labelLine.appendChild(make('span', 'qp-option-label', displayLabel(option.label)));
      if (isRecommended(option.label)) labelLine.appendChild(make('span', 'qp-chip', 'Recommended'));
      text.appendChild(labelLine);
      if (option.description) text.appendChild(make('span', 'qp-option-desc', option.description));

      row.append(key, text, buildMark());
      row.addEventListener('click', () => dispatch({ kind: 'click', row: i }));
      return row;
    });

    const n = q.options.length;
    otherRow = make('label', 'qp-option qp-other');
    const key = make('span', 'qp-key', String(n + 1));
    key.setAttribute('aria-hidden', 'true');
    const name = make('span', 'qp-option-label', 'Other');
    otherInput = make('input', 'qp-other-input');
    otherInput.type = 'text';
    otherInput.placeholder = 'Type your own answer…';
    otherInput.setAttribute('aria-label', 'Other answer');
    otherInput.value = entry?.draft.other[shownStep] ?? '';
    otherInput.addEventListener('focus', () => {
      // Our own focus after the cursor moved here is not a new choice.
      if (entry && entry.draft.cursor !== n) dispatch({ kind: 'focus-other' });
    });
    otherInput.addEventListener('input', () => {
      if (otherInput) dispatch({ kind: 'type', text: otherInput.value });
    });
    otherRow.append(key, name, otherInput, buildMark());

    group.replaceChildren(...rows, otherRow);

    hints.replaceChildren(...keyHints(q).map(({ key: k, does }) => {
      const hint = make('span', 'qp-hint');
      hint.append(make('kbd', 'qp-kbd', k), document.createTextNode(does));
      return hint;
    }));
  }

  function buildMark(): HTMLElement {
    const mark = make('span', 'qp-mark');
    mark.setAttribute('aria-hidden', 'true');
    mark.innerHTML = CHECK_SVG;
    return mark;
  }

  // ── Painting ──

  /** `pop` off when the rows were just built: nothing was chosen just now. */
  function paint(pop = true): void {
    if (!entry) return;
    const qs = questions();
    const q = qs[shownStep];
    if (!q) return;
    const { draft } = entry;
    const n = q.options.length;
    const picks = draft.picks[shownStep] ?? [];
    const otherText = draft.other[shownStep] ?? '';
    // While a question leaves, the cursor and picks belong to the next one.
    const cursor = draft.step === shownStep ? draft.cursor : -1;

    tabButtons.forEach((tab, i) => {
      const current = i === shownStep;
      tab.classList.toggle('is-current', current);
      tab.classList.toggle('is-done', isAnswered(qs, draft, i));
      if (current) tab.setAttribute('aria-current', 'step');
      else tab.removeAttribute('aria-current');
    });

    rows.forEach((row, i) => paintRow(row, picks.includes(q.options[i].label), cursor === i, pop));
    if (otherRow) paintRow(otherRow, otherText.trim() !== '', cursor === n, pop);
    if (otherInput && otherInput.value !== otherText) otherInput.value = otherText;

    const done = answeredCount(qs, draft);
    foot.textContent = answeredFoot(done, qs.length);

    const isLast = shownStep === qs.length - 1;
    primaryLabel.textContent = isLast ? 'Send answers' : 'Next';
    const blocked = isLast ? done < qs.length : !isAnswered(qs, draft, shownStep);
    primary.setAttribute('aria-disabled', String(blocked));
    back.hidden = shownStep === 0;
  }

  function paintRow(row: HTMLElement, selected: boolean, cursor: boolean, pop: boolean): void {
    const was = row.classList.contains('is-selected');
    row.classList.toggle('is-selected', selected);
    row.classList.toggle('is-cursor', cursor);
    if (row instanceof HTMLButtonElement) row.setAttribute('aria-pressed', String(selected));
    if (pop && selected && !was) {
      const mark = row.querySelector<HTMLElement>('.qp-mark svg');
      if (mark) popMark(mark);
    }
  }

  /**
   * Keep the keyboard where the cursor is: in the Other field when it is on
   * that row, otherwise on the panel itself. Patch keeps focus if it has it.
   */
  function syncFocus(): void {
    if (!entry || !up || leaving) return;
    const onOther = entry.draft.cursor === questions()[shownStep]?.options.length;
    const active = document.activeElement;
    if (onOther && otherInput) {
      if (active !== otherInput) otherInput.focus({ preventScroll: true });
      return;
    }
    if (active instanceof HTMLElement && active.closest('.patch-poke')) return;
    if (active !== sheet) sheet.focus({ preventScroll: true });
  }

  // ── Acting ──

  function dispatch(action: DraftAction): void {
    if (!entry || !up || leaving || entry.sending) return;
    const before = entry.draft;
    const { draft, event } = reduceDraft(questions(), before, action);
    entry.draft = draft;
    if (draft.step !== shownStep) {
      void swap(draft.step > shownStep ? 'fwd' : 'back', event);
      return;
    }
    paint();
    syncFocus();
    if (event) react(event);
  }

  /** The current question leaves, then the draft's question comes in. */
  async function swap(dir: Direction, event: DraftEvent | null): Promise<void> {
    const mine = generation;
    leaving = true;
    // The Other field would keep typing into a question on its way out.
    if (document.activeElement === otherInput) sheet.focus({ preventScroll: true });
    paint();
    await questionOut(block, dir);
    if (mine !== generation || !entry) return;
    leaving = false;
    shownStep = entry.draft.step;
    buildQuestion();
    paint(false);
    questionIn(block, [...rows, ...(otherRow ? [otherRow] : [])], dir);
    syncFocus();
    if (event) react(event);
  }

  function react(event: DraftEvent): void {
    if (!entry) return;
    if (event.kind === 'submit') {
      entry.sending = true;
      hooks.submit(entry);
      return;
    }
    say(event);
  }

  function say(moment: QuestionMoment): void {
    if (!entry) return;
    play(questionBeat(moment));
  }

  function play(beat: QuestionBeat): void {
    if (!entry) return;
    lastBeats.set(entry, beat);
    status.textContent = beat.line;
    patch.appear({ ...beat, time: timeOfDay(new Date().getHours()), sky });
  }

  function poke(): void {
    if (!entry) return;
    entry.pokes++;
    say({ kind: 'poked', count: entry.pokes });
  }

  // ── Keys ──
  // On the panel rather than the window, so they can only act while the
  // panel has the keyboard. Unmodified keys stop here — none of them is the
  // terminal's or a global shortcut's to have (a bare N would otherwise start
  // a quick session); Cmd/Ctrl/Alt combinations go on to the app.
  sheet.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
    if (e.key === 'Tab') return;
    e.stopPropagation();
    if (!entry || !up) return;
    if (leaving || entry.sending) { e.preventDefault(); return; }

    const target = e.target as HTMLElement | null;
    // Enter and Space on Patch poke it, as a button should.
    if ((e.key === 'Enter' || e.key === ' ') && target?.closest('.patch-poke')) return;

    const inOther = target === otherInput;
    const n = questions()[shownStep]?.options.length ?? 0;
    const act = (action: DraftAction): void => { e.preventDefault(); dispatch(action); };

    switch (e.key) {
      case 'ArrowDown': return act({ kind: 'move', by: 1 });
      case 'ArrowUp': return act({ kind: 'move', by: -1 });
      case 'Enter': return act({ kind: 'next' });
      case 'Escape':
        e.preventDefault();
        hooks.toTerminal(entry);
        return;
    }
    // Typing an answer of one's own: numbers, space and ←/→ are the text's.
    if (inOther) return;

    if (/^[1-9]$/.test(e.key) && Number(e.key) <= n + 1) return act({ kind: 'press', row: Number(e.key) - 1 });
    if (e.key === ' ') return act({ kind: 'space' });
    if (e.key === 'ArrowLeft') return act({ kind: 'back' });
    if (e.key === 'ArrowRight') return act({ kind: 'next' });
  });

  back.addEventListener('click', () => dispatch({ kind: 'back' }));
  primary.addEventListener('click', () => dispatch({ kind: 'next' }));

  // ── Showing ──

  function show(next: QuestionEntry, reason: ShowReason): void {
    generation++;
    entry = next;
    leaving = false;
    shownStep = next.draft.step;
    buildTabs();
    buildQuestion();
    paint(false);

    up = true;
    sheet.inert = false;
    sheet.classList.add('is-up');
    sheet.setAttribute('aria-hidden', 'false');
    // Resolve the sheet's new style before anything inside it starts to
    // animate. Chromium caches an animated element's base style, inherited
    // values included, so an entrance started in the same frame keeps the
    // `visibility: hidden` the sheet had a moment ago — and the question stays
    // invisible after its animation ends. Only the second showing hit it.
    void sheet.offsetWidth;

    // A switch lands on the set as it was, with nothing to make an entrance;
    // it also clears a swap that was cut short by switching away mid-way.
    if (reason === 'switched') settle(block);
    else questionIn(block, [...rows, ...(otherRow ? [otherRow] : [])], 'fwd', SHEET_SETTLE_MS);

    if (reason === 'arrived' || !next.greeted) {
      next.greeted = true;
      patchArrive(patchStage);
      say({ kind: 'arrived', count: next.pending.questions.length });
    } else if (reason === 'returned') {
      say({ kind: 'returned' });
    } else {
      play(lastBeats.get(next) ?? questionBeat({ kind: 'returned' }));
    }

    focus();
  }

  function hide(): void {
    if (!up) return;
    up = false;
    generation++;
    leaving = false;
    sheet.classList.remove('is-up');
    sheet.setAttribute('aria-hidden', 'true');
    // Out of the tab order and unclickable while it fades, and after.
    sheet.inert = true;
  }

  function focus(): void {
    if (!up) return;
    sheet.focus({ preventScroll: true });
    syncFocus();
  }

  return {
    element: sheet,
    get entry() { return entry; },
    get isUp() { return up; },
    show,
    hide,
    say,
    focus,
    setSky(next) { sky = next; },
  };
}
