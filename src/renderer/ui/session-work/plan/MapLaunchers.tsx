/**
 * A wayfinder map's launchers above its diagram, in place of Start level:
 * Next ticket (`/wayfinder <map>`, which takes the first ticket on the
 * frontier) and Reconcile (`/reconciling-the-map`). Each starts one session on the map; a refusal
 * shows beside them until the next press.
 */
import {useState} from 'react';
import type {JSX} from 'react';
import type {Plan} from '../../../../domain/plan/model';
import {MAP_LAUNCHERS, mapLauncherPrompt, type MapLauncher} from '../../../../domain/plan/start';
import type {IssueActions} from './types';

const LABEL: Readonly<Record<MapLauncher, string>> = {
    next: 'Next ticket',
    reconcile: 'Reconcile',
};

type Pressed = {launcher: MapLauncher; phase: 'starting'} | {launcher: MapLauncher; phase: 'failed'; reason: string};

export function MapLaunchers({plan, issueActions}: {plan: Plan; issueActions?: IssueActions}): JSX.Element | null {
    const [pressed, setPressed] = useState<Pressed | null>(null);
    const start = issueActions?.startMapLauncher;
    if (!start) return null;

    const press = async (launcher: MapLauncher) => {
        if (pressed?.phase === 'starting') return;
        setPressed({launcher, phase: 'starting'});
        const result = await start(plan, launcher);
        setPressed(result.ok ? null : {launcher, phase: 'failed', reason: result.reason});
    };

    return (
        <div className="pv-map-launchers" role="group" aria-label="Wayfinder map">
            {MAP_LAUNCHERS.map((launcher, index) => (
                <button
                    key={launcher}
                    type="button"
                    className={'sw-btn' + (index === 0 ? ' is-primary' : '')}
                    title={mapLauncherPrompt(launcher, plan)}
                    aria-disabled={pressed?.phase === 'starting'}
                    onClick={() => void press(launcher)}>
                    {pressed?.phase === 'starting' && pressed.launcher === launcher ? 'Starting…' : LABEL[launcher]}
                </button>
            ))}
            {pressed?.phase === 'failed' && (
                <span className="pv-inline is-error" role="alert">
                    {pressed.reason}
                </span>
            )}
        </div>
    );
}
