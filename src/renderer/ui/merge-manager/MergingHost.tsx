/**
 * Where merging runs (#442), on the Merge manager's page: the header's pill
 * with Hand off, Bring merging back and Take back anyway, and the "While
 * merging was on <VM>" summary under the tiles.
 *
 * - On this Mac: "Merging on this Mac" and "Hand off merging to <VM>"; with
 *   several VMs a picker beside it, the last choice first. A refused hand-off
 *   says why, with the command that fixes it.
 * - On a VM: "Merging on <VM>", the hand-off's warning when there was one,
 *   and Bring merging back. While the VM cannot be reached: why, in words,
 *   with Reconnect and Take back anyway; "Reconnecting to <VM>…" while its
 *   link is dialled again.
 */
import {useState, type JSX} from 'react';
import {useStore} from '../use-store';
import {awayRef, type AwaySummary, type MergingHostView} from '../../../domain/merge-manager/merging-host';
import {
    bringMergingBack,
    dismissAwaySummary,
    handOffMerging,
    reconnectMerging,
    takeMergingBack,
    type MoveAnswer,
} from './merging-actions';
import {openMergeManager} from './page-actions';

const MAC: MergingHostView = {kind: 'mac', vms: [], offered: null};

export function MergingHostPill(): JSX.Element {
    const host = useStore((state) => state.mergeManager.state.merging ?? MAC);
    const [chosen, setChosen] = useState<string | null>(null);
    /** The move under way, by its action, so only its own button says so. */
    const [busy, setBusy] = useState<(() => Promise<MoveAnswer>) | null>(null);
    const [answer, setAnswer] = useState<MoveAnswer | null>(null);

    const run = async (move: () => Promise<MoveAnswer>): Promise<void> => {
        setBusy(() => move);
        setAnswer(null);
        try {
            setAnswer(await move());
        } finally {
            setBusy(null);
        }
    };

    if (host.kind === 'mac') {
        const vm = host.vms.find((candidate) => candidate.key === chosen) ?? host.offered;
        return (
            <div className="mm-host-row">
                <span className="mm-host" title="The lane runner and the fix errands run here" data-host="mac">
                    <i aria-hidden="true" />
                    Merging on this Mac
                </span>
                {vm && host.vms.length > 1 && (
                    <select
                        className="sw-select mm-host-pick"
                        aria-label="VM to hand merging off to"
                        value={vm.key}
                        onChange={(e) => setChosen(e.target.value)}>
                        {host.vms.map((candidate) => (
                            <option key={candidate.key} value={candidate.key}>
                                {candidate.name}
                            </option>
                        ))}
                    </select>
                )}
                {vm && (
                    <button
                        type="button"
                        className="sw-btn"
                        disabled={busy !== null}
                        onClick={() => void run(() => handOffMerging(vm.key))}>
                        {busy ? 'Handing off…' : `Hand off merging to ${vm.name}`}
                    </button>
                )}
                <MoveNote answer={answer} />
            </div>
        );
    }

    const away = !host.reachable || answer?.unreachable === true;
    const reconnecting = host.reconnecting;
    // A failed move says why itself; otherwise the VM's trouble is the note.
    const trouble = away && !reconnecting && !answer?.text ? host.trouble : null;
    return (
        <div className="mm-host-row">
            <span
                className={'mm-host is-vm' + (host.reachable ? '' : ' is-away')}
                data-host="vm"
                title={
                    host.reachable
                        ? `The lane runner and the fix errands run on ${host.vm.name}`
                        : (host.trouble ?? `${host.vm.name} has not answered lately`)
                }>
                <i aria-hidden="true" />
                {reconnecting ? `Reconnecting to ${host.vm.name}…` : `Merging on ${host.vm.name}`}
            </span>
            {away && (
                <button
                    type="button"
                    className="sw-btn"
                    disabled={busy !== null || reconnecting}
                    onClick={() => void run(reconnectMerging)}>
                    {reconnecting || busy === reconnectMerging ? 'Reconnecting…' : 'Reconnect'}
                </button>
            )}
            <button
                type="button"
                className="sw-btn"
                disabled={busy !== null}
                onClick={() => void run(bringMergingBack)}>
                {busy === bringMergingBack ? 'Bringing back…' : 'Bring merging back'}
            </button>
            {away && (
                <button
                    type="button"
                    className="sw-btn"
                    disabled={busy !== null}
                    title={`${host.vm.name} stands down when it reconnects`}
                    onClick={() => void run(takeMergingBack)}>
                    Take back anyway
                </button>
            )}
            {host.warning && !answer && !trouble && <span className="mm-host-note">{host.warning}</span>}
            {trouble && (
                <span className="mm-host-note is-error" role="status">
                    {trouble}
                </span>
            )}
            <MoveNote answer={answer} />
        </div>
    );
}

function MoveNote({answer}: {answer: MoveAnswer | null}): JSX.Element | null {
    if (!answer?.text) return null;
    return (
        <span className={'mm-host-note' + (answer.ok ? '' : ' is-error')} role="status">
            {answer.text}
            {answer.fix && <code>{answer.fix}</code>}
        </span>
    );
}

/** "While merging was on <VM>": merged, needs you (with errand questions), still running; until dismissed. */
export function AwaySummaryBox(): JSX.Element | null {
    const summary = useStore((state) => {
        const host = state.mergeManager.state.merging;
        return host?.kind === 'vm' ? host.summary : null;
    });
    if (!summary || isEmpty(summary)) return null;
    return (
        <section className="mm-away" aria-label={`While merging was on ${summary.vm}`}>
            <header>
                <h2>While merging was on {summary.vm}</h2>
                <button type="button" className="sw-btn" onClick={() => void dismissAwaySummary()}>
                    Dismiss
                </button>
            </header>
            <AwayList label="Merged" prs={summary.merged} />
            <AwayList label="Needs you" prs={summary.needsYou} />
            <AwayList label="Errands still running" prs={summary.running} />
        </section>
    );
}

function isEmpty(summary: AwaySummary): boolean {
    return summary.merged.length + summary.needsYou.length + summary.running.length === 0;
}

function AwayList({
    label,
    prs,
}: {
    label: string;
    prs: readonly (AwaySummary['merged'][number] & {question?: string | null})[];
}): JSX.Element | null {
    if (prs.length === 0) return null;
    return (
        <div className="mm-away-group">
            <h3>
                {label} <span>{prs.length}</span>
            </h3>
            <ul>
                {prs.map((pr) => (
                    <li key={pr.key}>
                        <button
                            type="button"
                            className="mm-away-pr"
                            title={`${pr.repository}#${pr.number}`}
                            onClick={() => openMergeManager(pr.key)}>
                            <span className="mm-away-ref">{awayRef(pr)}</span>
                            {pr.title}
                        </button>
                        {pr.question && <q>{pr.question}</q>}
                    </li>
                ))}
            </ul>
        </div>
    );
}
