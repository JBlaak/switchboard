/**
 * "Hand off to <host>": what goes over to the VM, the ignored files to carry
 * along, and the run. One dialog, in two modes.
 *
 * Project mode (#276 stage 2), for a local project:
 * - While the preview is read it says so; a project that can't be handed off
 *   (not a git repository, no origin) says why, in place of the form.
 * - The form: the branch, the commits not on origin and the uncommitted
 *   changes; the ignored files that look like config, each with its size and
 *   ticked as last time; and "Updates the copy on …" when there is one.
 * - Hand off runs it, with its progress lines under the form. On success
 *   "Handed off" and Open the copy, which goes to the copy's page; on an
 *   error its message and Retry.
 *
 * Session mode (#276 stage 3), for a local Claude session:
 * - The same form, with the conversation and the worktree the session works
 *   in, and a note when Claude is mid-turn: the hand-off then waits for the
 *   turn to end.
 * - While it waits: "Waiting for the turn to end…", and Cancel calls the
 *   hand-off off. Then the progress lines; on success "Continues on <host>",
 *   and on an error its message and whether the session is still running here.
 *   A hand-off cancelled while it waited closes the dialog.
 *
 * Escape (or Cancel, in the form) closes it and Enter presses the primary
 * button, as in the other dialogs. Closing it while it runs leaves the
 * hand-off going, and opening it again shows the same run.
 */
import {useEffect, useRef} from 'react';
import type {JSX} from 'react';
import {useStore} from '../use-store';
import {projectLabel} from '../../features/sessions/project-label';
import {runIn} from '../../state/handoff-slice';
import {sessionRunIn} from '../../state/session-handoff-slice';
import {DialogShell} from './DialogShell';
import {carriedLines, existingNote, FILES_NOTE, fileSize, runView} from '../project-page/handoff-view';
import {closeHandOffDialog, openCopy, runHandOff, toggleHandoffFile} from '../project-page/handoff-actions';
import {busyNote, sessionCarriedLines, sessionRunView} from './session-handoff-view';
import {
    cancelSessionHandOff,
    closeSessionHandOff,
    runSessionHandOff,
    toggleSessionHandoffFile,
} from './session-handoff-actions';
import type {CarriedLine} from '../project-page/handoff-view';
import type {HandoffCandidate, HandoffHost} from '../../../application/services/project-handoff';

export type HandOffDialogProps = {host: HandoffHost; onClose(): void} & (
    {localPath: string; sessionId?: undefined} | {sessionId: string; localPath?: undefined}
);

export function HandOffDialog(props: HandOffDialogProps): JSX.Element {
    return props.sessionId !== undefined ? (
        <SessionHandOff sessionId={props.sessionId} host={props.host} onClose={props.onClose} />
    ) : (
        <ProjectHandOff localPath={props.localPath} host={props.host} onClose={props.onClose} />
    );
}

/** What the dialog shows and does, whichever mode it is in. */
interface DialogModel {
    readonly title: string;
    /** The project or the session, under the title. */
    readonly subject: string;
    readonly preview:
        | {readonly phase: 'loading'; readonly text: string}
        | {readonly phase: 'error'; readonly error: string}
        | {
              readonly phase: 'ok';
              readonly carried: readonly CarriedLine[];
              readonly candidates: readonly HandoffCandidate[];
              readonly notes: readonly {readonly text: string; readonly className: string}[];
          };
    readonly ticked: readonly string[];
    readonly editable: boolean;
    toggle(path: string): void;
    /** "Waiting for the turn to end…". */
    readonly status: string | null;
    readonly lines: readonly string[];
    readonly error: string | null;
    readonly errorNote: string | null;
    readonly done: string | null;
    readonly primary: {readonly label: string; readonly disabled: boolean; press(): void} | null;
    readonly secondary: {readonly label: string; press(): void};
    close(): void;
}

function ProjectHandOff({localPath, host, onClose}: {localPath: string; host: HandoffHost; onClose(): void}) {
    const dialog = useStore((state) => (state.handoff.dialog?.localPath === localPath ? state.handoff.dialog : null));
    const run = useStore((state) => runIn(state.handoff, localPath));
    const view = runView(run);
    const preview = dialog?.preview ?? {phase: 'loading' as const};
    const ticked = dialog?.ticked ?? [];
    const close = (): void => closeHandOffDialog(onClose);
    const existing = preview.phase === 'ok' ? existingNote(preview.preview, host) : null;

    const press = (): void => {
        if (view.copyPath) openCopy(view.copyPath, close);
        else if (preview.phase === 'ok' && !view.disabled) void runHandOff(localPath, host.key, ticked);
    };

    const model: DialogModel = {
        title: 'Hand off to ' + host.label,
        subject: projectLabel(localPath),
        preview:
            preview.phase === 'loading'
                ? {phase: 'loading', text: 'Reading the project…'}
                : preview.phase === 'error'
                  ? preview
                  : {
                        phase: 'ok',
                        carried: carriedLines(preview.preview),
                        candidates: preview.preview.candidates,
                        notes: existing ? [{text: existing, className: 'handoff-note handoff-existing'}] : [],
                    },
        ticked,
        editable: preview.phase === 'ok' && run.phase !== 'running' && run.phase !== 'done',
        toggle: toggleHandoffFile,
        status: null,
        lines: view.lines,
        error: view.error,
        errorNote: null,
        done: view.done,
        primary:
            preview.phase === 'error'
                ? null
                : {label: view.label, disabled: preview.phase !== 'ok' || view.disabled, press},
        secondary: {label: run.phase === 'done' || preview.phase === 'error' ? 'Close' : 'Cancel', press: close},
        close,
    };
    return <HandOffLayout model={model} />;
}

function SessionHandOff({sessionId, host, onClose}: {sessionId: string; host: HandoffHost; onClose(): void}) {
    const dialog = useStore((state) =>
        state.sessionHandoff.dialog?.sessionId === sessionId ? state.sessionHandoff.dialog : null,
    );
    const run = useStore((state) => sessionRunIn(state.sessionHandoff, sessionId));
    const view = sessionRunView(run);
    const preview = dialog?.preview ?? {phase: 'loading' as const};
    const ticked = dialog?.ticked ?? [];
    const close = (): void => closeSessionHandOff(onClose);

    const does = (what: 'handOff' | 'cancel' | 'close'): void => {
        if (what === 'close') close();
        else if (what === 'cancel') void cancelSessionHandOff(sessionId);
        else if (preview.phase === 'ok') void runSessionHandOff(sessionId, host, ticked, preview.preview.busy);
    };

    const busy = preview.phase === 'ok' ? busyNote(preview.preview, run) : null;

    const model: DialogModel = {
        title: 'Hand off to ' + host.label,
        subject: dialog?.name || (preview.phase === 'ok' ? projectLabel(preview.preview.localPath) : 'This session'),
        preview:
            preview.phase === 'loading'
                ? {phase: 'loading', text: 'Reading the session…'}
                : preview.phase === 'error'
                  ? preview
                  : {
                        phase: 'ok',
                        carried: sessionCarriedLines(preview.preview),
                        candidates: preview.preview.candidates,
                        notes: busy ? [{text: busy, className: 'handoff-note handoff-busy'}] : [],
                    },
        ticked,
        editable: preview.phase === 'ok' && view.editable,
        toggle: toggleSessionHandoffFile,
        status: view.status,
        lines: view.lines,
        error: view.error,
        errorNote: view.errorNote,
        done: view.done,
        primary:
            preview.phase === 'error' || !view.primary
                ? null
                : {
                      label: view.primary.label,
                      disabled: preview.phase !== 'ok' || view.primary.disabled,
                      press: () => view.primary && !view.primary.disabled && does(view.primary.does),
                  },
        secondary: {
            label: preview.phase === 'error' ? 'Close' : view.secondary.label,
            press: () => does(preview.phase === 'error' ? 'close' : view.secondary.does),
        },
        close,
    };
    return <HandOffLayout model={model} />;
}

function HandOffLayout({model}: {model: DialogModel}): JSX.Element {
    const body = useRef<HTMLDivElement>(null);
    const {preview} = model;

    // Into the dialog as it opens, so Escape and Enter are its own and not the page's under it.
    useEffect(() => {
        body.current?.focus({preventScroll: true});
    }, []);

    const primary = (): void => {
        if (model.primary) {
            if (!model.primary.disabled) model.primary.press();
        } else if (preview.phase === 'error') model.close();
    };

    // Enter on a focused button is that button's own click.
    const onSubmit = (): void => {
        if (document.activeElement instanceof HTMLButtonElement) return;
        primary();
    };

    return (
        <DialogShell
            overlayClass="new-session-overlay"
            dialogClass="new-session-dialog handoff-dialog"
            onClose={model.close}
            onSubmit={onSubmit}
            submitFromInputs>
            <div ref={body} className="handoff-body" tabIndex={-1} role="dialog" aria-labelledby="handoff-title">
                <h3 id="handoff-title">{model.title}</h3>
                <div className="handoff-project">{model.subject}</div>

                {preview.phase === 'loading' && <div className="handoff-quiet">{preview.text}</div>}

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
                                {preview.carried.map((line) => (
                                    <li key={line.text + (line.code ?? '')}>
                                        {line.text}
                                        {line.code && <code className="handoff-code">{line.code}</code>}
                                    </li>
                                ))}
                            </ul>
                        </div>
                        {preview.candidates.length > 0 && (
                            <div className="settings-field">
                                <div className="settings-label">Ignored files</div>
                                <div className="handoff-files">
                                    {preview.candidates.map((file) => (
                                        <label key={file.path} className="handoff-file">
                                            <input
                                                type="checkbox"
                                                checked={model.ticked.includes(file.path)}
                                                disabled={!model.editable}
                                                onChange={() => model.toggle(file.path)}
                                            />
                                            <span className="handoff-file-path">{file.path}</span>
                                            <span className="handoff-file-size">{fileSize(file.size)}</span>
                                        </label>
                                    ))}
                                </div>
                                <div className="handoff-note">{FILES_NOTE}</div>
                            </div>
                        )}
                        {preview.notes.map((note) => (
                            <div key={note.text} className={note.className}>
                                {note.text}
                            </div>
                        ))}
                    </>
                )}

                {model.status && (
                    <div className="handoff-quiet handoff-waiting" role="status">
                        {model.status}
                    </div>
                )}
                {model.lines.length > 0 && (
                    <pre className="pp-agent-log handoff-log" aria-live="polite">
                        {model.lines.join('\n')}
                    </pre>
                )}
                {model.error && (
                    <div className="handoff-error" role="alert">
                        {model.error}
                        {model.errorNote && <div className="handoff-error-note">{model.errorNote}</div>}
                    </div>
                )}
                {model.done && (
                    <div className="handoff-done" role="status">
                        {model.done}
                    </div>
                )}

                <div className="new-session-actions">
                    <button className="new-session-cancel-btn" onClick={model.secondary.press}>
                        {model.secondary.label}
                    </button>
                    {model.primary && (
                        <button
                            className="new-session-start-btn"
                            disabled={model.primary.disabled}
                            onClick={model.primary.press}>
                            {model.primary.label}
                        </button>
                    )}
                </div>
            </div>
        </DialogShell>
    );
}
