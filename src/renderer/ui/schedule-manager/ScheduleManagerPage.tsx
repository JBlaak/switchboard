/**
 * The Schedule manager's page (⌘J): what the main area shows while its
 * route is `scheduleManager`. The overview with no key (`Overview`), one
 * schedule's page with its file's path (`ScheduleView`).
 *
 * Its keys, while it has the focus and never in a field, are `page-keys`;
 * Esc leaves a field, then closes the settings sheet, then goes from a
 * schedule's page to the overview and from the overview back to what it
 * covered.
 *
 * Rendered into `#schedule-manager-page`, which `ui/main-area/install-main-area`
 * shows and hides with the route.
 */
import {useEffect, useLayoutEffect, useRef, type JSX, type KeyboardEvent} from 'react';
import {getState} from '../../state/app-store';
import {useStore} from '../use-store';
import {overviewKeyAction, PAGE_LETTERS, scheduleKeyAction, type ScheduleKeyAction} from './page-keys';
import {Overview} from './Overview';
import {ScheduleView} from './ScheduleView';
import {focusPromptSoon} from './PromptCard';
import {
    carryOn,
    closeScheduleManager,
    closeSettings,
    markSeen,
    openCreateSchedule,
    openScheduleManager,
    runNow,
    stepRun,
    stepSchedule,
    togglePaused,
    toggleRun,
} from './actions';

export function ScheduleManagerPage(): JSX.Element | null {
    const route = useStore((state) => state.mainArea.route);
    if (route.kind !== 'scheduleManager') return null;
    return <PageRoot scheduleKey={route.key} />;
}

function PageRoot({scheduleKey}: {scheduleKey: string | null}): JSX.Element {
    const root = useRef<HTMLDivElement>(null);
    const facts = useStore((state) => state.scheduleManager.facts);
    const selected = useStore((state) => state.scheduleManager.page.selected);
    const now = useStore((state) => state.sessionList.now) || Date.now();

    // Into the page as it opens, and as it moves between the overview and a schedule, so its keys reach it.
    useLayoutEffect(() => {
        root.current?.focus({preventScroll: true});
    }, [scheduleKey]);

    // The chosen schedule stays in view.
    useEffect(() => {
        if (!selected || scheduleKey) return;
        root.current
            ?.querySelector(`[data-schedule-key="${CSS.escape(selected)}"]`)
            ?.scrollIntoView({block: 'nearest'});
    }, [selected, scheduleKey]);

    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        const target = e.target as HTMLElement;
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            if (target.matches('input, textarea, select')) {
                if (!target.closest('[role="dialog"]')) {
                    root.current?.focus({preventScroll: true});
                    return;
                }
            }
            if (getState().scheduleManager.page.settingsDraft) {
                closeSettings();
                root.current?.focus({preventScroll: true});
                return;
            }
            closeScheduleManager();
            return;
        }
        if (target.matches('input, textarea, select, [contenteditable="true"]') || target.closest('[role="dialog"]')) {
            return;
        }
        // A focused button takes its own ⏎.
        if (e.key === 'Enter' && target.closest('button')) return;
        if (e.shiftKey) return;
        const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
        // The page's letters are its own even where nothing is chosen: N is New, never a quick session.
        if (PAGE_LETTERS.has(key)) {
            e.preventDefault();
            e.stopPropagation();
        }
        const action = keyAction(key, scheduleKey);
        if (!action) return;
        e.preventDefault();
        e.stopPropagation();
        carryOut(action, scheduleKey);
    };

    return (
        <div
            ref={root}
            className="sw-page sm-page"
            tabIndex={-1}
            role="region"
            aria-label="Schedule manager"
            onKeyDown={onKeyDown}>
            {!facts ? (
                <p className="sm-empty">Reading the schedules…</p>
            ) : scheduleKey === null ? (
                <Overview facts={facts} now={now} />
            ) : (
                <ScheduleView scheduleKey={scheduleKey} now={now} />
            )}
        </div>
    );
}

function keyAction(key: string, scheduleKey: string | null): ScheduleKeyAction | null {
    const {facts, page} = getState().scheduleManager;
    if (scheduleKey === null) {
        const chosen = facts?.schedules.find((schedule) => schedule.key === page.selected) ?? null;
        return overviewKeyAction(key, chosen);
    }
    const run = page.detail?.runs.find((entry) => entry.id === page.selectedRun) ?? null;
    return scheduleKeyAction(key, scheduleKey, run);
}

function carryOut(action: ScheduleKeyAction, scheduleKey: string | null): void {
    switch (action.kind) {
        case 'step':
            if (scheduleKey === null) stepSchedule(action.step);
            else stepRun(action.step);
            break;
        case 'new':
            openCreateSchedule();
            break;
        case 'open':
            openScheduleManager(action.key);
            break;
        case 'runNow':
            void runNow(action.key);
            break;
        case 'pause':
            void togglePaused(action.key);
            break;
        case 'editPrompt':
            openScheduleManager(action.key);
            focusPromptSoon();
            break;
        case 'seen':
            void markSeen(action.run.id);
            break;
        case 'toggleRun':
            toggleRun(action.run.id);
            break;
        case 'carryOn':
            void carryOn(action.run);
            break;
    }
}
