/**
 * What project hand-off does on the project page (#276 stage 2): asking for
 * the hosts, a project's copies and a copy's local project, the Hand off
 * dialog's preview and run (with, stage 5, its schedules choice), Bring
 * back, and Remove copy. The components call
 * these, never `window.api` or the store.
 *
 * A failed call is answered by main as `{ ok: false, error }` in place of
 * what was asked, so each answer is checked for its shape before it is kept.
 */
import {dispatch, getState} from '../../state/app-store';
import {removeDecision} from '../../state/handoff-slice';
import {openDialog} from '../dialogs/actions';
import {closeProject, openProjectPage} from './actions';
import {removeConfirm} from './handoff-view';
import {loadSchedules} from './schedules-actions';
import type {
    BringBackResult,
    CopyStatus,
    HandoffChoices,
    HandoffHost,
    HandoffPreview,
    HandoffResult,
    ProjectCopy,
} from '../../../application/services/project-handoff';

/** The VM hosts there are; none when main can't say. */
export async function loadHandoffHosts(): Promise<void> {
    const hosts: unknown = await window.api.handoffHosts().catch(() => []);
    dispatch({type: 'handoffHostsLoaded', hosts: Array.isArray(hosts) ? hosts.filter(isHost) : []});
}

/** A local project's copies, for its On VMs section. */
export async function loadProjectCopies(localPath: string): Promise<void> {
    const copies: unknown = await window.api.projectCopies(localPath).catch(() => []);
    dispatch({type: 'handoffCopiesLoaded', localPath, copies: Array.isArray(copies) ? copies.filter(isCopy) : []});
}

/** The local project a remote one was copied from, for its header. */
export async function loadCopyOrigin(copyPath: string): Promise<void> {
    const origin: unknown = await window.api.copyOrigin(copyPath).catch(() => null);
    dispatch({type: 'handoffOriginLoaded', copyPath, origin: typeof origin === 'string' ? origin : null});
}

/** Hand off to… with a host picked: the dialog opens, and asks what would go over. */
export async function openHandOffDialog(localPath: string, host: HandoffHost): Promise<void> {
    dispatch({type: 'handoffDialogOpened', localPath, host});
    openDialog({kind: 'handOff', localPath, host});
    // Whether the project has schedules, for the dialog's "Run this project's schedules on the VM".
    const schedules = loadSchedules(localPath);
    const answer: unknown = await window.api.previewHandoff(localPath).catch((err: Error) => ({error: err.message}));
    dispatch({type: 'handoffPreviewLoaded', localPath, answer: previewAnswer(answer)});
    await schedules;
}

/** The dialog's "Run this project's schedules on the VM". */
export function toggleHandoffSchedules(): void {
    dispatch({type: 'handoffSchedulesToggled'});
}

export function toggleHandoffFile(path: string): void {
    dispatch({type: 'handoffFileToggled', path});
}

export function closeHandOffDialog(close: () => void): void {
    dispatch({type: 'handoffDialogClosed'});
    close();
}

/**
 * Hand off (or Retry): carry the ticked files along. Progress lines arrive
 * as main pushes them; on success the copy is a project, and the page's On
 * VMs section is asked again.
 */
export async function runHandOff(
    localPath: string,
    hostKey: string,
    ticked: readonly string[],
    choices: HandoffChoices = {},
): Promise<void> {
    dispatch({type: 'handoffStarted', localPath, hostKey});
    const result: unknown = await window.api
        .handOffProject(localPath, hostKey, [...ticked], choices)
        .catch((err: Error) => ({ok: false, error: err.message}));
    dispatch({type: 'handoffFinished', localPath, result: handoffResult(result)});
    if (!isOk(result)) return;
    void loadProjectCopies(localPath);
    // The schedules may have moved to the copy.
    if (choices.schedulesOnVm !== undefined) void loadSchedules(localPath);
}

/** Open the copy: its project page, in place of the local one. */
export function openCopy(copyPath: string, close?: () => void): void {
    close?.();
    openProjectPage(copyPath);
}

/** Bring back: the copy's branch, checked out in a new worktree of the local project. */
export async function bringBack(copyPath: string): Promise<void> {
    dispatch({type: 'bringBackStarted', copyPath});
    const result: unknown = await window.api
        .bringBackCopy(copyPath)
        .catch((err: Error) => ({ok: false, error: err.message}));
    dispatch({type: 'bringBackFinished', copyPath, result: bringBackResult(result)});
}

/**
 * Remove copy: ask where the copy stands first. With work only the copy has,
 * the page lists it and offers Bring back first or Remove anyway; a clean copy
 * is confirmed natively; a VM that can't be reached removes nothing.
 */
export async function removeCopy(copyPath: string): Promise<void> {
    dispatch({type: 'copyRemoveChecking', copyPath});
    const status: unknown = await window.api.copyStatus(copyPath).catch(() => null);
    const answer = isStatus(status) ? status : null;
    dispatch({type: 'copyRemoveChecked', copyPath, status: answer});
    if (removeDecision(answer) !== 'clean') return;
    if (!confirm(removeConfirm(copyPath))) {
        dispatch({type: 'copyRemoveCancelled', copyPath});
        return;
    }
    await removeCopyNow(copyPath);
}

/** Remove anyway, after the list of work the copy has. */
export async function removeCopyAnyway(copyPath: string): Promise<void> {
    await removeCopyNow(copyPath);
}

export function cancelRemoveCopy(copyPath: string): void {
    dispatch({type: 'copyRemoveCancelled', copyPath});
}

/** Bring back first, from the list of work: the removal waits for another press. */
export async function bringBackFirst(copyPath: string): Promise<void> {
    dispatch({type: 'copyRemoveCancelled', copyPath});
    await bringBack(copyPath);
}

async function removeCopyNow(copyPath: string): Promise<void> {
    const origin = getState().handoff.origins[copyPath] ?? null;
    dispatch({type: 'copyRemoving', copyPath});
    const result: unknown = await window.api
        .removeCopy(copyPath)
        .catch((err: Error) => ({ok: false, error: err.message}));
    const ok = isOk(result);
    dispatch({
        type: 'copyRemoveFinished',
        copyPath,
        result: ok ? {ok: true} : {ok: false, error: errorOf(result) || 'The copy couldn’t be removed'},
    });
    if (!ok) return;
    // The copy is gone; its page gives way to the local project's, when that is known.
    const route = getState().mainArea.route;
    if (route.kind !== 'project' || route.projectPath !== copyPath) return;
    if (origin) openProjectPage(origin);
    else closeProject();
}

// ── Shapes ──

function isOk(value: unknown): boolean {
    return !!value && typeof value === 'object' && (value as {ok?: unknown}).ok === true;
}

function errorOf(value: unknown): string {
    const error = value && typeof value === 'object' ? (value as {error?: unknown}).error : undefined;
    return typeof error === 'string' ? error : '';
}

function isHost(value: unknown): value is HandoffHost {
    if (!value || typeof value !== 'object') return false;
    const host = value as Record<string, unknown>;
    return typeof host.key === 'string' && typeof host.label === 'string';
}

function isCopy(value: unknown): value is ProjectCopy {
    if (!value || typeof value !== 'object') return false;
    const copy = value as Record<string, unknown>;
    return typeof copy.copyPath === 'string' && typeof copy.hostKey === 'string' && typeof copy.hostLabel === 'string';
}

function isStatus(value: unknown): value is CopyStatus {
    if (!value || typeof value !== 'object') return false;
    const status = value as Record<string, unknown>;
    return (
        (status.branch === null || typeof status.branch === 'string') &&
        Array.isArray(status.unpushed) &&
        Array.isArray(status.uncommitted)
    );
}

function previewAnswer(value: unknown): HandoffPreview | {error: string} {
    if (!value || typeof value !== 'object') return {error: 'Couldn’t read the project'};
    const preview = value as Record<string, unknown>;
    if (typeof preview.error === 'string') return {error: preview.error};
    if (
        typeof preview.branch === 'string' &&
        typeof preview.unpushed === 'number' &&
        typeof preview.uncommitted === 'number' &&
        Array.isArray(preview.candidates) &&
        !!preview.existing &&
        typeof preview.existing === 'object'
    ) {
        return value as HandoffPreview;
    }
    return {error: 'Couldn’t read the project'};
}

function handoffResult(value: unknown): HandoffResult {
    if (isOk(value)) {
        const result = value as {copyPath?: unknown; reused?: unknown};
        if (typeof result.copyPath === 'string') {
            return {ok: true, copyPath: result.copyPath, reused: result.reused === true};
        }
    }
    return {ok: false, error: errorOf(value)};
}

function bringBackResult(value: unknown): BringBackResult {
    if (isOk(value)) {
        const result = value as {worktree?: unknown; branch?: unknown};
        if (typeof result.worktree === 'string' && typeof result.branch === 'string') {
            return {ok: true, worktree: result.worktree, branch: result.branch};
        }
    }
    return {ok: false, error: errorOf(value)};
}
