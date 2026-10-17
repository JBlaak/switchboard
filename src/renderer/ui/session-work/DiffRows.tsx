/**
 * One file's lines, unified or side by side.
 *
 * Every row is a grid: a narrow empty first column (where #77 puts its
 * "+ comment" button), the line numbers, then the code, tinted green for an
 * addition and red for a deletion; a hunk's header spans the row in blue. In
 * the split view each side has its own comment column, numbers and code.
 *
 * Big diffs are drawn a chunk at a time so they never block input: a file
 * starts with a few rows (none, past the first files), and the rest are added
 * frame by frame in transitions, which React interrupts for anything the user
 * does. Each chunk is memoised on its slice of the rows, so growing the file
 * only renders the new chunk, and `content-visibility` lets the browser skip
 * laying out chunks that are scrolled away.
 */
import { memo, startTransition, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, JSX } from 'react';
import { hunkHeader, lineNumberDigits, splitRows, unifiedRows } from '../../../domain/session-work/diff-layout';
import type { SplitRow, UnifiedRow } from '../../../domain/session-work/diff-layout';
import type { DiffLine, FileDiff } from '../../../domain/session-work/model';
import type { DiffMode } from '../../state/session-work-slice';
import {
  ensureLanguage, highlightSplitRows, highlightUnifiedRows, isLanguageReady, languageFor, subscribeLanguages,
} from './highlight';

/** Rows per memoised chunk. */
const CHUNK_ROWS = 100;
/** Rows a file the reader sees first draws at once. */
const FIRST_ROWS = 100;
/** Rows added per frame while a file fills in. */
const STEP_ROWS = 400;

export const DiffRows = memo(function DiffRows({ file, mode, eager }: {
  file: FileDiff;
  mode: DiffMode;
  /** One of the first files on the page: draw its first rows at once rather than a frame later. */
  eager: boolean;
}): JSX.Element {
  const rows = useMemo(() => (mode === 'split' ? splitRows(file) : unifiedRows(file)), [file, mode]);
  const language = useLanguage(file.path);
  const shown = useProgressiveCount(rows.length, eager ? FIRST_ROWS : 0, mode);
  const style = { '--sw-digits': lineNumberDigits(file) } as CSSProperties;

  const chunks: JSX.Element[] = [];
  for (let start = 0; start < shown; start += CHUNK_ROWS) {
    const end = Math.min(shown, start + CHUNK_ROWS);
    chunks.push(mode === 'split'
      ? <SplitChunk key={start} rows={rows as SplitRow[]} start={start} end={end} language={language} />
      : <UnifiedChunk key={start} rows={rows as UnifiedRow[]} start={start} end={end} language={language} />);
  }

  return (
    <div className={'sw-lines is-' + mode} style={style} data-rows={rows.length} data-shown={shown}>
      {chunks}
      {shown < rows.length && <div className="sw-lines-pending" style={{ height: (rows.length - shown) * 20 }} />}
    </div>
  );
});

/** A chunk's box, which the browser may skip laying out while it is off screen. */
function chunkStyle(rows: number): CSSProperties {
  return { containIntrinsicBlockSize: `auto ${rows * 20}px` };
}

const UnifiedChunk = memo(function UnifiedChunk({ rows, start, end, language }: {
  rows: readonly UnifiedRow[]; start: number; end: number; language: string | null;
}): JSX.Element {
  const html = useMemo(() => highlightUnifiedRows(rows, start, end, language), [rows, start, end, language]);
  const out: JSX.Element[] = [];
  for (let i = start; i < end; i++) {
    const row = rows[i];
    if (row.kind === 'hunk') {
      out.push(<HunkRow key={i} text={hunkHeader(row.hunk)} />);
      continue;
    }
    const { line } = row;
    out.push(
      <div key={i} className={'sw-dl is-' + line.kind} data-kind={line.kind}>
        <span className="sw-dl-act" />
        <span className="sw-dl-num">{line.oldLine ?? ''}</span>
        <span className="sw-dl-num">{line.newLine ?? ''}</span>
        <Code line={line} html={html?.[i - start] ?? null} />
      </div>,
    );
  }
  return <div className="sw-chunk" style={chunkStyle(end - start)}>{out}</div>;
});

const SplitChunk = memo(function SplitChunk({ rows, start, end, language }: {
  rows: readonly SplitRow[]; start: number; end: number; language: string | null;
}): JSX.Element {
  const html = useMemo(() => highlightSplitRows(rows, start, end, language), [rows, start, end, language]);
  const out: JSX.Element[] = [];
  for (let i = start; i < end; i++) {
    const row = rows[i];
    if (row.kind === 'hunk') {
      out.push(<HunkRow key={i} text={hunkHeader(row.hunk)} />);
      continue;
    }
    out.push(
      <div key={i} className="sw-dl is-pair">
        <SplitSide line={row.left} side="left" html={html?.left[i - start] ?? null} />
        <SplitSide line={row.right} side="right" html={html?.right[i - start] ?? null} />
      </div>,
    );
  }
  return <div className="sw-chunk" style={chunkStyle(end - start)}>{out}</div>;
});

function HunkRow({ text }: { text: string }): JSX.Element {
  return (
    <div className="sw-dl is-hunk" data-kind="hunk">
      <span className="sw-dl-act" />
      <span className="sw-dl-hunk">{text}</span>
    </div>
  );
}

/** One side of a split row: a blank cell where that side has no line. */
function SplitSide({ line, side, html }: { line: DiffLine | null; side: 'left' | 'right'; html: string | null }): JSX.Element {
  const kind = line ? line.kind : 'empty';
  const number = line ? (side === 'left' ? line.oldLine : line.newLine) : null;
  return (
    <>
      <span className={'sw-dl-act is-' + kind} />
      <span className={'sw-dl-num is-' + kind}>{number ?? ''}</span>
      {line
        ? <Code line={line} html={html} side={side} />
        : <span className="sw-dl-code is-empty" data-side={side} data-kind="empty" />}
    </>
  );
}

function Code({ line, html, side }: { line: DiffLine; html: string | null; side?: 'left' | 'right' }): JSX.Element {
  const sign = line.kind === 'add' ? '+' : line.kind === 'delete' ? '-' : ' ';
  return (
    <span className={'sw-dl-code is-' + line.kind} data-side={side} data-kind={side ? line.kind : undefined}>
      <span className="sw-dl-sign" aria-hidden="true">{sign}</span>
      {html !== null
        ? <span className="sw-dl-text" dangerouslySetInnerHTML={{ __html: html }} />
        : <span className="sw-dl-text">{line.text}</span>}
    </span>
  );
}

/**
 * The language a file is highlighted in, once it is registered: null (plain
 * text) until then, and for files with no known language.
 */
function useLanguage(path: string): string | null {
  const language = languageFor(path);
  const ready = useSyncExternalStore(subscribeLanguages, () => language !== null && isLanguageReady(language));
  useEffect(() => {
    if (language && !ready) void ensureLanguage(language);
  }, [language, ready]);
  return ready ? language : null;
}

/**
 * How many of `total` rows to draw: `initial` at once, then more each frame,
 * in a transition so typing and scrolling come first. Starts over when
 * `resetKey` changes (the layout was switched), so a switch is as quick as a
 * first draw.
 */
function useProgressiveCount(total: number, initial: number, resetKey: string): number {
  const [state, setState] = useState({ key: resetKey, shown: initial });
  let shown = state.shown;
  if (state.key !== resetKey) {
    shown = initial;
    setState({ key: resetKey, shown: initial });
  }
  useEffect(() => {
    if (shown >= total) return;
    const frame = requestAnimationFrame(() => {
      startTransition(() => {
        setState(current => (current.key === resetKey
          ? { key: resetKey, shown: Math.min(total, current.shown + STEP_ROWS) }
          : current));
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [shown, total, resetKey]);
  return Math.min(shown, total);
}
