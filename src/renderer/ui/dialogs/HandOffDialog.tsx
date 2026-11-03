/**
 * "Hand off to <host>" (#276 stage 2): what goes over to the VM, the ignored
 * files to carry along, and the run.
 *
 * - While the preview is read it says so; a project that can't be handed off
 *   (not a git repository, no origin) says why, in place of the form.
 * - The form: the branch, the commits not on origin and the uncommitted
 *   changes; the ignored files that look like config, each with its size and
 *   ticked as last time; and "Updates the copy on …" when there is one.
 * - Hand off runs it, with its progress lines under the form. On success
 *   "Handed off" and Open the copy, which goes to the copy's page; on an
 *   error its message and Retry.
 *
 * Escape (or Cancel) closes it and Enter presses the primary button, as in
 * the other dialogs. Closing it while it runs leaves the hand-off going, and
 * opening it again shows the same run.
 */
import {useEffect, useRef} from 'react';
import type {JSX} from 'react';
import {useStore} from '../use-store';
import {projectLabel} from '../../features/sessions/project-label';
import {runIn} from '../../state/handoff-slice';
import {DialogShell} from './DialogShell';
import {carriedLines, existingNote, FILES_NOTE, fileSize, runView} from '../project-page/handoff-view';
import {closeHandOffDialog, openCopy, runHandOff, toggleHandoffFile} from '../project-page/handoff-actions';
import type {HandoffHost} from '../../../application/services/project-handoff';

export interface HandOffDialogProps {
    localPath: string;
    host: HandoffHost;
    onClose(): void;
}

export function HandOffDialog({localPath, host, onClose}: HandOffDialogProps): JSX.Element {
    const dialog = useStore((state) => (state.handoff.dialog?.localPath === localPath ? state.handoff.dialog : null));
    const run = useStore((state) => runIn(state.handoff, localPath));
    const body = useRef<HTMLDivElement>(null);
    const view = runView(run);
    const preview = dialog?.preview ?? {phase: 'loading' as const};
    const ticked = dialog?.ticked ?? [];

    // Into the dialog as it opens, so Escape and Enter are its own and not the page's under it.
    useEffect(() => {
        body.current?.focus({preventScroll: true});
    }, []);

    const close = (): void => closeHandOffDialog(onClose);

    const primary = (): void => {
        if (view.copyPath) openCopy(view.copyPath, close);
        else if (preview.phase === 'ok' && !view.disabled) void runHandOff(localPath, host.key, ticked);
        else if (preview.phase === 'error') close();
    };

    // Enter on a focused button is that button's own click.
    const onSubmit = (): void => {
        if (document.activeElement instanceof HTMLButtonElement) return;
        primary();
    };

    const editable = preview.phase === 'ok' && run.phase !== 'running' && run.phase !== 'done';

    return (
        <DialogShell
            overlayClass="new-session-overlay"
            dialogClass="new-session-dialog handoff-dialog"
            onClose={close}
            onSubmit={onSubmit}
            submitFromInputs>
            <div ref={body} className="handoff-body" tabIndex={-1} role="dialog" aria-labelledby="handoff-title">
                <h3 id="handoff-title">{'Hand off to ' + host.label}</h3>
                <div className="handoff-project">{projectLabel(localPath)}</div>

                {preview.phase === 'loading' && <div className="handoff-quiet">Reading the project…</div>}

                {preview.phase === 'error' && (
                    <div className="handoff-error" role="alert">
                        {preview.error}
                    </div>
                )}

                {preview.phase === 'ok' && (
                    <>
                        <div className="settings-field">
                            <div className="settings-label">What goes over</div>
                            <ul className="handoff-carried">
                                {carriedLines(preview.preview).map((line) => (
                                    <li key={line.text + (line.code ?? '')}>
                                        {line.text}
                                        {line.code && <code className="handoff-code">{line.code}</code>}
                                    </li>
                                ))}
                            </ul>
                        </div>
                        {preview.preview.candidates.length > 0 && (
                            <div className="settings-field">
                                <div className="settings-label">Ignored files</div>
                                <div className="handoff-files">
                                    {preview.preview.candidates.map((file) => (
                                        <label key={file.path} className="handoff-file">
                                            <input
                                                type="checkbox"
                                                checked={ticked.includes(file.path)}
                                                disabled={!editable}
                                                onChange={() => toggleHandoffFile(file.path)}
                                            />
                                            <span className="handoff-file-path">{file.path}</span>
                                            <span className="handoff-file-size">{fileSize(file.size)}</span>
                                        </label>
                                    ))}
                                </div>
                                <div className="handoff-note">{FILES_NOTE}</div>
                            </div>
                        )}
                        {existingNote(preview.preview, host) && (
                            <div className="handoff-note handoff-existing">{existingNote(preview.preview, host)}</div>
                        )}
                    </>
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
                    <button className="new-session-cancel-btn" onClick={close}>
                        {run.phase === 'done' || preview.phase === 'error' ? 'Close' : 'Cancel'}
                    </button>
                    {preview.phase !== 'error' && (
                        <button
                            className="new-session-start-btn"
                            disabled={preview.phase !== 'ok' || view.disabled}
                            onClick={primary}>
                            {view.label}
                        </button>
                    )}
                </div>
            </div>
        </DialogShell>
    );
}
