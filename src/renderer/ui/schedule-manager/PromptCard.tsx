/**
 * A schedule's prompt card: the prompt to edit, its version and how many
 * runs it has had ("v3 · edited Thu · 3 runs since"), the history to load an
 * old version back into the editor from, an optional note on what changed,
 * and Save as vN+1 or Save and run now. Saving a changed prompt makes a new
 * version; Switchboard keeps them all.
 */
import {useEffect, useRef, type JSX} from 'react';
import {useStore} from '../use-store';
import {promptLine} from '../../../domain/schedule/run-list';
import {scheduleFile} from '../../../domain/schedule/page';
import {shortDate} from '../../../domain/schedule/times';
import type {ScheduleDetail} from '../../../domain/schedule/manager';
import {promptEdited, promptShown} from '../../state/schedule-manager-slice';
import {loadPromptVersion, resetPrompt, savePrompt, typePrompt, typePromptNote} from './actions';

const PROMPT_ID = 'schedule-prompt';

/** E asked for the prompt before the card was there: it takes the focus as it comes. */
let focusOnMount = false;

/** E: into the prompt, now or once the schedule's page has it. */
export function focusPromptSoon(): void {
    const field = document.getElementById(PROMPT_ID);
    if (field) field.focus();
    else focusOnMount = true;
}

export function PromptCard({
    scheduleKey,
    detail,
    now,
}: {
    scheduleKey: string;
    detail: ScheduleDetail;
    now: number;
}): JSX.Element {
    const field = useRef<HTMLTextAreaElement>(null);
    const page = useStore((state) => state.scheduleManager.page);
    const {summary} = detail;
    const edited = promptEdited(page);
    const busy = page.busy !== null;
    const file = scheduleFile(scheduleKey, summary.settings.projectPath);

    useEffect(() => {
        if (!focusOnMount) return;
        focusOnMount = false;
        field.current?.focus();
    }, []);

    return (
        <section className="sm-card sm-prompt">
            <div className="sm-card-head">
                <label htmlFor={PROMPT_ID} className="sm-label">
                    Prompt
                </label>
                <span>{promptLine(detail.runs, detail.versions, summary.promptVersion, now)}</span>
                {detail.versions.length > 1 && (
                    <select
                        className="sm-history"
                        aria-label="Load an earlier version into the editor"
                        value=""
                        onChange={(e) => {
                            if (e.target.value) loadPromptVersion(Number(e.target.value));
                        }}>
                        <option value="">History</option>
                        {detail.versions.map((version) => (
                            <option key={version.version} value={version.version}>
                                v{version.version} · {shortDate(version.savedAt)}
                                {version.note ? ` · ${version.note}` : ''}
                            </option>
                        ))}
                    </select>
                )}
            </div>
            <textarea
                ref={field}
                id={PROMPT_ID}
                className="sm-prompt-text"
                rows={12}
                spellCheck={false}
                value={promptShown(page)}
                onChange={(e) => typePrompt(e.target.value)}
            />
            {edited && (
                <input
                    type="text"
                    className="sm-prompt-note"
                    aria-label="What changed (optional)"
                    placeholder="What changed (optional)"
                    value={page.promptNote}
                    onChange={(e) => typePromptNote(e.target.value)}
                />
            )}
            <div className="sm-prompt-actions">
                <button
                    type="button"
                    className="sw-btn is-primary"
                    disabled={!edited || busy}
                    onClick={() => void savePrompt(false)}>
                    Save as v{summary.promptVersion + 1}
                </button>
                <button
                    type="button"
                    className="sw-btn"
                    disabled={!edited || busy}
                    onClick={() => void savePrompt(true)}>
                    Save and run now
                </button>
                {edited && (
                    <button type="button" className="sm-link" onClick={resetPrompt}>
                        Undo changes
                    </button>
                )}
            </div>
            <p className="sm-hint">
                Saved to <code>{file.path}</code>, so it also works as <code>{file.command}</code>. Switchboard keeps
                every version.
            </p>
        </section>
    );
}
