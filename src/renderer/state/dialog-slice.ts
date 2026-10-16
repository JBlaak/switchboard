/**
 * Which modal dialog is open, if any.
 *
 * The dialogs are opened from all over the vanilla code — the toolbar, a row's
 * actions, the keyboard shortcuts, the terminal — and drawn by React, so the
 * request travels through the store: a caller dispatches `dialogOpened`, and
 * the dialog layer renders whatever is open. What a dialog does inside itself
 * (the filter text, the tab, a half-typed host) is its own component state and
 * goes with it when it closes.
 *
 * One dialog at a time. Opening another replaces the one on screen, where the
 * vanilla shell would have stacked a second overlay over the first.
 */
import type { EffectiveSettings } from '../../domain/settings/settings';
import type { RendererEvent } from './events';
import type { SessionRow } from '../../domain/session/session';

export type DialogRequest =
  /** "New Session": pick a project to start one in. */
  | { readonly kind: 'projectPicker' }
  | { readonly kind: 'addProject' }
  /**
   * Resume a session with different options.
   *
   * The row is the shared, mutable `SessionRow` the caller holds, carried by
   * reference rather than by id: a re-key or a refresh between opening and
   * submitting must not strand the dialog on a row it can no longer find.
   * The settings are fetched before opening, so the form is drawn filled in.
   */
  | { readonly kind: 'resumeSession'; readonly session: SessionRow; readonly settings: EffectiveSettings };

export interface DialogState {
  readonly open: DialogRequest | null;
  /**
   * Counts every opening. The dialog layer keys the dialog on it, so opening
   * the same kind again starts a fresh one, and a close from a dialog that has
   * already been replaced closes nothing.
   */
  readonly seq: number;
}

export const initialDialogState: DialogState = { open: null, seq: 0 };

export function dialogReducer(state: DialogState, event: RendererEvent): DialogState {
  switch (event.type) {
    case 'dialogOpened':
      return { open: event.request, seq: state.seq + 1 };
    case 'dialogClosed':
      return state.open && event.seq === state.seq ? { ...state, open: null } : state;
    default:
      return state;
  }
}
