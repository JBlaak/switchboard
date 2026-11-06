/**
 * Settings → Saved prompts (#344): what the editor holds and what each change
 * does to the stored lists, without a window.
 *
 * The prompts live in two kinds of list (`domain/settings/saved-prompts`): the
 * global one, and one per project. The editor shows them together, with the
 * ⌘ key each gets in a session's tray: global first, then the project's. A
 * change answers the lists after it and which lists to write: a move between
 * scopes writes both.
 */
import {resolveSavedPrompts} from '../../../domain/settings/saved-prompts';
import type {SavedPrompt, SavedPromptMode} from '../../../domain/settings/saved-prompts';

/** Where a prompt is kept: null for everywhere (the global list), else a project's path. */
export type PromptScope = string | null;

/** Every stored list the editor knows. */
export interface PromptLists {
    readonly global: readonly SavedPrompt[];
    /** Only projects with prompts; an emptied list is dropped. */
    readonly projects: Readonly<Record<string, readonly SavedPrompt[]>>;
}

/** One list to store: the global one (null) or a project's, in full. */
export interface ListWrite {
    readonly projectPath: string | null;
    readonly prompts: readonly SavedPrompt[];
}

/** What a change leaves: the lists after it, and the lists to write. */
export interface PromptChange {
    readonly lists: PromptLists;
    readonly writes: readonly ListWrite[];
}

/** The form: a prompt being edited (`id`) or a new one (null). */
export interface PromptDraft {
    readonly id: string | null;
    readonly label: string;
    readonly text: string;
    readonly mode: SavedPromptMode;
    readonly scope: PromptScope;
}

/** Which prompts the list shows: all, the global ones (null), or one project's. */
export type PromptFilter = 'all' | PromptScope;

/** One row of the list. */
export interface PromptRow {
    readonly prompt: SavedPrompt;
    readonly scope: PromptScope;
    /** ⌘1–9 in a session's tray, null past nine. */
    readonly key: number | null;
    /** Where it sits in its own list, for Move up / Move down. */
    readonly index: number;
    readonly count: number;
}

export const NO_PROMPTS: PromptLists = {global: [], projects: {}};

/** The lists as read: the global one, and each project's that has any. */
export function promptListsFrom(
    global: readonly SavedPrompt[],
    projects: readonly {projectPath: string; prompts: readonly SavedPrompt[]}[],
): PromptLists {
    const byProject: Record<string, readonly SavedPrompt[]> = {};
    for (const {projectPath, prompts} of projects) if (prompts.length > 0) byProject[projectPath] = prompts;
    return {global, projects: byProject};
}

/** The list a scope keeps. */
export function listIn(lists: PromptLists, scope: PromptScope): readonly SavedPrompt[] {
    return scope === null ? lists.global : (lists.projects[scope] ?? []);
}

/** The projects that have prompts, by path. */
export function projectsWithPrompts(lists: PromptLists): string[] {
    return Object.keys(lists.projects).sort();
}

/**
 * The rows a filter shows, each with its tray key. A global prompt's key is
 * the same in every session; a project's counts on from the global ones.
 */
export function promptRows(lists: PromptLists, filter: PromptFilter): PromptRow[] {
    const scopes: PromptScope[] = filter === 'all' ? [null, ...projectsWithPrompts(lists)] : [filter];
    const rows: PromptRow[] = [];
    for (const scope of scopes) {
        const own = listIn(lists, scope);
        const resolved = resolveSavedPrompts(lists.global, scope === null ? [] : own);
        const offset = scope === null ? 0 : lists.global.length;
        own.forEach((prompt, index) => {
            rows.push({prompt, scope, key: resolved[offset + index]!.key, index, count: own.length});
        });
    }
    return rows;
}

/** Where a prompt is kept, and at which place. */
export function findPrompt(
    lists: PromptLists,
    id: string,
): {prompt: SavedPrompt; scope: PromptScope; index: number} | null {
    for (const scope of [null, ...projectsWithPrompts(lists)] as PromptScope[]) {
        const index = listIn(lists, scope).findIndex((prompt) => prompt.id === id);
        if (index >= 0) return {prompt: listIn(lists, scope)[index]!, scope, index};
    }
    return null;
}

/** The filter after a change: a project left without prompts shows all again. */
export function filterAfter(lists: PromptLists, filter: PromptFilter): PromptFilter {
    if (filter === 'all' || filter === null) return filter;
    return lists.projects[filter] ? filter : 'all';
}

/** A blank form for a new prompt, kept where the list is filtered to (everywhere when it shows all). */
export function newDraft(filter: PromptFilter): PromptDraft {
    return {id: null, label: '', text: '', mode: 'send', scope: filter === 'all' ? null : filter};
}

/** The form for a stored prompt, or null when it is gone. */
export function draftFor(lists: PromptLists, id: string): PromptDraft | null {
    const found = findPrompt(lists, id);
    if (!found) return null;
    const {prompt, scope} = found;
    return {id: prompt.id, label: prompt.label, text: prompt.text, mode: prompt.mode, scope};
}

/** Whether the form can be saved: there is something to type. */
export function canSave(draft: PromptDraft): boolean {
    return draft.text.trim() !== '';
}

/**
 * Store the form: a new prompt goes last in its scope's list, as `newId`; an
 * edited one stays where it was, or, moved to another scope, leaves its old
 * list and goes last in the new one. A blank label is the text's first line.
 * Null when there is nothing to save.
 */
export function savePrompt(lists: PromptLists, draft: PromptDraft, newId: string): PromptChange | null {
    if (!canSave(draft)) return null;
    const label = draft.label.trim() || draft.text.trim().split('\n')[0]!.trim();
    const existing = draft.id === null ? null : findPrompt(lists, draft.id);
    const prompt: SavedPrompt = {id: existing?.prompt.id ?? newId, label, text: draft.text, mode: draft.mode};

    if (existing && existing.scope === draft.scope) {
        const list = [...listIn(lists, draft.scope)];
        list[existing.index] = prompt;
        return withLists(lists, [{projectPath: draft.scope, prompts: list}]);
    }
    const writes: ListWrite[] = [];
    if (existing) {
        writes.push({
            projectPath: existing.scope,
            prompts: listIn(lists, existing.scope).filter((other) => other.id !== prompt.id),
        });
    }
    writes.push({projectPath: draft.scope, prompts: [...listIn(lists, draft.scope), prompt]});
    return withLists(lists, writes);
}

/** Take a prompt out of its list. Null when it is not there. */
export function deletePrompt(lists: PromptLists, id: string): PromptChange | null {
    const found = findPrompt(lists, id);
    if (!found) return null;
    const prompts = listIn(lists, found.scope).filter((prompt) => prompt.id !== id);
    return withLists(lists, [{projectPath: found.scope, prompts}]);
}

/**
 * Move a prompt one place up (-1) or down (+1) in its own list, which moves
 * its ⌘ key with it. Null at either end.
 */
export function movePrompt(lists: PromptLists, id: string, by: -1 | 1): PromptChange | null {
    const found = findPrompt(lists, id);
    if (!found) return null;
    const list = [...listIn(lists, found.scope)];
    const to = found.index + by;
    if (to < 0 || to >= list.length) return null;
    [list[found.index], list[to]] = [list[to]!, list[found.index]!];
    return withLists(lists, [{projectPath: found.scope, prompts: list}]);
}

function withLists(lists: PromptLists, writes: readonly ListWrite[]): PromptChange {
    let global = lists.global;
    const projects: Record<string, readonly SavedPrompt[]> = {...lists.projects};
    for (const {projectPath, prompts} of writes) {
        if (projectPath === null) global = prompts;
        else if (prompts.length > 0) projects[projectPath] = prompts;
        else delete projects[projectPath];
    }
    return {lists: {global, projects}, writes};
}
