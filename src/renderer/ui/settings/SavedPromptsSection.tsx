/**
 * Settings → Saved prompts (#344): the prompts a session's tray offers under
 * Ask, with their ⌘ keys, scope and send mode; add, edit, reorder and delete.
 *
 * A card of the settings form like the others, but not part of its Save:
 * every change is stored at once (`saved-prompts-actions`), so the tray shows
 * it the next time it opens. What a change does to the lists is
 * `saved-prompts-editor`.
 */
import {useEffect, useLayoutEffect, useRef, useState} from 'react';
import type {JSX, KeyboardEvent} from 'react';
import {SAVED_PROMPT_PLACEHOLDERS} from '../../../domain/settings/saved-prompts';
import type {SavedPromptMode} from '../../../domain/settings/saved-prompts';
import {view} from '../../state/session-store';
import {isWorktreeProject, projectLabel} from '../../features/sessions/project-label';
import {loadPromptLists, SAVED_PROMPTS_SECTION_ID, writePromptLists} from './saved-prompts-actions';
import {
    canSave,
    deletePrompt,
    draftFor,
    filterAfter,
    movePrompt,
    newDraft,
    projectsWithPrompts,
    promptRows,
    savePrompt,
} from './saved-prompts-editor';
import type {
    PromptChange,
    PromptDraft,
    PromptFilter,
    PromptLists,
    PromptRow,
    PromptScope,
} from './saved-prompts-editor';

const MODES: readonly {value: SavedPromptMode; label: string}[] = [
    {value: 'send', label: 'Send'},
    {value: 'input', label: 'Put in input'},
];

function scopeLabel(scope: PromptScope): string {
    return scope === null ? 'Everywhere' : projectLabel(scope);
}

/** The projects a prompt can be kept for: those in the sidebar (not their worktrees), and any that have prompts. */
function scopeProjects(lists: PromptLists | null, extra: PromptScope): string[] {
    const paths = new Set<string>();
    for (const project of [...view.cachedProjects, ...view.cachedAllProjects]) {
        if (!isWorktreeProject(project.projectPath)) paths.add(project.projectPath);
    }
    if (lists) for (const path of projectsWithPrompts(lists)) paths.add(path);
    if (extra !== null) paths.add(extra);
    return [...paths].sort((a, b) => projectLabel(a).localeCompare(projectLabel(b)));
}

export function SavedPromptsSection(): JSX.Element {
    const [lists, setLists] = useState<PromptLists | null>(null);
    const [filter, setFilter] = useState<PromptFilter>('all');
    const [draft, setDraft] = useState<PromptDraft | null>(null);
    /** A Move button to give focus back to once its row has moved. */
    const [refocus, setRefocus] = useState<{id: string; by: -1 | 1} | null>(null);
    const root = useRef<HTMLDivElement>(null);

    useEffect(() => {
        let live = true;
        void loadPromptLists(scopeProjects(null, null)).then((loaded) => {
            if (live) setLists(loaded);
        });
        return () => {
            live = false;
        };
    }, []);

    useLayoutEffect(() => {
        if (!refocus) return;
        const row = root.current?.querySelector(`[data-prompt-id="${CSS.escape(refocus.id)}"]`);
        const wanted = row?.querySelector<HTMLButtonElement>(`[data-move="${refocus.by}"]`);
        const other = row?.querySelector<HTMLButtonElement>(`[data-move="${-refocus.by}"]`);
        (wanted && !wanted.disabled ? wanted : other)?.focus();
        setRefocus(null);
    }, [refocus]);

    function apply(change: PromptChange | null): boolean {
        if (!change) return false;
        setLists(change.lists);
        setFilter((before) => filterAfter(change.lists, before));
        void writePromptLists(change.writes);
        return true;
    }

    const rows = lists ? promptRows(lists, filter) : [];
    const filters = lists ? projectsWithPrompts(lists) : [];

    const form = (
        <PromptForm
            draft={draft}
            projects={scopeProjects(lists, draft?.scope ?? null)}
            onChange={setDraft}
            onCancel={() => setDraft(null)}
            onSave={() => {
                if (lists && draft && apply(savePrompt(lists, draft, crypto.randomUUID()))) setDraft(null);
            }}
            onDelete={() => {
                if (lists && draft?.id && apply(deletePrompt(lists, draft.id))) setDraft(null);
            }}
        />
    );

    return (
        <div className="settings-section saved-prompts" id={SAVED_PROMPTS_SECTION_ID} ref={root}>
            <div className="sp-head">
                <div className="settings-section-title">Saved prompts</div>
                {filters.length > 0 && (
                    <div className="sp-filter" role="group" aria-label="Show prompts">
                        <FilterButton value="all" filter={filter} onPick={setFilter} label="All" />
                        <FilterButton value={null} filter={filter} onPick={setFilter} label="Everywhere" />
                        {filters.map((path) => (
                            <FilterButton
                                key={path}
                                value={path}
                                filter={filter}
                                onPick={setFilter}
                                label={projectLabel(path)}
                            />
                        ))}
                    </div>
                )}
            </div>
            <div className="settings-description sp-intro">
                Shown under Ask in a session&apos;s tray. Everywhere prompts come first, then the session&apos;s
                project&apos;s own; ⌘1–9 follow this order. Changes are saved as you make them.
            </div>

            {lists !== null && rows.length === 0 && !draft && (
                <div className="settings-description sp-empty">No saved prompts yet.</div>
            )}
            {rows.length > 0 && (
                <ul className="sp-list" aria-label="Saved prompts">
                    <li className="sp-row sp-row-heads" aria-hidden="true">
                        <span>Key</span>
                        <span>Prompt</span>
                        <span>Scope</span>
                        <span>When clicked</span>
                        <span />
                    </li>
                    {rows.map((row) => (
                        <PromptListRow
                            key={row.prompt.id}
                            row={row}
                            editing={draft?.id === row.prompt.id}
                            onEdit={() => lists && setDraft(draftFor(lists, row.prompt.id))}
                            onMove={(by) => {
                                if (lists && apply(movePrompt(lists, row.prompt.id, by))) {
                                    setRefocus({id: row.prompt.id, by});
                                }
                            }}
                            form={draft?.id === row.prompt.id ? form : null}
                        />
                    ))}
                </ul>
            )}

            {draft?.id === null ? (
                form
            ) : (
                <div className="sp-add">
                    <button
                        type="button"
                        className="pa-btn"
                        id="sv-saved-prompt-add"
                        disabled={lists === null}
                        onClick={() => setDraft(newDraft(filter))}>
                        Add a prompt
                    </button>
                </div>
            )}
        </div>
    );
}

function FilterButton({
    value,
    filter,
    label,
    onPick,
}: {
    value: PromptFilter;
    filter: PromptFilter;
    label: string;
    onPick: (value: PromptFilter) => void;
}): JSX.Element {
    const on = value === filter;
    return (
        <button
            type="button"
            className={'sp-seg' + (on ? ' is-on' : '')}
            aria-pressed={on}
            onClick={() => onPick(value)}>
            {label}
        </button>
    );
}

function PromptListRow({
    row,
    editing,
    onEdit,
    onMove,
    form,
}: {
    row: PromptRow;
    editing: boolean;
    onEdit: () => void;
    onMove: (by: -1 | 1) => void;
    form: JSX.Element | null;
}): JSX.Element {
    const {prompt, scope, key, index, count} = row;
    return (
        <li className={'sp-item' + (editing ? ' is-editing' : '')} data-prompt-id={prompt.id}>
            <div className="sp-row">
                <span className="sp-key">{key === null ? '' : `⌘${key}`}</span>
                <button
                    type="button"
                    className="sp-main"
                    aria-expanded={editing}
                    aria-label={`Edit “${prompt.label}”`}
                    onClick={onEdit}>
                    <span className="sp-label">{prompt.label}</span>
                    <span className="sp-text">{prompt.text}</span>
                </button>
                <span className="sp-meta">{scopeLabel(scope)}</span>
                <span className="sp-meta">{MODES.find((mode) => mode.value === prompt.mode)!.label}</span>
                <span className="sp-moves">
                    <button
                        type="button"
                        className="sp-move"
                        data-move="-1"
                        aria-label={`Move “${prompt.label}” up`}
                        disabled={index === 0}
                        onClick={() => onMove(-1)}>
                        ↑
                    </button>
                    <button
                        type="button"
                        className="sp-move"
                        data-move="1"
                        aria-label={`Move “${prompt.label}” down`}
                        disabled={index === count - 1}
                        onClick={() => onMove(1)}>
                        ↓
                    </button>
                </span>
            </div>
            {form}
        </li>
    );
}

function PromptForm({
    draft,
    projects,
    onChange,
    onCancel,
    onSave,
    onDelete,
}: {
    draft: PromptDraft | null;
    projects: readonly string[];
    onChange: (draft: PromptDraft) => void;
    onCancel: () => void;
    onSave: () => void;
    onDelete: () => void;
}): JSX.Element | null {
    if (!draft) return null;
    const set = (patch: Partial<PromptDraft>): void => onChange({...draft, ...patch});

    function onKeyDown(e: KeyboardEvent): void {
        if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            if (canSave(draft!)) onSave();
        }
    }

    return (
        <form
            className="sp-form"
            aria-label={draft.id === null ? 'New prompt' : `Editing ${draft.label}`}
            onKeyDown={onKeyDown}
            onSubmit={(e) => {
                e.preventDefault();
                if (canSave(draft)) onSave();
            }}>
            <label className="sp-field">
                <span>Label</span>
                <input
                    type="text"
                    className="settings-input"
                    id="sv-saved-prompt-label"
                    autoFocus
                    placeholder="The prompt's first line"
                    value={draft.label}
                    onChange={(e) => set({label: e.currentTarget.value})}
                />
            </label>
            <label className="sp-field">
                <span>Prompt</span>
                <textarea
                    className="settings-input sp-textarea"
                    id="sv-saved-prompt-text"
                    rows={3}
                    spellCheck={false}
                    placeholder="Summarise where this session stands in three lines."
                    value={draft.text}
                    onChange={(e) => set({text: e.currentTarget.value})}
                />
            </label>
            <div className="sp-placeholders">
                Fills in:{' '}
                {SAVED_PROMPT_PLACEHOLDERS.map((name) => (
                    <code key={name}>{`{${name}}`}</code>
                ))}
            </div>
            <div className="sp-form-row">
                <label className="sp-field sp-field-inline">
                    <span>Scope</span>
                    <select
                        className="settings-select"
                        id="sv-saved-prompt-scope"
                        value={draft.scope ?? ''}
                        onChange={(e) => set({scope: e.currentTarget.value || null})}>
                        <option value="">Everywhere</option>
                        {projects.map((path) => (
                            <option key={path} value={path}>
                                {projectLabel(path)}
                            </option>
                        ))}
                    </select>
                </label>
                <div className="sp-field sp-field-inline">
                    <span id="sv-saved-prompt-mode-label">When clicked</span>
                    <div className="sp-filter" role="radiogroup" aria-labelledby="sv-saved-prompt-mode-label">
                        {MODES.map((mode) => (
                            <button
                                key={mode.value}
                                type="button"
                                role="radio"
                                aria-checked={draft.mode === mode.value}
                                className={'sp-seg' + (draft.mode === mode.value ? ' is-on' : '')}
                                onClick={() => set({mode: mode.value})}>
                                {mode.label}
                            </button>
                        ))}
                    </div>
                </div>
            </div>
            <div className="sp-form-actions">
                {draft.id !== null && (
                    <button type="button" className="pa-btn pa-btn-danger" onClick={onDelete}>
                        Delete
                    </button>
                )}
                <span className="sp-spacer" />
                <button type="button" className="pa-btn" onClick={onCancel}>
                    Cancel
                </button>
                <button type="submit" className="pa-btn sp-save" disabled={!canSave(draft)}>
                    Save
                </button>
            </div>
        </form>
    );
}
