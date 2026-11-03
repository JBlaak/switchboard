/**
 * Text settings that are stored as they are left, not on every key: a
 * project's settings (#176) and a VM's (#307) use them.
 *
 * - `CommitText` is stored when it loses focus, on Enter, or when the view
 *   closes with an edit in it, so a half-typed command is never what a
 *   session launches with.
 * - `CommitTextArea` is the same for a long text, where Enter is a new line.
 *
 * A new stored value (a reset, or the read landing) puts itself in the box.
 */
import {useEffect, useRef, useState} from 'react';
import type {JSX} from 'react';

interface CommitTextProps {
    id: string;
    className: string;
    value: string;
    placeholder: string;
    onCommit(value: string): void;
    /** For a box with no visible label. */
    label?: string;
}

export function CommitText({id, className, value, placeholder, onCommit, label}: CommitTextProps): JSX.Element {
    const [draft, setDraft] = useState(value);
    const latest = useRef({draft, value, onCommit});
    latest.current = {draft, value, onCommit};

    useEffect(() => setDraft(value), [value]);

    useEffect(
        () => () => {
            const {draft: pending, value: stored, onCommit: commit} = latest.current;
            if (pending.trim() !== stored.trim()) commit(pending);
        },
        [],
    );

    const commit = (): void => {
        if (draft.trim() !== value.trim()) onCommit(draft);
    };

    return (
        <input
            id={id}
            type="text"
            className={className}
            value={draft}
            placeholder={placeholder}
            aria-label={label}
            spellCheck={false}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onBlur={commit}
            onKeyDown={(e) => {
                if (e.key === 'Enter') commit();
            }}
        />
    );
}

interface CommitTextAreaProps {
    id: string;
    className: string;
    value: string;
    onCommit(value: string): void;
}

export function CommitTextArea({id, className, value, onCommit}: CommitTextAreaProps): JSX.Element {
    const [draft, setDraft] = useState(value);
    const latest = useRef({draft, value, onCommit});
    latest.current = {draft, value, onCommit};

    useEffect(() => setDraft(value), [value]);

    useEffect(
        () => () => {
            const {draft: pending, value: stored, onCommit: commit} = latest.current;
            if (pending !== stored) commit(pending);
        },
        [],
    );

    return (
        <textarea
            id={id}
            className={className}
            value={draft}
            rows={6}
            spellCheck={false}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onBlur={() => {
                if (draft !== value) onCommit(draft);
            }}
        />
    );
}
