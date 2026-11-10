/**
 * The peek: a pull request's diff in a modal over whatever is on screen,
 * opened by any PR link in the app (`openLink`).
 *
 * The header names the PR (`owner/repo #12`) and, once `gh` has answered,
 * its title, state and `+a −d`. Under it, one card per file, drawn the way
 * the Session work page draws them (`sw-file`, `DiffRows`) but without the
 * review: a lock file, a generated or a large one starts collapsed with the
 * reason and Show diff, a binary file is one row.
 *
 * It holds the focus while it is open and hands it back to what had it when
 * it closes, so a peek opened from the terminal returns to the terminal. Its
 * keys are its own: ↵ Full view, `o` Open on GitHub, `u` Unified/Split, Esc
 * closes. Every key pressed inside is marked handled, so none of them reaches
 * the global shortcuts or the session behind it.
 *
 * Into `document.body` like the dialogs (see `DialogShell`): it covers the
 * whole window, not one surface's container.
 */
import {memo, useLayoutEffect, useRef} from 'react';
import {createPortal} from 'react-dom';
import type {JSX, KeyboardEvent, MouseEvent} from 'react';
import {useStore} from '../use-store';
import {DiffRows} from '../session-work/DiffRows';
import {LineCounts} from '../session-work/LineCounts';
import {Pills} from '../session-work/Pills';
import {collapsedText, diffSummary, fileStatusPill} from '../session-work/describe';
import type {Pill} from '../session-work/describe';
import type {DiffMode} from '../../state/session-work-slice';
import type {PrPeek} from '../../state/pr-peek-slice';
import type {FileDiff, LineStats, PullRequestStatus} from '../../../domain/session-work/model';
import {
    closePullRequestPeek,
    expandPeekFile,
    openPeekFullView,
    openPeekOnGitHub,
    setPeekDiffMode,
    togglePeekDiffMode,
} from './actions';

/** How many cards draw their first lines at once; the rest fill in a frame later. */
const EAGER_FILES = 3;

type MarkedEvent = Event & {_handled?: boolean};

export function PullRequestPeek(): JSX.Element | null {
    const peek = useStore((state) => state.prPeek.peek);
    const mode = useStore((state) => state.prPeek.mode);
    const open = peek !== null;
    const dialog = useRef<HTMLDivElement>(null);
    const returnTo = useRef<HTMLElement | null>(null);

    // Into the peek as it opens, and back where the focus was as it closes.
    useLayoutEffect(() => {
        if (!open) return;
        const active = document.activeElement;
        returnTo.current = active instanceof HTMLElement && active !== document.body ? active : null;
        dialog.current?.focus({preventScroll: true});
        return () => {
            const back = returnTo.current;
            returnTo.current = null;
            if (back?.isConnected) back.focus({preventScroll: true});
        };
    }, [open]);

    if (!peek) return null;

    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
        (e.nativeEvent as MarkedEvent)._handled = true;
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            closePullRequestPeek();
            return;
        }
        // A focused button takes its own Enter.
        if ((e.target as HTMLElement).matches('button, a, input, textarea, select')) return;
        if (e.key === 'Enter') {
            e.preventDefault();
            openPeekFullView();
        } else if (e.key === 'o' && !e.shiftKey) {
            e.preventDefault();
            openPeekOnGitHub();
        } else if (e.key === 'u' && !e.shiftKey) {
            e.preventDefault();
            togglePeekDiffMode();
        }
    };

    const onBackdrop = (e: MouseEvent<HTMLDivElement>): void => {
        if (e.target === e.currentTarget) closePullRequestPeek();
    };

    return createPortal(
        <div className="pr-peek-overlay" onClick={onBackdrop}>
            <div
                ref={dialog}
                className="pr-peek"
                role="dialog"
                aria-modal="true"
                aria-label={`Pull request ${peek.ref.repository} #${peek.ref.number}`}
                tabIndex={-1}
                data-testid="pr-peek"
                onKeyDown={onKeyDown}>
                <PeekHeader peek={peek} mode={mode} />
                <PeekBody peek={peek} mode={mode} />
            </div>
        </div>,
        document.body,
    );
}

function PeekHeader({peek, mode}: {peek: PrPeek; mode: DiffMode}): JSX.Element {
    const {pr} = peek;
    const pill = statePill(pr);
    const stats = peekStats(peek);
    return (
        <header className="pr-peek-head">
            <div className="pr-peek-heading">
                <span className="pr-peek-ref">
                    {peek.ref.repository} #{peek.ref.number}
                </span>
                {pr?.title ? (
                    <h2 className="pr-peek-title">{pr.title}</h2>
                ) : peek.phase === 'loading' ? (
                    <span className="pr-peek-title-skeleton sw-skeleton" aria-hidden="true" />
                ) : null}
                <span className="pr-peek-facts">
                    {pill && <Pills pills={[pill]} />}
                    {stats && <LineCounts stats={stats} />}
                </span>
            </div>
            <div className="pr-peek-actions">
                <ModeToggle mode={mode} />
                <button type="button" className="sw-btn" onClick={openPeekOnGitHub}>
                    Open on GitHub <kbd className="sw-kbd">o</kbd>
                </button>
                <button type="button" className="sw-btn is-primary" onClick={openPeekFullView}>
                    Full view <kbd className="sw-kbd">↵</kbd>
                </button>
                <button
                    type="button"
                    className="pr-peek-close"
                    aria-label="Close (Esc)"
                    title="Close (Esc)"
                    onClick={closePullRequestPeek}>
                    ×
                </button>
            </div>
        </header>
    );
}

function PeekBody({peek, mode}: {peek: PrPeek; mode: DiffMode}): JSX.Element {
    const loading = peek.phase === 'loading';
    return (
        <div className="pr-peek-body sw-diff" aria-busy={loading}>
            {loading ? (
                <div className="sw-diff-skeleton" aria-hidden="true">
                    <div className="sw-skeleton" />
                    <div className="sw-skeleton" />
                    <div className="sw-skeleton" />
                </div>
            ) : peek.error ? (
                <div className="sw-diff-empty pr-peek-error" role="alert">
                    {peek.error}
                </div>
            ) : peek.files.length === 0 ? (
                <div className="sw-diff-empty">No changes to show.</div>
            ) : (
                peek.files.map((file, i) => (
                    <PeekFile
                        key={file.path}
                        file={file}
                        mode={mode}
                        expanded={peek.expanded.includes(file.path)}
                        eager={i < EAGER_FILES}
                    />
                ))
            )}
        </div>
    );
}

function ModeToggle({mode}: {mode: DiffMode}): JSX.Element {
    return (
        <div className="sw-seg" role="group" aria-label="Diff layout (u)">
            {(['unified', 'split'] as const).map((option) => (
                <button
                    key={option}
                    type="button"
                    className="sw-seg-btn"
                    aria-pressed={mode === option}
                    onClick={() => setPeekDiffMode(option)}>
                    {option === 'unified' ? 'Unified' : 'Split'}
                </button>
            ))}
        </div>
    );
}

const PeekFile = memo(function PeekFile({
    file,
    mode,
    expanded,
    eager,
}: {
    file: FileDiff;
    mode: DiffMode;
    expanded: boolean;
    eager: boolean;
}): JSX.Element {
    const head = useRef<HTMLElement>(null);
    const reason = collapsedText(file);
    const collapsed = reason !== null && !expanded;
    const pill = fileStatusPill(file, false);

    const showDiff = (): void => {
        // The button goes as the lines come; the focus stays in the peek, so its keys keep working.
        head.current?.focus({preventScroll: true});
        expandPeekFile(file.path);
    };

    return (
        <section className="sw-file" aria-label={file.path} data-testid="pr-peek-file" data-path={file.path}>
            <header ref={head} className="sw-file-head" tabIndex={-1}>
                <span className="sw-file-path">
                    {file.oldPath && <span className="sw-file-old">{file.oldPath} → </span>}
                    {file.path}
                </span>
                {pill && <Pills pills={[pill]} />}
                {!file.binary && <LineCounts stats={file} />}
            </header>
            {file.binary ? (
                <div className="sw-file-row">Binary file changed</div>
            ) : collapsed ? (
                <div className="sw-file-row is-collapsed">
                    <span>{reason}</span>
                    <button type="button" className="sw-btn sw-btn-small" onClick={showDiff}>
                        Show diff
                    </button>
                </div>
            ) : file.hunks.length === 0 ? (
                <div className="sw-file-row">No changes to the content</div>
            ) : (
                <DiffRows file={file} mode={mode} eager={eager} review={null} />
            )}
        </section>
    );
});

/** The PR's state as a pill; nothing while `gh` has not said. */
function statePill(pr: PullRequestStatus | null): Pill | null {
    switch (pr?.state) {
        case 'open':
            return {label: 'Open', tone: 'green'};
        case 'draft':
            return {label: 'Draft', tone: 'grey'};
        case 'merged':
            return {label: 'Merged', tone: 'lavender'};
        case 'closed':
            return {label: 'Closed', tone: 'grey'};
        default:
            return null;
    }
}

/** `+a −d`: GitHub's count when it gave one, else the diff's own once it is in. */
function peekStats(peek: PrPeek): LineStats | null {
    const {pr} = peek;
    if (pr?.additions !== undefined && pr.deletions !== undefined) {
        return {additions: pr.additions, deletions: pr.deletions};
    }
    return peek.files.length > 0 ? diffSummary(peek.files).stats : null;
}
