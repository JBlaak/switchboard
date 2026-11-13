/**
 * Settings → Bug manager (#411): the Bugsnag personal auth token, the
 * projects it sees with an opt-in and a local project each, and the trending
 * thresholds.
 *
 * A card of the settings form like Phone access and VMs, but not part of its
 * Save: every control here acts at once, through main. The token goes to main
 * once, to be tried and kept in the Keychain; what comes back is only its last
 * four characters.
 */
import {useEffect, useRef, useState} from 'react';
import type {JSX} from 'react';
import {AppField} from '../settings/SettingsField';
import {BUGSNAG_MCP_HINT, maskedToken, normaliseTrending, TRENDING_LIMITS} from '../../../domain/bugsnag/connection';
import {loadConnection, removeToken, saveToken, setProject, setTrending} from './actions';
import type {BugsnagProjectChange, BugsnagProjectRow, TrendingThresholds} from '../../../domain/bugsnag/connection';
import type {BugsnagConnectionView} from '../../../application/services/bugsnag-connection-service';

export function BugManagerSection(): JSX.Element {
    const [view, setView] = useState<BugsnagConnectionView | null>(null);
    const [loadFailed, setLoadFailed] = useState(false);

    useEffect(() => {
        let live = true;
        loadConnection()
            .then((loaded) => live && setView(loaded))
            .catch(() => live && setLoadFailed(true));
        return () => {
            live = false;
        };
    }, []);

    const changeProject = (row: BugsnagProjectRow, change: BugsnagProjectChange): void => {
        setView(
            (before) =>
                before && {
                    ...before,
                    projects: before.projects.map((p) => (p.id === row.id ? {...p, ...change} : p)),
                },
        );
        void setProject(row.id, change, row.name);
    };

    return (
        <div className="settings-section bug-manager-section" id="sv-bug-manager">
            <div className="settings-section-title">Bug manager</div>
            {view === null ? (
                <AppField
                    label="Bugsnag"
                    description={loadFailed ? "Couldn't read the Bugsnag connection." : 'Checking Bugsnag…'}
                />
            ) : (
                <>
                    <TokenField view={view} onView={setView} />
                    {view.tokenLastFour && view.mcpMissing && (
                        <div className="settings-field">
                            <div className="settings-field-info">
                                <span id="sv-bugsnag-mcp-hint" className="settings-warning">
                                    {BUGSNAG_MCP_HINT}
                                </span>
                            </div>
                        </div>
                    )}
                    {view.projects.length > 0 && <ProjectList view={view} onChange={changeProject} />}
                    {view.tokenLastFour && <TrendingFields initial={view.trending} />}
                </>
            )}
        </div>
    );
}

function TokenField({view, onView}: {view: BugsnagConnectionView; onView: (view: BugsnagConnectionView) => void}) {
    const [editing, setEditing] = useState(view.tokenLastFour === null);
    const [busy, setBusy] = useState(false);
    const input = useRef<HTMLInputElement>(null);

    const save = async (): Promise<void> => {
        const token = input.current?.value.trim() ?? '';
        if (!token || busy) return;
        setBusy(true);
        const next = await saveToken(token).catch(() => null);
        setBusy(false);
        if (!next) return;
        onView(next);
        if (next.status?.ok) {
            if (input.current) input.current.value = '';
            setEditing(false);
        }
    };

    const remove = async (): Promise<void> => {
        setBusy(true);
        const next = await removeToken().catch(() => null);
        setBusy(false);
        if (next) {
            onView(next);
            setEditing(true);
        }
    };

    const status = view.status;
    return (
        <AppField
            wide
            label="Bugsnag token"
            description={
                <>
                    A personal auth token from Bugsnag&apos;s My account settings. It is kept in the Keychain, never in
                    the settings file
                    {status && (
                        <span
                            id="sv-bugsnag-status"
                            className={status.ok ? 'bug-manager-ok' : 'settings-warning'}
                            role={status.ok ? undefined : 'alert'}>
                            {status.line}
                        </span>
                    )}
                </>
            }>
            {editing ? (
                <div className="bug-manager-token">
                    <input
                        type="password"
                        className="settings-input"
                        id="sv-bugsnag-token"
                        ref={input}
                        placeholder="Personal auth token"
                        autoComplete="off"
                        spellCheck={false}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') void save();
                        }}
                    />
                    <button type="button" className="pa-btn" disabled={busy} onClick={() => void save()}>
                        {busy ? 'Checking…' : 'Save token'}
                    </button>
                    {view.tokenLastFour && (
                        <button type="button" className="pa-btn" disabled={busy} onClick={() => setEditing(false)}>
                            Cancel
                        </button>
                    )}
                </div>
            ) : (
                <div className="bug-manager-token">
                    <code className="bug-manager-masked" id="sv-bugsnag-token-masked">
                        {maskedToken(view.tokenLastFour ?? '')}
                    </code>
                    <button type="button" className="pa-btn" disabled={busy} onClick={() => setEditing(true)}>
                        Change
                    </button>
                    <button type="button" className="pa-btn" disabled={busy} onClick={() => void remove()}>
                        Remove
                    </button>
                </div>
            )}
        </AppField>
    );
}

function ProjectList({
    view,
    onChange,
}: {
    view: BugsnagConnectionView;
    onChange: (row: BugsnagProjectRow, change: BugsnagProjectChange) => void;
}): JSX.Element {
    return (
        <div className="settings-field settings-field-wide">
            <div className="settings-field-info">
                <span className="settings-label">Bugsnag projects</span>
                <div className="settings-description">
                    Opt in the projects the Bug manager watches, and link each to the local project its fixes go in. A
                    local project can have several Bugsnag projects
                </div>
                <ul className="bug-manager-projects" aria-label="Bugsnag projects">
                    {view.projects.map((row) => (
                        <li key={row.id} className="bug-manager-project">
                            <label className="settings-toggle">
                                <input
                                    type="checkbox"
                                    aria-label={`Watch ${row.name}`}
                                    checked={row.optedIn}
                                    onChange={(e) => onChange(row, {optedIn: e.currentTarget.checked})}
                                />
                                <span className="settings-toggle-slider"></span>
                            </label>
                            <span className="bug-manager-project-name">
                                {row.name}
                                {row.missing && <span className="bug-manager-missing"> · no longer visible</span>}
                            </span>
                            <select
                                className="settings-select"
                                aria-label={`Local project for ${row.name}`}
                                value={row.localProject ?? ''}
                                onChange={(e) => onChange(row, {localProject: e.currentTarget.value || null})}>
                                <option value="">Not linked</option>
                                {localChoices(view, row).map((choice) => (
                                    <option key={choice.path} value={choice.path} title={choice.path}>
                                        {choice.name}
                                    </option>
                                ))}
                            </select>
                        </li>
                    ))}
                </ul>
            </div>
        </div>
    );
}

/** The local projects to pick from, keeping a linked one that is no longer listed. */
function localChoices(view: BugsnagConnectionView, row: BugsnagProjectRow): {path: string; name: string}[] {
    const choices = view.localProjects;
    if (!row.localProject || choices.some((c) => c.path === row.localProject)) return choices;
    return [...choices, {path: row.localProject, name: row.localProject}];
}

function TrendingFields({initial}: {initial: TrendingThresholds}): JSX.Element {
    const [trending, setLocal] = useState(initial);
    const [draft, setDraft] = useState({multiplier: String(initial.multiplier), minEvents: String(initial.minEvents)});

    const commit = async (): Promise<void> => {
        const wanted = normaliseTrending({multiplier: draft.multiplier, minEvents: draft.minEvents});
        const stored = await setTrending(wanted).catch(() => trending);
        setLocal(stored);
        setDraft({multiplier: String(stored.multiplier), minEvents: String(stored.minEvents)});
    };

    return (
        <AppField
            label="Trending"
            description="A bug trends when its last 24 hours have at least this many times its 7-day daily average, and at least this many events">
            <div className="bug-manager-trending">
                <label>
                    <input
                        type="number"
                        className="settings-input"
                        id="sv-bugsnag-multiplier"
                        min={TRENDING_LIMITS.multiplier.min}
                        step={0.5}
                        value={draft.multiplier}
                        onChange={(e) => setDraft({...draft, multiplier: e.currentTarget.value})}
                        onBlur={() => void commit()}
                    />
                    × average
                </label>
                <label>
                    <input
                        type="number"
                        className="settings-input"
                        id="sv-bugsnag-min-events"
                        min={TRENDING_LIMITS.minEvents.min}
                        step={1}
                        value={draft.minEvents}
                        onChange={(e) => setDraft({...draft, minEvents: e.currentTarget.value})}
                        onBlur={() => void commit()}
                    />
                    events in 24 h
                </label>
            </div>
        </AppField>
    );
}
