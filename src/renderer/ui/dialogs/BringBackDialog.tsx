/**
 * "Bring back to this Mac" for one VM session (#276): the counterpart of the
 * session's Hand off to….
 *
 * - While the VM is asked it says so; a session that can't be brought back
 *   (uncommitted changes on the VM, a copy of no local project) says why.
 * - What comes back: the conversation, the branch, and the checkout here it
 *   lands in; a note when Claude is mid-turn, so it waits for the turn to end.
 * - When the branch is on this Mac already, the same choices an issue's or a
 *   task's start offers: Update it (primary), and Delete and recreate…, which
 *   asks once more, naming what goes with it. The main checkout is never
 *   deleted, so it offers Update it only. The choice may also come from the
 *   run, when the branch turned up after the preview.
 * - While it waits: "Waiting for the turn to end…", and Cancel calls it off.
 *   Then the progress lines; on success "Continues on this Mac in …", on an
 *   error its message and Retry.
 *
 * Escape closes it and Enter presses the primary button. Closing it while it
 * runs leaves the Bring back going, and opening it again shows the same run.
 */
import {useEffect, useRef, useState} from 'react';
import type {JSX} from 'react';
import {useStore} from '../use-store';
import {bringBackRunIn} from '../../state/session-bring-back-slice';
import {DialogShell} from './DialogShell';
import {
    bringBackBusyNote,
    bringBackLines,
    bringBackRunView,
    deleteLine,
    existingLine,
    UPDATE_NOTE,
} from './session-bring-back-view';
import {cancelSessionBringBack, closeSessionBringBack, runSessionBringBack} from './session-bring-back-actions';
import type {ExistingBranch, ExistingBranchChoice} from '../../../domain/project/branch-worktree';

export function BringBackDialog({sessionId, onClose}: {sessionId: string; onClose(): void}): JSX.Element {
    const body = useRef<HTMLDivElement>(null);
    const dialog = useStore((state) =>
        state.sessionBringBack.dialog?.sessionId === sessionId ? state.sessionBringBack.dialog : null,
    );
    const run = useStore((state) => bringBackRunIn(state.sessionBringBack, sessionId));
    const [deleting, setDeleting] = useState(false);
    const preview = dialog?.preview ?? {phase: 'loading' as const};
    const view = bringBackRunView(run);
    const close = (): void => closeSessionBringBack(onClose);

    // Into the dialog as it opens, so Escape and Enter are its own and not the page's under it.
    useEffect(() => {
        body.current?.focus({preventScroll: true});
    }, []);

    const busy = preview.phase === 'ok' && preview.preview.busy;
    // The run's question wins: it was asked after the preview.
    const existing: ExistingBranch | null =
        view.existing ?? (run.phase === 'idle' && preview.phase === 'ok' ? preview.preview.existing : null);
    const start = (choice?: ExistingBranchChoice): void => {
        setDeleting(false);
        void runSessionBringBack(sessionId, busy, choice);
    };
    // With the branch here, Retry asks again rather than guess the earlier choice.
    const primary =
        preview.phase === 'ok' && view.primary && !existing ? {...view.primary, press: () => start()} : null;

    // Enter on a focused button is that button's own click.
    const onSubmit = (): void => {
        if (document.activeElement instanceof HTMLButtonElement) return;
        if (primary && !primary.disabled) primary.press();
        else if (preview.phase === 'error') close();
    };
    const secondary = (): void => {
        if (preview.phase !== 'error' && view.secondary.does === 'cancel') void cancelSessionBringBack(sessionId);
        else close();
    };
    const busyNote = preview.phase === 'ok' ? bringBackBusyNote(preview.preview, run) : null;

    return (
        <DialogShell
            overlayClass="new-session-overlay"
            dialogClass="new-session-dialog handoff-dialog bring-back-dialog"
            onClose={close}
            onSubmit={onSubmit}
            submitFromInputs>
            <div ref={body} className="handoff-body" tabIndex={-1} role="dialog" aria-labelledby="bring-back-title">
                <h3 id="bring-back-title">Bring back to this Mac</h3>
                <div className="handoff-project">{dialog?.name || 'This session'}</div>

                {preview.phase === 'loading' && <div className="handoff-quiet">Asking the VM about the session…</div>}

                {preview.phase === 'error' && (
                    <div className="handoff-error" role="alert">
                        {preview.error}
                    </div>
                )}

                {preview.phase === 'ok' && (
                    <>
                        <div className="settings-field">
                            <div className="settings-label">What comes back</div>
                            <ul className="handoff-carried">
                                {bringBackLines(preview.preview).map((line) => (
                                    <li key={line.text + (line.code ?? '')}>
                                        {line.text}
                                        {line.code && <code className="handoff-code">{line.code}</code>}
                                    </li>
                                ))}
                            </ul>
                        </div>
                        {busyNote && <div className="handoff-note handoff-busy">{busyNote}</div>}
                        {existing && (
                            <ExistingChoices
                                existing={existing}
                                deleting={deleting}
                                onUpdate={() => start('reuse')}
                                onAskDelete={() => setDeleting(true)}
                                onDelete={() => start('replace')}
                                onKeep={() => setDeleting(false)}
                            />
                        )}
                    </>
                )}

                {view.status && (
                    <div className="handoff-quiet handoff-waiting" role="status">
                        {view.status}
                    </div>
                )}
                {view.lines.length > 0 && (
                    <pre className="pp-agent-log handoff-log" aria-live="polite">
                        {view.lines.join('\n')}
                    </pre>
                )}
                {view.error && (
                    <div className="handoff-error" role="alert">
                        {view.error}
                    </div>
                )}
                {view.done && (
                    <div className="handoff-done" role="status">
                        {view.done}
                    </div>
                )}

                <div className="new-session-actions">
                    <button className="new-session-cancel-btn" onClick={secondary}>
                        {preview.phase === 'error' ? 'Close' : view.secondary.label}
                    </button>
                    {primary && (
                        <button className="new-session-start-btn" disabled={primary.disabled} onClick={primary.press}>
                            {primary.label}
                        </button>
                    )}
                </div>
            </div>
        </DialogShell>
    );
}

interface ExistingChoicesProps {
    existing: ExistingBranch;
    deleting: boolean;
    onUpdate(): void;
    onAskDelete(): void;
    onDelete(): void;
    onKeep(): void;
}

/** The branch is here already: Update it, or Delete and recreate…, which asks once more. */
function ExistingChoices({existing, deleting, onUpdate, onAskDelete, onDelete, onKeep}: ExistingChoicesProps) {
    if (deleting) {
        return (
            <div
                className="settings-field bring-back-existing"
                role="alertdialog"
                aria-label="Delete worktree and branch">
                <div className="handoff-error">{deleteLine(existing)}</div>
                <div className="bring-back-choices">
                    <button type="button" className="sw-btn is-warn" onClick={onDelete}>
                        Delete and recreate
                    </button>
                    <button type="button" className="sw-btn" onClick={onKeep}>
                        Keep it
                    </button>
                </div>
            </div>
        );
    }
    return (
        <div className="settings-field bring-back-existing" role="group" aria-label="Branch exists">
            <div className="settings-label">Already on this Mac</div>
            <div className="handoff-note">{existingLine(existing)}</div>
            <div className="bring-back-choices">
                <button type="button" className="sw-btn is-primary" onClick={onUpdate}>
                    Update it
                </button>
                {!existing.main && (
                    <button type="button" className="sw-btn is-warn" onClick={onAskDelete}>
                        Delete and recreate…
                    </button>
                )}
            </div>
            <div className="handoff-note">{UPDATE_NOTE}</div>
        </div>
    );
}
