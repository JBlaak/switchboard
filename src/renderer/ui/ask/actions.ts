/**
 * What the box on the empty screen does (#135): send what was typed to be
 * routed, and act on the answer — start the session, offer the choices, or
 * hand the text to the New Session picker.
 *
 * The box's state moves in the reducer (`ask-slice`); what follows outside
 * it, the launch or the picker, is done here on the same `askOutcome`, and
 * only when the reducer took the answer, so a cancelled send cannot start
 * anything when its late answer comes in.
 */
import { dispatch, getState } from '../../state/app-store';
import { view } from '../../state/session-store';
import { askOutcome } from '../../state/ask-slice';
import { launchClaudeSession, projectStub } from '../../features/sessions/session-actions';
import { openDialog } from '../dialogs/actions';
import { routeRequest } from './route-request';
import type { AskOutcome } from '../../state/ask-slice';
import type { Project } from '../../../domain/project/project';
import type { RouteResult } from '../../../domain/ask/model';

export function changeAskText(text: string): void {
  dispatch({ type: 'askTextChanged', text });
}

/** Enter: ask main which project the text is about, and act on the answer. */
export async function sendAsk(): Promise<void> {
  const before = getState().ask;
  dispatch({ type: 'askSent' });
  const sent = getState().ask;
  // Blank, or not editing: the reducer turned it away.
  if (sent === before) return;

  const { asked, text } = sent;
  const result = await window.api.askRoute(routeRequest(text, view.cachedProjects))
    // It answers `failed` rather than rejecting; this is for the IPC itself giving way.
    .catch((err: unknown): RouteResult => ({ kind: 'failed', reason: `Something went wrong: ${String(err)}` }));

  const waiting = getState().ask;
  dispatch({ type: 'askAnswered', asked, result });
  if (getState().ask === waiting) return;
  follow(askOutcome(result, text));
}

/** Esc while waiting: stop the call and unlock the box straight away (W2). */
export function cancelAsk(): void {
  if (getState().ask.phase !== 'waiting') return;
  dispatch({ type: 'askCancelled' });
  void window.api.cancelAskRoute();
}

// ── The choice list (O2) ──

export function stepAskChoice(step: 1 | -1): void {
  dispatch({ type: 'askChoiceStepped', step });
}

export function hoverAskChoice(index: number): void {
  dispatch({ type: 'askChoiceHovered', index });
}

/** Start a session in the choice at `index`, or the highlighted one, on the rewritten prompt. */
export function startAskChoice(index?: number): void {
  const { phase, choices, selected, prompt } = getState().ask;
  const projectPath = choices[index ?? selected];
  if (phase !== 'choosing' || projectPath === undefined) return;
  dispatch({ type: 'askChoiceStarted' });
  void launchClaudeSession(projectAt(projectPath), { initialPrompt: prompt });
}

/** Esc: close the list and go back to editing the box. */
export function closeAskChoices(): void {
  dispatch({ type: 'askChoicesClosed' });
}

/** Tab: the full New Session picker instead, carrying the rewritten prompt. */
export function openPickerFromChoices(): void {
  const { phase, prompt } = getState().ask;
  if (phase !== 'choosing') return;
  dispatch({ type: 'askChoicesHandedOff' });
  openDialog({ kind: 'projectPicker', initialPrompt: prompt });
}

/** What an answer the reducer took leads to outside the box. */
function follow(outcome: AskOutcome): void {
  switch (outcome.kind) {
    case 'start':
      void launchClaudeSession(projectAt(outcome.projectPath), { initialPrompt: outcome.prompt });
      return;
    case 'picker':
      openDialog({ kind: 'projectPicker', initialPrompt: outcome.prompt });
      return;
    case 'choose':
    case 'unlock':
      return;
  }
}

/** The loaded project at `projectPath`; main only answers paths it was offered, so a miss is a stub. */
function projectAt(projectPath: string): Project {
  return view.cachedProjects.find(p => p.projectPath === projectPath) ?? projectStub(projectPath);
}
