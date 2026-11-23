/**
 * A schedule's settings: when, where and how it runs, at a glance, and Edit
 * to change them in a sheet over the page, with the create form's own form
 * (`ScheduleForm`, without the prompt, which has its own card). Esc or
 * Cancel closes the sheet without saving.
 */
import {useEffect, useRef, type JSX} from 'react';
import {useStore} from '../use-store';
import {describeCron} from '../../../domain/schedule/cadence';
import {runsOnText} from '../../../domain/schedule/page-view';
import type {ScheduleDetail, ScheduleSettings} from '../../../domain/schedule/manager';
import {ScheduleForm} from './ScheduleForm';
import {closeSettings, editSettings, openSettings, saveSettings} from './actions';

function limitsText(settings: ScheduleSettings): string {
    const parts = [
        settings.limitMinutes === null ? 'No time limit' : `Stop after ${settings.limitMinutes} min`,
        settings.weekCap === null ? null : `don't start if the week is past ${settings.weekCap}%`,
    ];
    return parts.filter(Boolean).join(' · ');
}

export function SettingsCard({detail}: {detail: ScheduleDetail}): JSX.Element {
    const draft = useStore((state) => state.scheduleManager.page.settingsDraft);
    const wakeAt = useStore((state) => state.scheduleManager.facts?.wakeAt ?? null);
    const {settings, runsOn} = detail.summary;
    const rows: [string, string][] = [
        ['When', describeCron(settings.cron)],
        ['If the Mac slept', settings.missed === 'run-once' ? 'Run once when it wakes' : 'Skip it'],
        ['Runs on', runsOnText(runsOn) + (runsOn.kind === 'mac' && wakeAt ? ` · wakes it at ${wakeAt}` : '')],
        ['Works in', settings.worktree ? 'A fresh worktree off the default branch' : 'The checkout'],
        ['Model', settings.model ?? 'The CLI’s default'],
        ['Limits', limitsText(settings)],
        ['Permissions', [settings.permissionMode, settings.allowedTools].filter(Boolean).join(' · ')],
    ];
    return (
        <section className="sm-card sm-settings" aria-label="Where and how">
            <div className="sm-card-head">
                <h2 className="sm-label">Where and how</h2>
                <button type="button" className="sm-link" onClick={openSettings}>
                    Edit
                </button>
            </div>
            <dl className="sm-settings-rows">
                {rows.map(([name, value]) => (
                    <div key={name}>
                        <dt>{name}</dt>
                        <dd>{value}</dd>
                    </div>
                ))}
            </dl>
            {draft && <SettingsSheet draft={draft} />}
        </section>
    );
}

function SettingsSheet({draft}: {draft: ScheduleSettings}): JSX.Element {
    const sheet = useRef<HTMLDivElement>(null);
    const busy = useStore((state) => state.scheduleManager.page.busy !== null);

    useEffect(() => {
        sheet.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
    }, []);

    return (
        <div className="sm-sheet-scrim">
            <div
                ref={sheet}
                className="sm-sheet"
                role="dialog"
                aria-modal="true"
                aria-label="Edit the schedule's settings">
                <h2 className="sm-sheet-title">{draft.name}</h2>
                <ScheduleForm value={draft} onChange={editSettings} withPrompt={false} />
                <div className="sm-sheet-actions">
                    <button type="button" className="sw-btn" onClick={closeSettings}>
                        Cancel <kbd className="sw-kbd">esc</kbd>
                    </button>
                    <button
                        type="button"
                        className="sw-btn is-primary"
                        disabled={busy}
                        onClick={() => void saveSettings()}>
                        Save
                    </button>
                </div>
            </div>
        </div>
    );
}
