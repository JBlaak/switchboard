/**
 * Renaming a session in place.
 *
 * The row's label is swapped for an input and back, rather than opening a
 * dialog: the name is one short string, and the list keeps re-rendering around
 * it — which is why `sidebar-render` refuses to morph a row with an open input.
 *
 * Saving the name the session already had clears the rename instead of storing
 * it, so the row falls back to the CLI's own title and keeps tracking it.
 */
import { sessionDisplayName } from './sidebar-row';
import type { SessionRow } from '../../../domain/session/session';

/** The name a session shows when it has no rename of its own. */
function fallbackName(session: SessionRow): string {
  return session.aiTitle || session.summary;
}

function makeSummary(session: SessionRow, text: string): HTMLElement {
  const summary = document.createElement('div');
  summary.className = 'session-summary';
  summary.textContent = text;
  summary.addEventListener('dblclick', (e: MouseEvent) => {
    e.stopPropagation();
    startRename(summary, session);
  });
  return summary;
}

export function startRename(summaryEl: HTMLElement, session: SessionRow): void {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'session-rename-input';
  input.value = session.name || fallbackName(session);

  summaryEl.replaceWith(input);
  input.focus();
  input.select();

  const save = async (): Promise<void> => {
    const typed = input.value.trim();
    const fallback = fallbackName(session);
    // Typing the fallback back in means "no rename", not "rename to this".
    const name = typed && typed !== fallback ? typed : null;

    await window.api.renameSession(session.sessionId, name);
    session.name = name;
    input.replaceWith(makeSummary(session, name || fallback));
  };

  // Named, so Escape can detach it: cancelling must not save on the way out.
  const onBlur = (): void => void save();
  input.addEventListener('blur', onBlur);

  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      input.blur();
      return;
    }
    if (e.key !== 'Escape') return;
    input.removeEventListener('blur', onBlur);
    input.replaceWith(makeSummary(session, sessionDisplayName(session)));
  });
}
