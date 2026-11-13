/**
 * The Merge manager's page (#439, ⌘⇧L): what the main area shows while its
 * route is `mergeManager`. Its figure and where merging runs ("Merging on
 * this Mac") in the header; tiles that count the user's landed PRs by stage
 * and the CI runs saved this week; every lane, grouped by repository with its
 * kind, the head on top as a card with three steps and the rest in the lane's
 * order (teammates' queue entries faded); Merged today at the bottom; and the
 * selected row's detail beside it, per stage, with its actions.
 *
 * What it shows is `domain/merge-manager/page`; its keys, while it has the
 * focus and never in a field, are `page-keys`; Esc closes it.
 *
 * Rendered into `#merge-manager-page`, which `ui/main-area/install-main-area`
 * shows and hides with the route.
 */
import {useEffect, useLayoutEffect, useRef, type JSX, type KeyboardEvent, type ReactNode} from 'react';
import {getState} from '../../state/app-store';
import {useStore} from '../use-store';
import {formatDate} from '../../lib/format';
import {SceneFigure} from '../bug-manager/ManagerFigure';
import {mergeFigureOf, type MergeFigure} from '../../../domain/merge-manager/figure';
import {ordinal} from '../../../domain/merge-manager/stage-words';
import {
    ciRunsSaved,
    dayStart,
    errandNotes,
    errandOf,
    headSteps,
    laneKindLabel,
    mergeManagerTiles,
    mergedToday,
    pageLanes,
    pageSubline,
    rowActions,
    rowStageLabel,
    savedText,
    selectedRow,
    type MergeManagerPageFacts,
    type PageLane,
    type PageRow,
} from '../../../domain/merge-manager/page';
import type {LandedView} from '../../../domain/merge-manager/model';
import type {MergeManagerPageState} from '../../state/merge-manager-slice';
import {mergeKeyAction} from './page-keys';
import {
    closeMergeManager,
    nudgeFromPage,
    openRowOnGitHub,
    openRowSession,
    selectMergeRow,
    stepMergeRow,
    tryAgainFromPage,
    typeTryAgainNote,
    unlandFromPage,
} from './page-actions';

export function MergeManagerPage(): JSX.Element | null {
    const open = useStore((state) => state.mainArea.route.kind === 'mergeManager');
    return open ? <MergeManagerView /> : null;
}

function sameFigure(a: MergeFigure, b: MergeFigure): boolean {
    return a.pose === b.pose && a.count === b.count;
}

function MergeManagerView(): JSX.Element {
    const root = useRef<HTMLDivElement>(null);
    const merge = useStore((state) => state.mergeManager.state);
    const page = useStore((state) => state.mergeManager.page);
    const figure = useStore((state) => mergeFigureOf(state.mergeManager.state), sameFigure);
    const now = useStore((state) => state.sessionList.now) || Date.now();
    const today = dayStart(now);
    const lanes = pageLanes(merge);
    const tiles = mergeManagerTiles(merge, today);
    const merged = mergedToday(merge, today);
    const selected = selectedRow(lanes, page.selected);

    // Into the page as it opens, so its keys reach it without a click.
    useLayoutEffect(() => {
        root.current?.focus({preventScroll: true});
    }, []);

    // The selected row stays in view.
    useEffect(() => {
        if (!selected) return;
        root.current
            ?.querySelector(`[data-merge-key="${CSS.escape(selected.key)}"]`)
            ?.scrollIntoView({block: 'nearest'});
    }, [selected?.key]);

    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        const target = e.target as HTMLElement;
        if (e.key === 'Escape') {
            e.preventDefault();
            if (target.matches('input, textarea')) root.current?.focus({preventScroll: true});
            else closeMergeManager();
            return;
        }
        if (target.matches('input, textarea, select, [contenteditable="true"]')) return;
        // A focused button takes its own ⏎.
        if (e.key === 'Enter' && target !== root.current) return;
        if (e.shiftKey) return;
        const state = getState().mergeManager;
        const action = mergeKeyAction(e.key, selectedRow(pageLanes(state.state), state.page.selected));
        if (!action) return;
        e.preventDefault();
        // N here is Nudge, not a quick session.
        e.stopPropagation();
        switch (action.kind) {
            case 'step':
                stepMergeRow(action.step);
                break;
            case 'open':
                void openRowSession(action.row);
                break;
            case 'tryAgain':
                void tryAgainFromPage(action.row);
                break;
            case 'nudge':
                void nudgeFromPage(action.row);
                break;
            case 'unland':
                void unlandFromPage(action.row);
                break;
            case 'github':
                openRowOnGitHub(action.row);
                break;
        }
    };

    const focusRows = (): void => root.current?.focus({preventScroll: true});

    return (
        <div
            ref={root}
            className="sw-page mm-page"
            tabIndex={-1}
            role="region"
            aria-label="Merge manager"
            onKeyDown={onKeyDown}>
            <header className="sw-header pp-header">
                <div className="sw-header-row">
                    <button
                        type="button"
                        className="sw-btn sw-back"
                        onClick={closeMergeManager}
                        aria-label="Close the Merge manager (Esc)">
                        <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true">
                            <path d="M18 6 6 18M6 6l12 12" />
                        </svg>
                        Close <kbd className="sw-kbd">esc</kbd>
                    </button>
                    <SceneFigure scene={{kind: 'merge', state: figure.pose, count: figure.count, label: ''}} />
                    <div className="sw-heading">
                        <h1 className="sw-title pp-title">Merge manager</h1>
                        <div className="sw-subline pp-subline">
                            <span>{pageSubline(lanes)}</span>
                        </div>
                    </div>
                    <span className="mm-host" title="The lane runner and the fix errands run here">
                        <i aria-hidden="true" />
                        Merging on this Mac
                    </span>
                </div>
            </header>

            <div className="im-tiles mm-tiles" role="group" aria-label="Summary">
                <Tile n={tiles.needsYou} label="Needs you" hint="push, answer or try again" tone="hot" />
                <Tile n={tiles.fixing} label="Fixing" hint="a fix errand on it" tone="green" />
                <Tile n={tiles.merging} label="Merging" hint="yours as the head" tone="purple" />
                <Tile
                    n={tiles.waiting}
                    label="Waiting"
                    hint={tiles.willConflict > 0 ? `${tiles.willConflict} will conflict` : 'for their turn'}
                />
                <Tile n={tiles.held} label="Held" hint="keep their place" tone="muted" />
                <Tile
                    n={tiles.mergedToday}
                    label="Merged today"
                    hint={tiles.lastMergedAt ? 'last ' + clock(tiles.lastMergedAt) : 'none yet'}
                    tone="purple"
                />
                <Tile
                    n={ciRunsSaved(page.facts?.savedThisWeek)}
                    label="CI runs saved"
                    hint="this week · estimate"
                    saved
                    title={savedText(page.facts?.savedThisWeek) ?? 'Nothing saved yet this week'}
                />
            </div>

            {page.notice && (
                <div className="tk-status" role="status">
                    {page.notice}
                </div>
            )}

            <div className={'im-body' + (selected ? ' has-detail' : '')}>
                <div className="im-list" role="listbox" aria-label="Lanes">
                    {lanes.length === 0 && <EmptyLine />}
                    {lanes.map((lane) => (
                        <Lane
                            key={lane.repository}
                            lane={lane}
                            selected={selected?.key ?? null}
                            onSelect={(key) => {
                                selectMergeRow(key);
                                focusRows();
                            }}
                        />
                    ))}
                    {merged.length > 0 && <MergedToday merged={merged} lanes={merge.lanes} />}
                </div>
                {selected && (
                    <Detail
                        row={selected}
                        lane={lanes.find((l) => l.repository === selected.repository)!}
                        page={page}
                        now={now}
                    />
                )}
            </div>

            <footer className="tk-keys" aria-label="Keys">
                <span>
                    <kbd className="sw-kbd">J</kbd>/<kbd className="sw-kbd">K</kbd> next, previous
                </span>
                <span>
                    <kbd className="sw-kbd">↵</kbd> open session or errand
                </span>
                <span>
                    <kbd className="sw-kbd">T</kbd> try again
                </span>
                <span>
                    <kbd className="sw-kbd">N</kbd> nudge
                </span>
                <span>
                    <kbd className="sw-kbd">U</kbd> unland
                </span>
                <span>
                    <kbd className="sw-kbd">O</kbd> open on GitHub
                </span>
            </footer>
        </div>
    );
}

function Tile({
    n,
    label,
    hint,
    tone,
    saved,
    title,
}: {
    n: number;
    label: string;
    hint: string;
    tone?: 'hot' | 'green' | 'purple' | 'muted';
    saved?: boolean;
    title?: string;
}): JSX.Element {
    return (
        <div className={'im-tile mm-tile' + (tone ? ' is-' + tone : '') + (saved ? ' is-saved' : '')} title={title}>
            <span className="im-tile-n">{n}</span>
            <span className="im-tile-l">{label}</span>
            <span className="im-tile-hint">{hint}</span>
        </div>
    );
}

function EmptyLine(): JSX.Element {
    return (
        <div className="mm-empty">
            <p>
                <b>Nothing landed.</b> Press <b>Land it</b> on one of your own open pull requests: in the session
                header, a sidebar row&apos;s menu (<kbd className="sw-kbd">L</kbd>), the session tray or a project
                page&apos;s pull requests. From then on the Merge manager takes it to merged: it waits its turn in its
                repository&apos;s lane, is updated and tested only as the head, and is fixed by an errand when it fails
                out.
            </p>
        </div>
    );
}

// ── The lanes ──

function Lane({
    lane,
    selected,
    onSelect,
}: {
    lane: PageLane;
    selected: string | null;
    onSelect: (key: string) => void;
}): JSX.Element {
    const name = lane.repository.split('/').pop() ?? lane.repository;
    return (
        <div role="group" aria-label={lane.repository}>
            <div className="im-group mm-group">
                <span title={lane.repository}>{name}</span>
                <span className={'mm-lane' + (lane.kind === 'switchboard' ? ' is-switchboard' : '')}>
                    {laneKindLabel(lane.kind)}
                </span>
                {lane.approvalLostOnPush && (
                    <span
                        className="mm-lane-warn"
                        title="A push to a PR here dismisses its approval or needs a new one">
                        updating the head loses its approval
                    </span>
                )}
            </div>
            {lane.rows.map((row) =>
                row.stage.kind === 'head' ? (
                    <div key={row.key} className={'mm-headcard' + (row.teammate ? ' is-theirs' : '')}>
                        <Row row={row} selected={selected === row.key} onSelect={onSelect} />
                        <ol className="mm-steps" aria-label="Where the head is">
                            {headSteps(row).map((step) => (
                                <li key={step.label} className={'mm-step is-' + step.state}>
                                    <span>
                                        {step.state === 'done' && '✓ '}
                                        {step.label}
                                    </span>
                                    <span className="mm-bar">
                                        <span style={{width: Math.round(step.progress * 100) + '%'}} />
                                    </span>
                                </li>
                            ))}
                        </ol>
                    </div>
                ) : (
                    <Row key={row.key} row={row} selected={selected === row.key} onSelect={onSelect} />
                ),
            )}
        </div>
    );
}

function Row({
    row,
    selected,
    onSelect,
}: {
    row: PageRow;
    selected: boolean;
    onSelect: (key: string) => void;
}): JSX.Element {
    return (
        <div
            role="option"
            aria-selected={selected}
            data-merge-key={row.key}
            className={'mm-row' + (selected ? ' is-selected' : '') + (row.teammate ? ' is-theirs' : '')}
            onClick={() => onSelect(row.key)}>
            <span className="mm-place">{row.order ?? '·'}</span>
            <span className="mm-row-text">
                <span className="mm-row-title">
                    #{row.number} {row.title}
                    {row.words.flag && <span className="pp-stage-flag"> · {row.words.flag}</span>}
                </span>
                <span className="mm-row-meta">{rowMeta(row)}</span>
            </span>
            <StagePill row={row} />
        </div>
    );
}

function StagePill({row}: {row: PageRow}): JSX.Element {
    return (
        <span className={'pp-stage is-landed-' + row.stage.kind} title={row.words.title}>
            <i aria-hidden="true" />
            {rowStageLabel(row)}
        </span>
    );
}

/** A row's second line: whose it is or who approved it, and its branch. */
function rowMeta(row: PageRow): string {
    if (row.teammate) return `${row.teammate.author ?? 'someone'}'s · not yours`;
    const approved = row.landed?.facts?.approvedBy ?? [];
    const parts = [
        approved.length > 0 ? 'approved by ' + approved.join(', ') : null,
        row.landed?.headRef ?? null,
    ].filter((part): part is string => !!part);
    return parts.join(' · ');
}

function MergedToday({
    merged,
    lanes,
}: {
    merged: readonly LandedView[];
    lanes: readonly {repository: string; pullRequests: readonly LandedView[]}[];
}): JSX.Element {
    const repositoryOf = (pr: LandedView): string =>
        lanes.find((lane) => lane.pullRequests.includes(pr))?.repository ?? pr.repository;
    return (
        <div role="group" aria-label="Merged today">
            <div className="im-group mm-group">
                Merged today<span className="mm-group-meta">sessions archived</span>
            </div>
            {merged.map((pr) => (
                <div key={pr.key} className="mm-row is-merged">
                    <span className="mm-place is-merged">✓</span>
                    <span className="mm-row-text">
                        <span className="mm-row-title">
                            #{pr.number} {pr.title}
                        </span>
                        <span className="mm-row-meta">
                            {repositoryOf(pr)} · merged {pr.stage.kind === 'merged' ? clock(pr.stage.at) : ''}
                        </span>
                    </span>
                    <span className="pp-stage is-landed-merged">
                        <i aria-hidden="true" />
                        Merged
                    </span>
                </div>
            ))}
        </div>
    );
}

// ── The detail ──

function Detail({
    row,
    lane,
    page,
    now,
}: {
    row: PageRow;
    lane: PageLane;
    page: MergeManagerPageState;
    now: number;
}): JSX.Element {
    const offers = rowActions(row);
    const where =
        lane.kind === 'switchboard'
            ? `${ordinal(row.order ?? 1)} in land order`
            : row.order !== null
              ? `number ${row.order} in the merge queue`
              : 'out of the queue’s order';
    return (
        <aside className="im-detail mm-detail" aria-label={`#${row.number} ${row.title}`}>
            <div className="im-meta">
                <StagePill row={row} />
                <span>
                    {row.repository} · {laneKindLabel(lane.kind)} · {where}
                </span>
            </div>
            <div className="im-titlerow">
                <h2 className="im-title">
                    #{row.number} {row.title}
                </h2>
                <button type="button" className="im-out" onClick={() => openRowOnGitHub(row)}>
                    Open PR #{row.number} on GitHub ↗
                </button>
            </div>
            <StageBody row={row} lane={lane} facts={page.facts} now={now} />
            {offers.tryAgain && <TryAgainBox row={row} page={page} />}
            <div className="im-actions">
                {offers.open && (
                    <button type="button" className="sw-btn is-primary" onClick={() => void openRowSession(row)}>
                        {offers.open.kind === 'errand' ? 'Open errand' : 'Open session'} <kbd className="sw-kbd">↵</kbd>
                    </button>
                )}
                {offers.nudge && (
                    <button type="button" className="sw-btn" onClick={() => void nudgeFromPage(row)}>
                        Nudge {offers.nudge} <kbd className="sw-kbd">N</kbd>
                    </button>
                )}
                {offers.unland && (
                    <button type="button" className="sw-btn is-ghost" onClick={() => void unlandFromPage(row)}>
                        Unland <kbd className="sw-kbd">U</kbd>
                    </button>
                )}
            </div>
        </aside>
    );
}

function Box({label, children, tone}: {label: string; children: ReactNode; tone?: 'warn'}): JSX.Element {
    return (
        <div className={'im-box' + (tone ? ' is-' + tone : '')}>
            <span className="im-box-label">{label}</span>
            {children}
        </div>
    );
}

function Step({
    tone,
    children,
    at,
}: {
    tone?: 'purple' | 'yellow' | 'green' | 'red';
    children: ReactNode;
    at?: string;
}): JSX.Element {
    return (
        <div className={'mm-vstep' + (tone ? ' is-' + tone : '')}>
            <i aria-hidden="true" />
            <div>{children}</div>
            <span>{at ?? ''}</span>
        </div>
    );
}

function StageBody({
    row,
    lane,
    facts,
    now,
}: {
    row: PageRow;
    lane: PageLane;
    facts: MergeManagerPageFacts | null;
    now: number;
}): JSX.Element | null {
    const {stage} = row;
    switch (stage.kind) {
        case 'head':
            return row.teammate ? (
                <Box label="Not yours">
                    <p>
                        {row.teammate.author ?? 'A teammate'}&apos;s pull request is the queue&apos;s head. Yours behind
                        it wait without updates, so they cost no CI until it merges or fails out.
                    </p>
                </Box>
            ) : (
                <HeadBody row={row} lane={lane} facts={facts} />
            );
        case 'waiting':
            return (
                <Box label="Waiting">
                    <p>
                        {lane.kind === 'switchboard'
                            ? 'Becomes the head when the head merges or fails out. Not updated until then, so it spends no CI.'
                            : `Number ${row.order ?? '?'} in the merge queue. The queue holds its CI back while it waits behind the head.`}
                    </p>
                    {row.words.flag && (
                        <p className="mm-warn">
                            It will conflict with the trunk. A fix errand starts only once it is the head, so the fix is
                            not stale by then.
                        </p>
                    )}
                </Box>
            );
        case 'held':
            return <HeldBody row={row} />;
        case 'fixing':
            return <FixingBody row={row} facts={facts} now={now} />;
        case 'needsYou':
            return <NeedsYouBody row={row} />;
        case 'merged':
            return null;
    }
}

function HeadBody({
    row,
    lane,
    facts,
}: {
    row: PageRow;
    lane: PageLane;
    facts: MergeManagerPageFacts | null;
}): JSX.Element {
    const checks = row.landed?.facts?.checks ?? [];
    const passed = checks.filter((check) => check.state === 'passed' || check.state === 'skipped').length;
    const steps = headSteps(row);
    const tone = (index: number): 'purple' | 'yellow' | undefined =>
        steps[index]?.state === 'done' ? 'purple' : steps[index]?.state === 'active' ? 'yellow' : undefined;
    const saved = savedText(facts?.savedByRepository[lane.repository.toLowerCase()]);
    return (
        <>
            <Box label="Where it is">
                {row.landed && (
                    <Step tone="purple" at={clock(row.landed.landedAt)}>
                        <b>Landed</b>
                    </Step>
                )}
                <Step tone={tone(0)}>
                    <b>Head</b> ·{' '}
                    {lane.kind === 'switchboard' ? 'updated on the trunk (rebase)' : 'rebased by the queue'}
                </Step>
                <Step tone={tone(1)}>
                    <b>{steps[1]?.label ?? 'Checks'}</b>
                </Step>
                <Step tone={tone(2)}>Merge · the session archives with the rocket</Step>
            </Box>
            {checks.length > 0 && (
                <Box label={`Required checks · ${passed} of ${checks.length} passed`}>
                    <div className="mm-checks">
                        {checks.map((check) => (
                            <div key={check.name} className={'is-' + check.state}>
                                {CHECK_MARK[check.state]} <span>{check.name}</span>
                            </div>
                        ))}
                    </div>
                </Box>
            )}
            {lane.kind === 'switchboard' && (
                <Box label="CI this lane saved this week">
                    <p>{saved ?? 'Nothing yet this week.'}</p>
                </Box>
            )}
        </>
    );
}

const CHECK_MARK: Record<string, string> = {
    passed: '✓',
    skipped: '✓',
    failed: '✗',
    cancelled: '⊘',
    running: '◌',
    queued: '◌',
    missing: '◌',
};

function HeldBody({row}: {row: PageRow}): JSX.Element {
    if (row.stage.kind !== 'held') return <></>;
    const {reason} = row.stage;
    switch (reason.kind) {
        case 'base':
            return (
                <Box label="Stacked">
                    <p>
                        {row.words.title}. Then it is retargeted to the trunk, and a fix errand rebases it with{' '}
                        <code>--onto</code> past the merged commits only if that leaves conflicts.
                    </p>
                </Box>
            );
        case 'review':
            return (
                <Box label="Held · keeps its place">
                    <p>
                        A review is requested from {reason.team ? 'the team ' : '@'}
                        {reason.reviewer}. Passed over until {reason.team ? 'it reviews' : 'they review'}; then it goes
                        back to its place.
                    </p>
                </Box>
            );
        case 'approval':
            return (
                <Box label="Held · keeps its place">
                    <p>Held until it is approved. Switchboard never approves; it keeps its place meanwhile.</p>
                </Box>
            );
        case 'draft':
            return (
                <Box label="Held · keeps its place">
                    <p>Held while it is a draft. Mark it ready for review and it goes back to its place.</p>
                </Box>
            );
    }
}

function FixingBody({row, facts, now}: {row: PageRow; facts: MergeManagerPageFacts | null; now: number}): JSX.Element {
    const errand = errandOf(facts, row.key);
    const cause = row.stage.kind === 'fixing' ? row.stage.cause : 'checks';
    const running = errand?.state === 'running';
    const minutes = errand ? Math.max(0, Math.round((now - errand.startedAt) / 60_000)) : null;
    const notes = errandNotes(facts, row.key);
    return (
        <>
            <Box label={running && minutes !== null ? `Fix errand · running ${minutes} min` : 'Fix errand'}>
                <Step tone="red">
                    <b>Failed out as the head</b> ·{' '}
                    {cause === 'conflict' ? 'a conflict with the trunk' : 'a failed required check'}
                </Step>
                <Step tone={running ? 'green' : undefined} at={errand ? clock(errand.startedAt) : undefined}>
                    {errand ? (
                        <>
                            <b>Errand</b> {cause === 'conflict' ? 'rebasing' : 'fixing the checks'} in its own worktree
                        </>
                    ) : (
                        'An errand starts on the next read'
                    )}
                </Step>
                <Step>Pushes the fix → back to its place in the lane</Step>
            </Box>
            <Box label="Runs on this Mac">
                <p>
                    It may push this branch, rebase it and run the tests. It never merges, labels, reviews, or touches
                    another branch.
                </p>
            </Box>
            {notes.length > 0 && (
                <Box label="Earlier errands said">
                    {notes.map((note) => (
                        <p key={note.sessionId + note.startedAt}>
                            {formatDate(new Date(note.startedAt), now)}: {note.note}
                        </p>
                    ))}
                </Box>
            )}
        </>
    );
}

function NeedsYouBody({row}: {row: PageRow}): JSX.Element {
    if (row.stage.kind !== 'needsYou') return <></>;
    const {reason} = row.stage;
    const what =
        reason.kind === 'changes-requested' || reason.kind === 'unresolved-thread'
            ? 'Review feedback is never fixed by an errand. Push a change or resolve the thread and it goes back to its place by itself.'
            : reason.kind === 'errand-stopped'
              ? 'Answer the errand in its session, push a commit, or Try again with a note for the next errand.'
              : 'Push a commit and it goes back to its place by itself.';
    return (
        <Box label="Needs you · keeps its place">
            <p>
                <b>{row.words.title.replace(/^Needs you: /, '')}</b>
            </p>
            <p className="mm-quiet">{what}</p>
        </Box>
    );
}

function TryAgainBox({row, page}: {row: PageRow; page: MergeManagerPageState}): JSX.Element {
    const busy = page.tryAgain[row.key]?.phase === 'busy';
    const failed = page.tryAgain[row.key];
    return (
        <div className="im-box mm-try">
            <label className="im-box-label" htmlFor={'mm-note-' + row.number}>
                A note for the next errand (optional)
            </label>
            <textarea
                id={'mm-note-' + row.number}
                className="im-notes"
                placeholder="What it should know, or try differently"
                value={page.notes[row.key] ?? ''}
                onChange={(e) => typeTryAgainNote(row.key, e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        void tryAgainFromPage(row);
                    }
                }}
            />
            {failed?.phase === 'failed' && <p className="is-error">{failed.reason}</p>}
            <div className="im-actions">
                <button type="button" className="sw-btn" disabled={busy} onClick={() => void tryAgainFromPage(row)}>
                    {busy ? 'Starting…' : 'Try again'} <kbd className="sw-kbd">T</kbd>
                </button>
            </div>
        </div>
    );
}

/** "14:02", in the local time. */
function clock(at: number): string {
    return new Date(at).toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit'});
}
