/**
 * The Session work page: what the session on screen has done to its
 * repository, in the terminal's place (D4, D12).
 *
 * Master–detail: the header with the agents strip on top, the work items on
 * the left, the selected one on the right. Rendered into `#session-work`,
 * which `install-session-work` shows and hides; the terminals stay mounted
 * underneath the whole time.
 *
 * The page holds the focus while it is open, so its keys are heard here
 * rather than globally: Esc goes back to the terminal, `j` and `k` move
 * between items (D15).
 */
import { useLayoutEffect, useRef } from 'react';
import type { JSX, KeyboardEvent } from 'react';
import { useStore } from '../use-store';
import { closeSessionWork, stepWorkItem } from './actions';
import { WorkHeader } from './WorkHeader';
import { WorkList } from './WorkList';
import { WorkDetail } from './WorkDetail';
import { githubBanner } from './describe';

export function SessionWorkPage(): JSX.Element | null {
  const page = useStore(state => state.sessionWork.page);
  const root = useRef<HTMLDivElement>(null);
  const sessionId = page?.sessionId ?? null;

  // Into the page as it opens, so Esc and j/k reach it without a click.
  useLayoutEffect(() => {
    if (sessionId) root.current?.focus({ preventScroll: true });
  }, [sessionId]);

  if (!page) return null;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSessionWork();
      return;
    }
    if (e.key === 'j' || e.key === 'k') {
      if ((e.target as HTMLElement).matches('input, textarea, select')) return;
      e.preventDefault();
      const next = stepWorkItem(e.key === 'j' ? 1 : -1);
      if (next) root.current?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(next)}"]`)?.focus();
    }
  };

  const banner = page.snapshot ? githubBanner(page.snapshot.gh) : null;

  return (
    <div
      ref={root}
      className="sw-page"
      tabIndex={-1}
      role="region"
      aria-label={'Session work for ' + page.name}
      onKeyDown={onKeyDown}
    >
      <WorkHeader page={page} />
      {banner && <GitHubBanner text={banner} />}
      {page.snapshot && page.snapshot.items.length === 0
        ? <div className="sw-empty">Nothing changed yet in this session.</div>
        : (
          <div className="sw-body">
            <WorkList page={page} />
            <WorkDetail page={page} />
          </div>
        )}
    </div>
  );
}

/** Said once, at the top of the page, rather than on every item (D9). */
function GitHubBanner({ text }: { text: string }): JSX.Element {
  // The command in backticks is set in mono.
  const parts = text.split('`');
  return (
    <div className="sw-banner" role="status">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v5M12 16.5v.5" />
      </svg>
      <span>{parts.map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part))}</span>
    </div>
  );
}
