/**
 * What Settings → Bug manager does (#411), each at once through main rather
 * than on the form's Save: the token is tried and kept in the Keychain there,
 * and a project's opt-in, link and the thresholds are stored as they change.
 */
import type {BugsnagProjectChange, TrendingThresholds} from '../../../domain/bugsnag/connection';
import type {BugsnagConnectionView} from '../../../application/services/bugsnag-connection-service';

export function loadConnection(): Promise<BugsnagConnectionView> {
    return window.api.bugsnagConnection();
}

export function saveToken(token: string): Promise<BugsnagConnectionView> {
    return window.api.bugsnagSaveToken(token);
}

export function removeToken(): Promise<BugsnagConnectionView> {
    return window.api.bugsnagRemoveToken();
}

export async function setProject(id: string, change: BugsnagProjectChange, name: string): Promise<boolean> {
    const result = await window.api.bugsnagSetProject(id, change, name).catch(() => ({ok: false}));
    return result.ok === true;
}

export function setTrending(trending: TrendingThresholds): Promise<TrendingThresholds> {
    return window.api.bugsnagSetTrending(trending);
}
