/**
 * Answering Claude's questions in Switchboard rather than in the terminal.
 *
 * This is the wiring: it decides when the panel is up, keeps the header's
 * button or pill in step with it, sends the answers, and marks the sidebar.
 *
 * The panel covers the terminal area of the session on screen while that
 * session has questions and the user has not chosen the terminal instead. It
 * is a sibling of the terminal containers inside #terminals, never a child of
 * one: the xterm stays mounted and sized underneath (only its container is
 * scaled back, which does not touch layout), and a drop or a key on the panel
 * cannot reach the terminal's own handlers.
 *
 * "Which session is on screen" is read off the DOM — the terminal container
 * with `.visible` — and watched with a MutationObserver, so every path that
 * shows a session (a row click, session nav, restore, a re-key) is covered
 * without each of them having to call in here.
 */
import { answeredCount, draftAnswers } from '../../../domain/questions/answer-draft';
import { refreshSidebar } from '../../app/refresh';
import { el, terminalsEl } from '../../lib/dom';
import {
  addPendingQuestions, onQuestionsChange, questionsFor, settleQuestions,
} from '../../state/question-store';
import { openSessions, view } from '../../state/session-store';
import { dismissFarewells, showFarewell } from './farewell';
import { createQuestionPanel } from './question-panel';
import { dozeMinute, waitingLabel } from './question-copy';
import type { PatchSky } from '@jblaak/patch';
import type { QuestionChange, QuestionEntry } from '../../state/question-store';
import type { QuestionPanel, ShowReason } from './question-panel';

/** How often the doze check runs; it acts at most once per minute-left. */
const DOZE_TICK_MS = 5000;

const PATCH_FACE_SVG = '<svg class="qh-face" aria-hidden="true" width="22" height="20" viewBox="46 64 106 106" fill="none"><path class="qh-face-body" d="M50 138 C 46 96, 72 68, 100 68 C 132 68, 152 96, 148 138 C 146 158, 128 166, 100 166 C 70 166, 52 158, 50 138 Z"/><ellipse class="qh-face-eye" cx="86" cy="118" rx="6" ry="8"/><ellipse class="qh-face-eye" cx="114" cy="118" rx="6" ry="8"/></svg>';
const TERMINAL_SVG = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7l5 5-5 5"/><path d="M12 19h7"/></svg>';

let panel: QuestionPanel;
let headerSlot: HTMLElement;
/** What the header slot shows, so an unchanged state does not replay its pop. */
let headerKey = '';
/** The session on screen at the last sync, to tell a switch from a change. */
let lastActive: string | null = null;
let sky: PatchSky | null = null;

export function installQuestions(): void {
  headerSlot = el('terminal-header-questions');
  panel = createQuestionPanel({ submit: send, toTerminal: answerInTerminal });
  terminalsEl.appendChild(panel.element);

  onQuestionsChange(onChange);
  watchTerminals();
  setInterval(tickDoze, DOZE_TICK_MS);

  void window.api.getWeather()
    .then(weather => { sky = weather?.sky ?? null; panel.setSky(sky); })
    .catch(() => {});
  // Sets asked before this window loaded (or before a reload).
  void window.api.getPendingQuestions()
    .then(list => list.forEach(addPendingQuestions))
    .catch(() => {});
}

function onChange(change: QuestionChange): void {
  // Asking moves a row into the needs-input section and writes its label;
  // settling moves it back. Both are a render, not a class toggle.
  if (change.kind !== 'rekeyed') refreshSidebar();
  if (change.kind === 'settled' && panel.entry === change.entry) {
    const hadKeyboard = panel.element.contains(document.activeElement);
    sync();
    if (hadKeyboard) focusTerminal();
    return;
  }
  sync();
}

/**
 * Put the panel, the sunken terminal and the header in the state the
 * session on screen calls for.
 */
function sync(reason?: ShowReason): void {
  const id = view.activeSessionId;
  const open = id ? openSessions.get(id) : undefined;
  const onScreen = !!open && open.element.classList.contains('visible');
  const entry = onScreen ? questionsFor(id) : undefined;
  const up = !!entry && entry.view === 'questions';

  const switched = id !== lastActive;
  lastActive = id;
  // A switch should land, not animate: the new session's terminal is not
  // sinking, it is already behind its questions.
  if (switched) skipTransitions();

  for (const [, other] of openSessions) {
    const under = up && other === open;
    if (other.element.classList.contains('qp-under') !== under) other.element.classList.toggle('qp-under', under);
  }

  renderHeader(entry, up);

  if (!up || !entry) {
    panel.hide();
    return;
  }
  if (!panel.isUp || panel.entry !== entry) {
    // Patch greets a set once; any later showing that is not a return from
    // the terminal view picks up where it was.
    dismissFarewells();
    panel.show(entry, reason ?? (entry.greeted ? 'switched' : 'arrived'));
  } else if (open && open.element.contains(document.activeElement)) {
    // Showing a session focuses its terminal; while the questions are up the
    // keyboard belongs to them.
    panel.focus();
  }
}

/** Esc, or the header button: answer in the terminal instead. */
function answerInTerminal(entry: QuestionEntry): void {
  entry.view = 'terminal';
  sync();
  focusTerminal();
}

/** The header pill: back to the questions. */
function backToQuestions(entry: QuestionEntry): void {
  entry.view = 'questions';
  sync('returned');
}

function focusTerminal(): void {
  const id = view.activeSessionId;
  if (id) openSessions.get(id)?.terminal.focus();
}

/**
 * Send the answers.
 *
 * Whatever comes back, the set is over here: answered, or already withdrawn
 * (main answers `ok: false` when the hook request went away first). Settling
 * locally makes main's own settle event, whichever arrives first, a no-op.
 * Only a real answer gets Patch's send-off.
 */
async function send(entry: QuestionEntry): Promise<void> {
  const { questions, toolUseId } = entry.pending;
  let ok = false;
  try {
    const result = await window.api.answerQuestions(entry.pending.sessionId, toolUseId, draftAnswers(questions, entry.draft));
    ok = result.ok === true;
    if (!ok) console.warn('[questions] answer not delivered:', result.error);
  } catch (err) {
    console.warn('[questions] answer failed:', err);
  }
  settleQuestions({ sessionId: entry.pending.sessionId, toolUseId, outcome: ok ? 'answered' : 'withdrawn' });
  if (ok) showFarewell(terminalsEl, sky);
}

/** When the questions have waited long, Patch dozes and says when the terminal takes over. */
function tickDoze(): void {
  const entry = panel.entry;
  if (!entry || !panel.isUp || entry.sending) return;
  const minute = dozeMinute(entry.pending.deadline, Date.now(), entry.dozedAt);
  if (minute === null) return;
  entry.dozedAt = minute;
  panel.say({ kind: 'waiting', minutesLeft: minute });
}

// ── Header ──

/**
 * The header's part: a way out to the terminal while the panel is up, a way
 * back while it is not, nothing once the set is settled.
 */
function renderHeader(entry: QuestionEntry | undefined, up: boolean): void {
  let label = '';
  if (entry && !up) {
    const left = entry.pending.questions.length - answeredCount(entry.pending.questions, entry.draft);
    label = waitingLabel(left);
  }
  // The button's handler holds the entry, so another set is another button.
  const key = entry ? `${entry.pending.toolUseId}:${up}:${label}` : '';
  if (key === headerKey) return;
  headerKey = key;

  headerSlot.replaceChildren();
  headerSlot.hidden = !entry;
  if (!entry) return;

  const button = document.createElement('button');
  button.type = 'button';
  if (up) {
    button.className = 'qh-terminal';
    button.innerHTML = TERMINAL_SVG;
    button.append('Answer in terminal');
    const kbd = document.createElement('kbd');
    kbd.className = 'qh-kbd';
    kbd.textContent = 'esc';
    button.appendChild(kbd);
    button.addEventListener('click', () => answerInTerminal(entry));
  } else {
    button.className = 'qh-waiting';
    button.innerHTML = PATCH_FACE_SVG;
    button.append(label);
    button.addEventListener('click', () => backToQuestions(entry));
  }
  headerSlot.appendChild(button);
}

// ── Watching which terminal is on screen ──

function watchTerminals(): void {
  const classes = new MutationObserver(() => sync());
  const watch = (node: Node): void => {
    if (node instanceof HTMLElement && node.classList.contains('terminal-container')) {
      classes.observe(node, { attributes: true, attributeFilter: ['class'] });
    }
  };
  terminalsEl.childNodes.forEach(watch);
  new MutationObserver(records => {
    for (const record of records) record.addedNodes.forEach(watch);
    sync();
  }).observe(terminalsEl, { childList: true });
}

/** Let the next state apply without its transitions, for one frame. */
function skipTransitions(): void {
  terminalsEl.classList.add('qp-instant');
  requestAnimationFrame(() => requestAnimationFrame(() => terminalsEl.classList.remove('qp-instant')));
}
