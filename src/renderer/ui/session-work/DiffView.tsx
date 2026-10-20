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
 *
 * An image in a local diff gets an image card instead (#112, `ImageCard`); an
 * SVG's also switches to its line diff with Source. A binary image from
 * GitHub's copy keeps its row, with a note that the branch has to be checked
 * out to compare it (I4).
 *
 * On an open PR the diff is also where you review it (#77): each line takes a
 * comment, the threads already on GitHub sit under their lines (or at the top
 * of their file when their line is gone), and while your review has pending
 * comments a bar under the diff finishes it.
 */
import { memo, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { expandFile, setDiffMode } from './actions';
import { IMAGE_GITHUB_NOTE, collapsedText, diffSummary, fileStatusPill } from './describe';
import { DiffRows } from './DiffRows';
import { LineCounts } from './LineCounts';
import { Pills } from './Pills';
import type {
  CommentTarget, DiffMode, ImageCardState, ItemDiff, SessionWorkPage,
} from '../../state/session-work-slice';
import type { FileDiff, PullRequestStatus, SessionWorkItem } from '../../../domain/session-work/model';
import { canComment } from '../../../domain/session-work/review';
import { imageFormatOf } from '../../../domain/session-work/image';
import { useStore } from '../use-store';
import { ImageCard } from './ImageCard';
import type { Background } from './image-compare/types';
import type { ImageMode } from './image-compare/modes/types';
import { fileReview } from './review-notes';
import { OutdatedNotes, ReviewBar, ReviewContext } from './ReviewNotes';
import type { ReviewScope } from './ReviewNotes';

/** How many cards draw their first lines at once; the rest fill in a frame later. */
const EAGER_FILES = 3;

const NO_PATHS: ReadonlySet<string> = new Set();
const NO_THREADS: ReadonlySet<string> = new Set();

export function DiffView({ page, item }: { page: SessionWorkPage; item: SessionWorkItem }): JSX.Element | null {
  const diff: ItemDiff | undefined = page.diffs[item.id];
  const untracked = useMemo(
    () => (item.kind === 'dirty'
      ? new Set(item.files.filter(file => file.status === 'untracked').map(file => file.path))
      : NO_PATHS),
    [item],
  );
  const fixingThreads = item.kind === 'pr' ? item.fixingThreads : undefined;
  const canFix = !(item.kind === 'pr' && item.otherRepository);
  const scope = useMemo<ReviewScope>(
    () => ({ sessionId: page.sessionId, itemId: item.id, fixing: fixingThreads ? new Set(fixingThreads) : NO_THREADS, canFix }),
    [page.sessionId, item.id, fixingThreads, canFix],
  );
  const imageDefaults = useStore(state => state.sessionWork.imageDefaults);
  if (item.kind === 'issue') return null;

  const pr = item.kind === 'pr' ? item.pr : null;
  const commentable = page.snapshot ? canComment(item, page.snapshot.gh) : false;
  const loading = !diff || (diff.phase === 'loading' && diff.files.length === 0);
  const files = diff?.files ?? [];
  const summary = diffSummary(files);

  return (
    <ReviewContext.Provider value={scope}>
    <div className="sw-diff" data-testid="session-work-diff" aria-busy={loading}>
      <div className="sw-diff-bar">
        {!loading && files.length > 0 && (
          <span className="sw-diff-summary">
            <span>{summary.label}</span>
            <LineCounts stats={summary.stats} />
          </span>
        )}
        {diff?.source === 'github' && (
          <span className="sw-diff-note" role="note">{diff.note ?? 'Branch not checked out locally.'}</span>
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
                sessionId={page.sessionId}
                itemId={item.id}
                loadKey={diff.key}
                github={diff.source === 'github'}
                image={diff.images[file.path]}
                background={imageDefaults.background}
                defaultMode={imageDefaults.mode}
                file={file}
                mode={page.diffMode}
                expanded={diff.expanded.includes(file.path)}
                focused={diff.focusedPath === file.path}
                untracked={untracked.has(file.path)}
                eager={i < EAGER_FILES}
                pr={pr}
                commentable={commentable}
                composer={page.composer}
              />
            ))}
      {pr && <ReviewBar sessionId={page.sessionId} itemId={item.id} pr={pr} canFix={canFix} />}
    </div>
    </ReviewContext.Provider>
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

const FileCard = memo(function FileCard({
  sessionId, itemId, loadKey, github, image, background, defaultMode,
  file, mode, expanded, focused, untracked, eager, pr = null, commentable = false, composer = null,
}: {
  sessionId: string;
  itemId: string;
  /** The item's diff as it was asked for, for an image card to load again when it changes. */
  loadKey: string;
  /** The diff is GitHub's copy (D8): an image there has no bytes to compare (I4). */
  github: boolean;
  /** The image card's state, once it has been drawn. */
  image: ImageCardState | undefined;
  background: Background;
  defaultMode: ImageMode;
  file: FileDiff;
  mode: DiffMode;
  expanded: boolean;
  focused: boolean;
  untracked: boolean;
  eager: boolean;
  /** The PR whose diff this is, for its threads and your pending comments. */
  pr?: PullRequestStatus | null;
  /** Its lines take a comment. Never a binary file's. */
  commentable?: boolean;
  composer?: CommentTarget | null;
}): JSX.Element {
  const head = useRef<HTMLElement>(null);
  const review = useMemo(
    () => fileReview(itemId, file, pr, commentable && !file.binary, composer),
    [itemId, file, pr, commentable, composer],
  );
  const reason = collapsedText(file);
  const collapsed = reason !== null && !expanded;
  const pill = fileStatusPill(file, untracked);
  // An SVG opens rendered; Source is its line diff, where comments still go (C5).
  const [svgSource, setSvgSource] = useState(false);
  const svg = file.image?.format === 'svg';
  const imageCard = !!file.image && !(svg && svgSource);

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
        {svg && <SvgToggle source={svgSource} onChange={setSvgSource} />}
      </header>
      {review && <OutdatedNotes threads={review.outdated} pending={review.outdatedPending} />}
      {imageCard
        ? (
          <ImageCard
            sessionId={sessionId}
            itemId={itemId}
            file={file}
            loadKey={loadKey}
            expanded={expanded}
            card={image}
            background={background}
            defaultMode={defaultMode}
            onShowDiff={showDiff}
          />
        )
        : file.binary
          ? (
            <div className="sw-file-row">
              <span>Binary file changed</span>
              {github && imageFormatOf(file.path) && <span className="sw-image-note">{IMAGE_GITHUB_NOTE}</span>}
            </div>
          )
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
              : <DiffRows file={file} mode={mode} eager={eager} review={review} />}
    </section>
  );
});

/** An SVG card's Rendered | Source switch, in its header. */
function SvgToggle({ source, onChange }: { source: boolean; onChange(source: boolean): void }): JSX.Element {
  return (
    <div className="sw-seg" role="group" aria-label="SVG view">
      {([false, true] as const).map(option => (
        <button
          key={String(option)}
          type="button"
          className="sw-seg-btn"
          aria-pressed={source === option}
          onClick={() => onChange(option)}
        >
          {option ? 'Source' : 'Rendered'}
        </button>
      ))}
    </div>
  );
}
