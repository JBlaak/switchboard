/**
 * Patch's column beside a sheet over the terminal: Patch, the count under it,
 * and its line for screen readers. Shared by the question panel and the
 * grilling card.
 *
 * Patch is an imperative handle, mounted once and told what to say whenever
 * the set's `said` moves on. The sheet decides when a line may play (`ready`:
 * up, and not in the middle of a swap) and hands over which set is greeting
 * (`arriving`), so the hello comes with Patch's rise into the column.
 */
import {useEffect, useLayoutEffect, useRef} from 'react';
import {mountPatch} from '@jblaak/patch';
import {dressingOn} from '../../../domain/companion/calendar';
import {questionBeat} from '../../../domain/companion/question-beats';
import {timeOfDay} from '../../../domain/companion/patch';
import {patchArrive} from '../../features/questions/question-motion';
import {pokePatch, questionSky} from './actions';
import type {JSX, MutableRefObject} from 'react';
import type {PatchHandle} from '@jblaak/patch';
import type {Said} from '../../state/answers-slice';

export interface PatchColumnProps {
    /** The sheet is up; hiding it forgets the last line, so a re-show plays it again. */
    up: boolean;
    /** A line may play now. */
    ready: boolean;
    toolUseId: string | undefined;
    said: Said | null;
    /** The set Patch is about to greet; cleared once it has risen in for it. */
    arriving: MutableRefObject<string | null>;
    /** The line under Patch, such as how many are answered. */
    foot: string;
}

export function PatchColumn({up, ready, toolUseId, said, arriving, foot}: PatchColumnProps): JSX.Element {
    const stage = useRef<HTMLDivElement>(null);
    const patch = useRef<PatchHandle | null>(null);
    const live = useRef(toolUseId);
    live.current = toolUseId;
    /** The line last played: which set, and its `said` count. */
    const played = useRef<{toolUseId: string; seq: number} | null>(null);

    useEffect(() => {
        const handle = mountPatch(stage.current!, {
            onPoke: () => {
                if (live.current) pokePatch(live.current);
            },
        });
        patch.current = handle;
        return () => {
            handle.destroy();
            if (patch.current === handle) patch.current = null;
        };
    }, []);

    useLayoutEffect(() => {
        if (!up) played.current = null;
    }, [up]);

    useLayoutEffect(() => {
        if (!up || !ready || !toolUseId) return;
        const seq = said?.seq ?? 0;
        const prev = played.current;
        if (prev && prev.toolUseId === toolUseId && prev.seq === seq) return;
        played.current = {toolUseId, seq};
        if (!said || !patch.current) return;
        if (arriving.current === toolUseId && said.moment.kind === 'arrived') {
            arriving.current = null;
            if (stage.current) patchArrive(stage.current);
        }
        patch.current.appear({
            ...questionBeat(said.moment),
            time: timeOfDay(new Date().getHours()),
            sky: questionSky(),
            ...dressingOn(new Date()),
        });
    }, [up, ready, toolUseId, said?.seq]);

    return (
        <div className="qp-patch-col">
            <div ref={stage} className="qp-patch" />
            <span className="qp-foot">{foot}</span>
            <div className="qp-sr" role="status" aria-live="polite">
                {said ? questionBeat(said.moment).line : ''}
            </div>
        </div>
    );
}
