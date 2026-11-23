/**
 * The Schedule manager: its facts and a schedule's page, saving a schedule's
 * file, turning one on or off, running and skipping, marking runs seen,
 * drafting with Claude, and the Mac's wake. Its changes are pushed by the
 * service itself (`scheduleManagerChanged`).
 */
import {INVOKE} from '../../ipc/channels';
import type {Container} from '../composition-root';
import type {IpcRegistrar} from './support/registrar';
import type {MissedPolicy, ScheduleSettings} from '../../domain/schedule/manager';

export function registerScheduleManagerHandlers(ipc: IpcRegistrar, app: Container): void {
    ipc.handle(INVOKE.scheduleManagerFacts, () => app.scheduleManager.facts());
    ipc.handle(INVOKE.scheduleManagerDetail, (key: unknown) => app.scheduleManager.detail(asText(key, 'key')));
    ipc.handle(INVOKE.scheduleManagerSave, (key: unknown, settings: unknown, note: unknown, runNow: unknown) =>
        app.scheduleManager.save(
            key === null ? null : asText(key, 'key'),
            asSettings(settings),
            typeof note === 'string' ? note : null,
            runNow === true,
        ),
    );
    ipc.handle(INVOKE.scheduleManagerSetEnabled, (key: unknown, enabled: unknown) =>
        app.scheduleManager.setEnabled(asText(key, 'key'), enabled === true),
    );
    ipc.handle(INVOKE.scheduleManagerRunNow, (key: unknown) => app.scheduleManager.runNow(asText(key, 'key')));
    ipc.handle(INVOKE.scheduleManagerSkipNext, (key: unknown) => app.scheduleManager.skipNext(asText(key, 'key')));
    ipc.handle(INVOKE.scheduleManagerMarkSeen, (runId: unknown) => app.scheduleManager.markSeen(asText(runId, 'run')));
    ipc.handle(INVOKE.scheduleManagerMarkAllSeen, () => app.scheduleManager.markAllSeen());
    ipc.handle(INVOKE.scheduleManagerDraft, (sentence: unknown, projectPath: unknown) =>
        app.scheduleManager.draft(
            typeof sentence === 'string' ? sentence : '',
            typeof projectPath === 'string' && projectPath ? projectPath : null,
        ),
    );
    ipc.handle(INVOKE.scheduleManagerDraftFromSession, (sessionId: unknown) =>
        app.scheduleManager.draftFromSession(asText(sessionId, 'session')),
    );
    ipc.handle(INVOKE.scheduleManagerSetWake, (at: unknown) =>
        app.scheduleManager.setWake(at === null ? null : asText(at, 'time')),
    );
}

function asText(value: unknown, what: string): string {
    if (typeof value !== 'string' || !value) throw new Error(`a ${what} is a non-empty string`);
    return value;
}

const MISSED: readonly MissedPolicy[] = ['run-once', 'skip'];

/** The settings as the renderer sent them, each field checked for its type; the service checks their sense. */
export function asSettings(value: unknown): ScheduleSettings {
    if (typeof value !== 'object' || value === null) throw new Error('settings are an object');
    const v = value as Record<string, unknown>;
    const text = (key: string): string => {
        if (typeof v[key] !== 'string') throw new Error(`settings.${key} is a string`);
        return v[key];
    };
    const flag = (key: string): boolean => {
        if (typeof v[key] !== 'boolean') throw new Error(`settings.${key} is true or false`);
        return v[key];
    };
    const count = (key: string): number | null => {
        if (v[key] === null) return null;
        if (typeof v[key] !== 'number' || !Number.isFinite(v[key]))
            throw new Error(`settings.${key} is a number or null`);
        return v[key];
    };
    const missed = v.missed;
    if (!MISSED.includes(missed as MissedPolicy)) throw new Error('settings.missed is run-once or skip');
    return {
        name: text('name'),
        slug: text('slug'),
        projectPath: text('projectPath'),
        cron: text('cron'),
        enabled: flag('enabled'),
        prompt: text('prompt'),
        model: v.model === null ? null : text('model'),
        permissionMode: text('permissionMode'),
        allowedTools: text('allowedTools'),
        limitMinutes: count('limitMinutes'),
        weekCap: count('weekCap'),
        missed: missed as MissedPolicy,
        worktree: flag('worktree'),
    };
}
