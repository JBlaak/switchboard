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
 * rather than globally (D15): Esc goes back to the terminal, `j` and `k` move
 * between items, `n` and `p` between the files of its diff, `u` switches
 * the diff between unified and split, and `c` comments on the focused line of
 * a PR's diff. On an image card `n`/`p` landed on, `1`–`5` pick its mode, `b`
 * flips Blink and `0` fits the view again (C6). None of them is taken from a
 * text field, and an open comment composer takes Esc first.
 *
 * Two tabs (W1): Work, all of the above, and Plan, the session's plan as a
 * flow diagram (`plan/`). `t` switches between them. On the Plan tab the
 * Work keys rest; Esc closes an open issue detail before it closes the page,
 * and ↑/↓ step through the issues while the detail is open (D4).
 */
import { useLayoutEffect, useRef } from 'react';
import type { JSX, KeyboardEvent } from 'react';
import { useStore } from '../use-store';
import { closeSessionWork, imageKey, stepFile, stepWorkItem, toggleDiffMode, toggleWorkTab } from './actions';
import { workTabOf } from '../../state/session-work-slice';
import type { SessionWorkPage as SessionWorkPageState } from '../../state/session-work-slice';
import { PlanTab } from './plan/PlanTab';
import { planKey } from './plan/load';
import { WorkHeader } from './WorkHeader';
import { WorkList } from './WorkList';
import { WorkDetail } from './WorkDetail';
import { githubBanner } from './describe';
import { openComposerAt } from './ReviewNotes';

/** The single-letter keys the page answers (D15). */
const PAGE_KEYS = new Set(['j', 'k', 'n', 'p', 'u', 'c']);

/** The keys of the focused image card; heard only when there is one. */
const IMAGE_KEYS = new Set(['1', '2', '3', '4', '5', 'b', '0']);

/**
 * `c`: comment on the line that has the focus (a click puts it there), when
 * the line takes a comment (C1). Anywhere else it does nothing.
 */
function commentOnFocusedLine(target: HTMLElement, itemId: string | null): void {
  const line = target.closest<HTMLElement>('[data-comment-line]');
  const path = line?.closest<HTMLElement>('.sw-file')?.dataset.path;
  if (!line || !path || !itemId) return;
  const number = Number(line.dataset.commentLine);
  const side = line.dataset.commentSide === 'LEFT' ? 'LEFT' : 'RIGHT';
  if (Number.isSafeInteger(number) && number > 0) openComposerAt(itemId, path, number, side, line);
}

export function SessionWorkPage(): JSX.Element | null {
  const page = useStore(state => state.sessionWork.page);
  const root = useRef<HTMLDivElement>(null);
  const sessionId = page?.sessionId ?? null;
  const tab = useStore(state => (sessionId ? workTabOf(state.sessionWork, sessionId) : 'work'));

  // Into the page as it opens, so Esc and j/k reach it without a click.
  useLayoutEffect(() => {
    if (sessionId) root.current?.focus({ preventScroll: true });
  }, [sessionId]);

  if (!page) return null;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const inField = (e.target as HTMLElement).matches('input, textarea, select, [contenteditable="true"]');
    if (tab === 'plan' && !e.shiftKey && !inField && planKey(e.key)) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSessionWork();
      return;
    }
    if (e.shiftKey || inField) return;
    if (e.key === 't') {
      e.preventDefault();
      (e.nativeEvent as Event & { _handled?: boolean })._handled = true;
      toggleWorkTab();
      return;
    }
    if (tab === 'plan') return;
    if (IMAGE_KEYS.has(e.key)) {
      if (!imageKey(e.key)) return;
      e.preventDefault();
      (e.nativeEvent as Event & { _handled?: boolean })._handled = true;
      return;
    }
    if (!PAGE_KEYS.has(e.key)) return;
    e.preventDefault();
    // The page's keys are its own: a bare N here is "next file", not the
    // global quick session (see `app/shortcuts`).
    (e.nativeEvent as Event & { _handled?: boolean })._handled = true;
    if (e.key === 'j' || e.key === 'k') {
      const next = stepWorkItem(e.key === 'j' ? 1 : -1);
      if (next) root.current?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(next)}"]`)?.focus();
    } else if (e.key === 'c') {
      commentOnFocusedLine(e.target as HTMLElement, page.selectedItemId);
    } else if (e.key === 'n' || e.key === 'p') {
      const path = stepFile(e.key === 'n' ? 1 : -1);
      const head = path
        ? root.current?.querySelector<HTMLElement>(`.sw-file[data-path="${CSS.escape(path)}"] .sw-file-head`)
        : null;
      if (head) {
        head.focus({ preventScroll: true });
        head.parentElement!.scrollIntoView({ block: 'start' });
      }
    } else {
      toggleDiffMode();
    }
  };

  return (
    <div
      ref={root}
      className="sw-page"
      tabIndex={-1}
      role="region"
      aria-label={'Session work for ' + page.name}
      onKeyDown={onKeyDown}
    >
      <WorkHeader page={page} tab={tab} />
      {tab === 'plan' ? <PlanTab sessionId={page.sessionId} /> : <WorkTab page={page} />}
    </div>
  );
}

/** The Work tab: the banner, then the items and the selected one's detail. */
function WorkTab({ page }: { page: SessionWorkPageState }): JSX.Element {
  const banner = page.snapshot ? githubBanner(page.snapshot.gh) : null;
  return (
    <>
      {banner && <GitHubBanner text={banner} />}
      {page.snapshot && page.snapshot.items.length === 0
        ? <div className="sw-empty">Nothing changed yet in this session.</div>
        : (
          <div className="sw-body">
            <WorkList page={page} />
            <WorkDetail page={page} />
          </div>
        )}
    </>
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
