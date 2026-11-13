/**
 * The Planner URL field's check (#412): does the Planner there answer with a
 * cycle? "✓ cycle N" when it does, a warning when it does not, nothing while
 * the field is empty.
 *
 * Checked for the stored URL when the form opens, then each time the field
 * is committed (blur or Enter, the input's native `change`), like the Tasks
 * URL. An answer for a URL since typed over is dropped.
 */
import {useEffect, useRef, useState} from 'react';
import {plannerCycle} from './actions';
import type {RefObject} from 'react';

export interface PlannerUrlField {
    urlRef: RefObject<HTMLInputElement | null>;
    /** The URL the answer is for, trimmed. */
    checked: string;
    /** 'asking' until main answers; the cycle, or 'none' when the Planner gave none. */
    answer: 'asking' | 'none' | {number: number};
}

export function usePlannerUrl(initial: string): PlannerUrlField {
    const urlRef = useRef<HTMLInputElement | null>(null);
    const [state, setState] = useState<{checked: string; answer: PlannerUrlField['answer']}>({
        checked: initial.trim(),
        answer: 'asking',
    });

    useEffect(() => {
        const check = (url: string): void => {
            const trimmed = url.trim();
            setState({checked: trimmed, answer: 'asking'});
            if (!trimmed) return;
            void plannerCycle(trimmed).then((cycle) => {
                if ((urlRef.current?.value ?? trimmed).trim() !== trimmed) return; // typed over meanwhile
                setState({checked: trimmed, answer: cycle ?? 'none'});
            });
        };
        check(initial);
        const input = urlRef.current;
        if (!input) return;
        const onChange = (): void => check(input.value);
        input.addEventListener('change', onChange);
        return () => input.removeEventListener('change', onChange);
    }, []);

    return {urlRef, ...state};
}
