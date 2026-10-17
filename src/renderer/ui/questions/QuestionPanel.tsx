/**
 * The question panel: Claude's questions as a sheet over the terminal area,
 * with Patch beside them.
 *
 * One panel, showing whichever session's set is on screen. It owns nothing
 * worth keeping — the draft, the view and what Patch said live on the store's
 * entry for the set — so a session switch only changes which entry it reads,
 * and coming back finds the draft where it was left.
 *
 * What stays here is the choreography the store has no business holding:
 * which question is drawn while the next one waits to come in (`shown`
 * trails the draft's step through a swap, and keys are held until it lands),
 * which entrance to play, and Patch, an imperative handle mounted once and
 * told what to say whenever the entry's `said` moves on.
 *
 * Keys are a native listener on the sheet rather than a React handler: the
 * sheet must stop unmodified keys from reaching the window's shortcuts, and
 * doing it at the element itself keeps that independent of where React
 * attaches its own listeners.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { mountPatch } from '@jblaak/patch';
import { answeredCount, isAnswered } from '../../../domain/questions/answer-draft';
import { dressingOn } from '../../../domain/companion/calendar';
import { questionBeat } from '../../../domain/companion/question-beats';
import { timeOfDay } from '../../../domain/companion/patch';
import { answeredFoot, keyHints, questionCounter } from '../../features/questions/question-copy';
import { panelKey } from '../../features/questions/question-keys';
import {
  SHEET_SETTLE_MS, patchArrive, questionIn, questionOut, settle,
} from '../../features/questions/question-motion';
import { getState, onEvent } from '../../state/app-store';
import { answer, chooseView, focusTerminal, greet, pokePatch, questionSky } from './actions';
import { OptionRow, OtherRow } from './QuestionRows';
import type { CSSProperties, JSX } from 'react';
import type { PatchHandle } from '@jblaak/patch';
import type { DraftAction } from '../../../domain/questions/answer-draft';
import type { PendingQuestions } from '../../../domain/questions/question';
import type { Answering } from '../../state/answers-slice';
import type { Direction } from '../../features/questions/question-motion';
import type { OnScreen } from './use-on-screen';

export interface QuestionPanelProps {
  screen: OnScreen;
  /** A set is coming up: the farewell must not sit over it. */
  onShow(): void;
}

interface Shown {
  pending: PendingQuestions;
  answering: Answering;
}

interface Entrance {
  token: number;
  /** `settle` lands as it is (a switch); `in` plays the entrance. */
  kind: 'in' | 'settle';
  dir: Direction;
  delay: number;
  /** Take the keyboard (a showing), or only keep it where the cursor is (a swap). */
  take: boolean;
}

export function QuestionPanel({ screen, onShow }: QuestionPanelProps): JSX.Element {
  const { up } = screen;
  const sheet = useRef<HTMLElement>(null);
  const block = useRef<HTMLDivElement>(null);
  const group = useRef<HTMLDivElement>(null);
  const patchStage = useRef<HTMLDivElement>(null);
  const otherInput = useRef<HTMLInputElement>(null);
  const patch = useRef<PatchHandle | null>(null);

  // While hidden the sheet keeps what it last showed, so it fades out with it.
  const last = useRef<Shown | null>(null);
  if (up && screen.pending && screen.answering) last.current = { pending: screen.pending, answering: screen.answering };
  const shown = last.current;
  const toolUseId = shown?.pending.toolUseId;
  const questions = shown?.pending.questions ?? [];
  const draft = shown?.answering.draft;

  /** The question drawn, per set; it trails `draft.step` while one leaves. */
  const [step, setStep] = useState<{ toolUseId: string | undefined; step: number }>({ toolUseId: undefined, step: 0 });
  const shownStep = step.toolUseId === toolUseId ? step.step : (draft?.step ?? 0);
  const [leaving, setLeaving] = useState(false);
  const leavingNow = useRef(false);
  const [entrance, setEntrance] = useState<Entrance | null>(null);
  /** Bumped per showing and hiding, so a swap that outlives its set does not land on another. */
  const generation = useRef(0);

  const q = questions[shownStep];
  const n = q?.options.length ?? 0;

  // What the handlers need, as of the last render.
  const live = useRef({ toolUseId, up, shownStep, n });
  live.current = { toolUseId, up, shownStep, n };

  // ── Acting ──

  /**
   * Keep the keyboard where the cursor is: in the Other field when it is on
   * that row, otherwise on the panel itself. Patch keeps focus if it has it.
   */
  function syncFocus(): void {
    const now = live.current;
    if (!now.toolUseId || !now.up || leavingNow.current) return;
    const entry = getState().answers.byToolUse[now.toolUseId];
    if (!entry || entry.draft.step !== now.shownStep) return;
    const active = document.activeElement;
    if (entry.draft.cursor === now.n && otherInput.current) {
      if (active !== otherInput.current) otherInput.current.focus({ preventScroll: true });
      return;
    }
    if (active instanceof HTMLElement && active.closest('.patch-poke')) return;
    if (active !== sheet.current) sheet.current?.focus({ preventScroll: true });
  }

  /**
   * A question is leaving, or about to: the draft has moved on from the
   * question drawn. The second half covers a key in the same task as the one
   * that moved it, before the swap has even started.
   */
  function swapping(draftStep: number | undefined): boolean {
    return leavingNow.current || (draftStep !== undefined && draftStep !== live.current.shownStep);
  }

  function act(action: DraftAction): void {
    const now = live.current;
    if (!now.toolUseId || !now.up) return;
    if (swapping(getState().answers.byToolUse[now.toolUseId]?.draft.step)) return;
    answer(now.toolUseId, action);
    syncFocus();
  }

  const handlers = useRef({ act, syncFocus });
  handlers.current = { act, syncFocus };

  // ── Patch, mounted once ──

  useEffect(() => {
    const handle = mountPatch(patchStage.current!, {
      onPoke: () => {
        const now = live.current;
        if (now.toolUseId) pokePatch(now.toolUseId);
      },
    });
    patch.current = handle;
    return () => {
      handle.destroy();
      if (patch.current === handle) patch.current = null;
    };
  }, []);

  // ── Keys ──
  // On the panel rather than the window, so they can only act while the
  // panel has the keyboard. Which keys stop here and what each does is
  // `panelKey`'s to say; this applies it.

  useEffect(() => {
    const el = sheet.current!;
    const onKey = (e: KeyboardEvent): void => {
      const now = live.current;
      const target = e.target as HTMLElement | null;
      const key = panelKey(e, {
        inOther: target === otherInput.current,
        onPatch: !!target?.closest('.patch-poke'),
        options: now.n,
      });
      if (key.does === 'pass') return;
      e.stopPropagation();
      if (!now.toolUseId || !now.up) return;
      const entry = getState().answers.byToolUse[now.toolUseId];
      if (swapping(entry?.draft.step) || !entry || entry.sending) { e.preventDefault(); return; }
      if (key.does === 'keep') return;

      e.preventDefault();
      if (key.does === 'terminal') chooseView(now.toolUseId, 'terminal');
      else handlers.current.act(key.action);
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, []);

  // ── Showing and hiding ──

  /** What the last render saw on screen, to tell an arrival, a return and a switch apart. */
  const before = useRef<{ up: boolean; toolUseId: string | undefined; view: string | undefined }>({
    up: false, toolUseId: undefined, view: undefined,
  });
  /** The line Patch last played: which set, and its `said` count. Cleared on hiding, so a re-show replays it. */
  const played = useRef<{ toolUseId: string; seq: number } | null>(null);
  /** The set Patch is about to greet, so its hello comes with the rise into the panel. */
  const arriving = useRef<string | null>(null);

  useLayoutEffect(() => {
    const prev = before.current;
    const onScreenId = screen.pending?.toolUseId;
    before.current = { up, toolUseId: onScreenId, view: screen.answering?.view };

    if (!up) {
      if (prev.up) {
        generation.current++;
        leavingNow.current = false;
        setLeaving(false);
        played.current = null;
      }
      return;
    }
    if (prev.up && prev.toolUseId === onScreenId) return;
    if (!shown || !onScreenId) return;

    generation.current++;
    leavingNow.current = false;
    setLeaving(false);
    setStep({ toolUseId: onScreenId, step: shown.answering.draft.step });
    onShow();
    // Resolve the sheet's new style before anything inside it starts to
    // animate. Chromium caches an animated element's base style, inherited
    // values included, so an entrance started in the same frame keeps the
    // `visibility: hidden` the sheet had a moment ago — and the question stays
    // invisible after its animation ends.
    void sheet.current?.offsetWidth;

    const returned = prev.toolUseId === onScreenId && prev.view === 'terminal';
    const greeted = shown.answering.greeted;
    // A switch lands on the set as it was, with nothing to make an entrance;
    // it also clears a swap that was cut short by switching away mid-way.
    const kind = greeted && !returned ? 'settle' : 'in';
    setEntrance(e => ({ token: (e?.token ?? 0) + 1, kind, dir: 'fwd', delay: SHEET_SETTLE_MS, take: true }));
    // Patch greets a set once, rising into the panel as it does.
    if (!greeted) {
      arriving.current = onScreenId;
      greet(onScreenId);
    }
  });

  // The entrance, once the question it is for has been drawn.
  useLayoutEffect(() => {
    if (!entrance || !block.current) return;
    if (entrance.kind === 'settle') settle(block.current);
    else questionIn(block.current, rowsOf(group.current), entrance.dir, entrance.delay);
    if (entrance.take) sheet.current?.focus({ preventScroll: true });
    handlers.current.syncFocus();
  }, [entrance?.token]);

  // ── Swapping questions ──

  const target = draft?.step;
  useLayoutEffect(() => {
    if (!up || leavingNow.current || !toolUseId || target === undefined) return;
    // Not until the showing has settled which question is drawn.
    if (step.toolUseId !== toolUseId || target === shownStep) return;
    const mine = generation.current;
    const dir: Direction = target > shownStep ? 'fwd' : 'back';
    leavingNow.current = true;
    setLeaving(true);
    // The Other field would keep typing into a question on its way out.
    if (document.activeElement === otherInput.current) sheet.current?.focus({ preventScroll: true });
    void questionOut(block.current!, dir).then(() => {
      if (mine !== generation.current) return;
      const entry = getState().answers.byToolUse[toolUseId];
      leavingNow.current = false;
      setLeaving(false);
      setStep({ toolUseId, step: entry?.draft.step ?? target });
      setEntrance(e => ({ token: (e?.token ?? 0) + 1, kind: 'in', dir, delay: 0, take: false }));
    });
  }, [up, toolUseId, target, shownStep, step.toolUseId]);

  // ── Patch's lines ──

  const said = shown?.answering.said ?? null;
  useLayoutEffect(() => {
    if (!up || leaving || !toolUseId || step.toolUseId !== toolUseId) return;
    const seq = said?.seq ?? 0;
    const prev = played.current;
    if (prev && prev.toolUseId === toolUseId && prev.seq === seq) return;
    played.current = { toolUseId, seq };
    if (!said || !patch.current) return;
    if (arriving.current === toolUseId && said.moment.kind === 'arrived') {
      arriving.current = null;
      if (patchStage.current) patchArrive(patchStage.current);
    }
    patch.current.appear({ ...questionBeat(said.moment), time: timeOfDay(new Date().getHours()), sky: questionSky(), ...dressingOn(new Date()) });
  }, [up, leaving, toolUseId, step.toolUseId, said?.seq]);

  // ── The keyboard around a showing ──

  // Showing a session focuses its terminal; while the questions are up the
  // keyboard belongs to them. Checked in a microtask: the terminal manager
  // renders the showing synchronously (`flushSync`) and only focuses the
  // terminal after that, so at commit time the terminal has not taken the
  // keyboard yet.
  useLayoutEffect(() => {
    let current = true;
    const open = screen.open;
    queueMicrotask(() => {
      if (!current || !live.current.up) return;
      if (!open?.element.contains(document.activeElement)) return;
      sheet.current?.focus({ preventScroll: true });
      handlers.current.syncFocus();
    });
    return () => { current = false; };
  }, [screen.shown]);

  // A set that settles while the panel has the keyboard hands it to the terminal.
  useEffect(() => onEvent('questionsSettled', ({ settled }) => {
    if (settled.toolUseId !== live.current.toolUseId) return;
    if (sheet.current?.contains(document.activeElement)) focusTerminal();
  }), []);

  // ── Drawing ──

  const picks = (draft && draft.picks[shownStep]) ?? [];
  const otherText = (draft && draft.other[shownStep]) ?? '';
  // While a question leaves, the cursor and picks belong to the next one.
  const cursor = draft && draft.step === shownStep ? draft.cursor : -1;
  const done = draft ? answeredCount(questions, draft) : 0;
  const isLast = shownStep === questions.length - 1;
  const blocked = !draft ? true : isLast ? done < questions.length : !isAnswered(questions, draft, shownStep);
  const rowKey = `${toolUseId}:${shownStep}`;

  return (
    <section
      ref={sheet}
      className={up ? 'qp is-up' : 'qp'}
      tabIndex={-1}
      aria-label="Questions from Claude"
      aria-hidden={up ? 'false' : 'true'}
      inert={!up}
    >
      <div className="qp-inner">
        <div className="qp-patch-col">
          <div ref={patchStage} className="qp-patch" />
          <span className="qp-foot">{shown ? answeredFoot(done, questions.length) : ''}</span>
          <div className="qp-sr" role="status" aria-live="polite">{said ? questionBeat(said.moment).line : ''}</div>
        </div>
        <div className="qp-col">
          <nav
            className="qp-tabs"
            aria-label="Questions"
            style={shown ? { '--qp-tab-count': String(questions.length) } as CSSProperties : undefined}
          >
            {questions.map((question, i) => {
              const current = i === shownStep;
              const answered = !!draft && isAnswered(questions, draft, i);
              return (
                <button
                  key={`${toolUseId}:${i}`}
                  type="button"
                  className={'qp-tab' + (current ? ' is-current' : '') + (answered ? ' is-done' : '')}
                  tabIndex={-1}
                  aria-current={current ? 'step' : undefined}
                  onClick={() => act({ kind: 'goto', step: i })}
                >
                  <span className="qp-tab-bar" aria-hidden="true"><span className="qp-tab-fill" /></span>
                  <span className="qp-tab-label">{question.header || `Question ${i + 1}`}</span>
                </button>
              );
            })}
          </nav>
          <div ref={block} className="qp-q">
            <div className="qp-head">
              <span className="qp-counter">{q ? questionCounter(shownStep, questions.length, q) : ''}</span>
              <h1 className="qp-question">{q?.question ?? ''}</h1>
            </div>
            <div ref={group} className={q?.multiSelect ? 'qp-options is-multi' : 'qp-options'} role="group" aria-label={q?.question}>
              {q?.options.map((option, i) => (
                <OptionRow
                  key={`${rowKey}:${i}`}
                  option={option}
                  index={i}
                  selected={picks.includes(option.label)}
                  cursor={cursor === i}
                  onClick={() => act({ kind: 'click', row: i })}
                />
              ))}
              {q && (
                <OtherRow
                  key={`${rowKey}:other`}
                  index={n}
                  text={otherText}
                  cursor={cursor === n}
                  inputRef={otherInput}
                  onFocus={() => {
                    // Our own focus after the cursor moved here is not a new choice.
                    const entry = toolUseId ? getState().answers.byToolUse[toolUseId] : undefined;
                    if (entry && entry.draft.cursor !== n) act({ kind: 'focus-other' });
                  }}
                  onType={text => act({ kind: 'type', text })}
                />
              )}
            </div>
          </div>
          <div className="qp-footer">
            <span className="qp-hints">
              {q && keyHints(q).map(({ key, does }) => (
                <span key={key + does} className="qp-hint"><kbd className="qp-kbd">{key}</kbd>{does}</span>
              ))}
            </span>
            <span className="qp-spacer" />
            <button type="button" className="qp-back" tabIndex={-1} hidden={!!shown && shownStep === 0} onClick={() => act({ kind: 'back' })}>Back</button>
            <button
              type="button"
              className="qp-primary"
              tabIndex={-1}
              aria-disabled={shown ? blocked : undefined}
              onClick={() => act({ kind: 'next' })}
            >
              <span className="qp-primary-label">{shown ? (isLast ? 'Send answers' : 'Next') : ''}</span>
              <span className="qp-primary-key" aria-hidden="true">↵</span>
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

/** The option rows and Other, in order, for the entrance's stagger. */
function rowsOf(group: HTMLElement | null): HTMLElement[] {
  return group ? [...group.querySelectorAll<HTMLElement>(':scope > .qp-option')] : [];
}
