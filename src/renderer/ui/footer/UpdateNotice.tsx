/**
 * The "new version" line at the top of the footer.
 *
 * Quiet on purpose: one line of footer text with an Install button, no badge,
 * no dialog. It appears when main finds a newer release, and the × hides it
 * until a later version turns up. Installing quits the app, which stops every
 * running session, so that is asked first (see `installUpdate`).
 *
 * Once Install is clicked the line follows the install: the download's
 * percentage, then unpacking, checking and restarting, with a thin bar under
 * it. A failure names the step and offers Retry; the tooltip says why. After
 * the restart the same place says whether the new version arrived.
 *
 * When the app cannot replace itself (a dev build, or a copy in a folder it
 * cannot write to), the button opens the release page instead.
 */
import {visibleUpdate} from '../../state/update-slice';
import {useStore} from '../use-store';
import {dismissUpdate, dismissUpdateOutcome, installUpdate, openReleasePage} from './actions';
import {updateNoticeView, updateOutcomeView} from './footer-view';
import type {JSX} from 'react';

function DismissButton({onClick}: {onClick: () => void}): JSX.Element {
    return (
        <button id="update-notice-dismiss" type="button" title="Dismiss" aria-label="Dismiss" onClick={onClick}>
            &times;
        </button>
    );
}

function ProgressBar({bar, label}: {bar: number | 'indeterminate'; label: string}): JSX.Element {
    const indeterminate = bar === 'indeterminate';
    const percent = indeterminate ? undefined : Math.round(bar * 100);
    return (
        <div
            id="update-notice-bar"
            role="progressbar"
            aria-label="Update progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-valuetext={label}
            className={indeterminate ? 'indeterminate' : undefined}>
            <div id="update-notice-bar-fill" style={indeterminate ? undefined : {width: `${percent}%`}} />
        </div>
    );
}

export function UpdateNotice(): JSX.Element | null {
    const notice = useStore((state) => visibleUpdate(state.update));
    const installing = useStore((state) => state.update.installing);
    const progress = useStore((state) => state.update.progress);
    const failure = useStore((state) => state.update.failure);
    const outcome = useStore((state) => state.update.outcome);

    if (!notice) {
        if (!outcome) return null;
        const shown = updateOutcomeView(outcome);
        return (
            <div id="update-notice" className={outcome.kind}>
                <span id="update-notice-label" role="status" title={shown.detail ?? undefined}>
                    {shown.label}
                </span>
                <DismissButton onClick={dismissUpdateOutcome} />
            </div>
        );
    }

    const shown = updateNoticeView(notice, {installing, progress, failure});
    return (
        <div id="update-notice" className={failure && !installing ? 'failed' : undefined}>
            <span id="update-notice-label" title={shown.detail ?? undefined}>
                {shown.label}
            </span>
            {shown.action && (
                <button
                    id="update-notice-action"
                    type="button"
                    title={shown.actionTitle}
                    onClick={notice.installable ? () => void installUpdate() : openReleasePage}>
                    {shown.action}
                </button>
            )}
            {shown.dismissible && <DismissButton onClick={() => dismissUpdate(notice.version)} />}
            {shown.bar !== null && <ProgressBar bar={shown.bar} label={shown.label} />}
        </div>
    );
}
