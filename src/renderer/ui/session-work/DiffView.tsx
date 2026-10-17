/**
 * The selected item's diff (#75): a bar with what changed, where the diff
 * came from and the Unified/Split toggle, then one card per file.
 *
 * The diff is fetched when the item is selected (`install-session-work`), so
 * until it arrives the item's header above stays as it is over a skeleton. A
 * card shows the file's path, how it changed and its `+/−`. A lock file, a
 * generated file or a large one starts collapsed with the reason and a
 * "Show diff" button, and draws no lines until it is opened; a binary file is
 * one row. `n`/`p` move between the cards and `u` switches the layout (see
 * `SessionWorkPage`).
 */
import { memo, useMemo, useRef } from 'react';
import type { JSX } from 'react';
import { expandFile, setDiffMode } from './actions';
import { collapsedText, diffSummary, fileStatusPill } from './describe';
import { DiffRows } from './DiffRows';
import { LineCounts } from './LineCounts';
import { Pills } from './Pills';
import type { DiffMode, ItemDiff, SessionWorkPage } from '../../state/session-work-slice';
import type { FileDiff, SessionWorkItem } from '../../../domain/session-work/model';

/** How many cards draw their first lines at once; the rest fill in a frame later. */
const EAGER_FILES = 3;

const NO_PATHS: ReadonlySet<string> = new Set();

export function DiffView({ page, item }: { page: SessionWorkPage; item: SessionWorkItem }): JSX.Element | null {
  const diff: ItemDiff | undefined = page.diffs[item.id];
  const untracked = useMemo(
    () => (item.kind === 'dirty'
      ? new Set(item.files.filter(file => file.status === 'untracked').map(file => file.path))
      : NO_PATHS),
    [item],
  );
  if (item.kind === 'issue') return null;

  const loading = !diff || (diff.phase === 'loading' && diff.files.length === 0);
  const files = diff?.files ?? [];
  const summary = diffSummary(files);

  return (
    <div className="sw-diff" data-testid="session-work-diff" aria-busy={loading}>
      <div className="sw-diff-bar">
        {!loading && files.length > 0 && (
          <span className="sw-diff-summary">
            <span>{summary.label}</span>
            <LineCounts stats={summary.stats} />
          </span>
        )}
        {diff?.source === 'github' && (
          <span className="sw-diff-note" role="note">Branch not checked out locally.</span>
        )}
        <ModeToggle mode={page.diffMode} />
      </div>
      {loading
        ? <DiffSkeleton />
        : diff.phase === 'failed'
          ? <div className="sw-diff-empty">{diff.error && diff.error !== item.error ? diff.error : 'No diff to show.'}</div>
          : files.length === 0
            ? <div className="sw-diff-empty">No changes to show.</div>
            : files.map((file, i) => (
              <FileCard
                key={file.path}
                itemId={item.id}
                file={file}
                mode={page.diffMode}
                expanded={diff.expanded.includes(file.path)}
                focused={diff.focusedPath === file.path}
                untracked={untracked.has(file.path)}
                eager={i < EAGER_FILES}
              />
            ))}
    </div>
  );
}

function ModeToggle({ mode }: { mode: DiffMode }): JSX.Element {
  return (
    <div className="sw-seg" role="group" aria-label="Diff layout (u)">
      {(['unified', 'split'] as const).map(option => (
        <button
          key={option}
          type="button"
          className="sw-seg-btn"
          aria-pressed={mode === option}
          onClick={() => setDiffMode(option)}
        >
          {option === 'unified' ? 'Unified' : 'Split'}
        </button>
      ))}
    </div>
  );
}

function DiffSkeleton(): JSX.Element {
  return (
    <div className="sw-diff-skeleton" aria-hidden="true">
      <div className="sw-skeleton" />
      <div className="sw-skeleton" />
      <div className="sw-skeleton" />
    </div>
  );
}

const FileCard = memo(function FileCard({ itemId, file, mode, expanded, focused, untracked, eager }: {
  itemId: string;
  file: FileDiff;
  mode: DiffMode;
  expanded: boolean;
  focused: boolean;
  untracked: boolean;
  eager: boolean;
}): JSX.Element {
  const head = useRef<HTMLElement>(null);
  const reason = collapsedText(file);
  const collapsed = reason !== null && !expanded;
  const pill = fileStatusPill(file, untracked);

  const showDiff = (): void => {
    // The button goes as the lines come; the focus stays on this file, in the
    // page, so its keys keep working.
    head.current?.focus({ preventScroll: true });
    expandFile(itemId, file.path);
  };

  return (
    <section
      className={'sw-file' + (focused ? ' is-focused' : '')}
      aria-label={file.path}
      data-testid="session-work-file"
      data-path={file.path}
    >
      <header ref={head} className="sw-file-head" tabIndex={-1}>
        <span className="sw-file-path">
          {file.oldPath && <span className="sw-file-old">{file.oldPath} → </span>}
          {file.path}
        </span>
        {pill && <Pills pills={[pill]} />}
        {!file.binary && <LineCounts stats={file} />}
      </header>
      {file.binary
        ? <div className="sw-file-row">Binary file changed</div>
        : collapsed
          ? (
            <div className="sw-file-row is-collapsed">
              <span>{reason}</span>
              <button type="button" className="sw-btn sw-btn-small" onClick={showDiff}>
                Show diff
              </button>
            </div>
          )
          : file.hunks.length === 0
            ? <div className="sw-file-row">No changes to the content</div>
            : <DiffRows file={file} mode={mode} eager={eager} />}
    </section>
  );
});
