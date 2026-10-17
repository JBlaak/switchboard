/**
 * Playing a level-up (A4) wherever a plan view is on screen: the plan slice
 * decides on each load and poll that there is something to celebrate
 * (`sight` in `plan-slice`), and the view on screen plays it once here.
 *
 * Confetti from the current level's label, Patch popping up bottom right with
 * the beat's line, and the newly Ready issues animating in. Under reduced
 * motion there is no confetti and no Patch, only the line.
 */
import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { mountPatch } from '@jblaak/patch';
import { useStore } from '../../use-store';
import { dispatch } from '../../../state/app-store';
import { celebrate } from '../../../lib/motion/celebrate';
import { reducedMotion } from '../../../lib/motion/spring';
import { dressingOn } from '../../../../domain/companion/calendar';
import { timeOfDay } from '../../../../domain/companion/patch';
import { planBeat } from '../../../../domain/companion/plan-beats';
import type { PlanBeat } from '../../../../domain/companion/plan-beats';
import type { IssueKey } from '../../../../domain/plan/model';
import type { PlanCelebration } from '../../../state/plan-slice';
import { patchArrive, patchLeave } from '../../../features/questions/question-motion';
import { questionSky } from '../../questions/actions';

/** How long the line and the arriving issues stay. */
export const CHEER_MS = 6000;

export interface Cheer {
  readonly id: number;
  readonly beat: PlanBeat;
  readonly arriving: readonly IssueKey[];
}

/** Patch's beat for a celebration. */
export function cheerBeat(celebration: PlanCelebration): PlanBeat {
  const { celebration: what, levels } = celebration;
  return what.kind === 'cleared' ? planBeat({ kind: 'cleared', levels }) : planBeat({ kind: 'level-up', level: what.level, levels });
}

/**
 * The celebration this view is playing, or null. Takes it from the slice the
 * moment it is queued, so a view that mounts again later never replays it.
 */
export function useCheer(): Cheer | null {
  const queued = useStore(state => state.plan.celebration);
  const [cheer, setCheer] = useState<Cheer | null>(null);

  useEffect(() => {
    if (!queued) return;
    dispatch({ type: 'planCelebrationPlayed', id: queued.id });
    setCheer({ id: queued.id, beat: cheerBeat(queued), arriving: queued.arriving });
    if (!reducedMotion()) burst();
  }, [queued]);

  useEffect(() => {
    if (!cheer) return;
    const timer = setTimeout(() => setCheer(null), CHEER_MS);
    return () => clearTimeout(timer);
  }, [cheer]);

  return cheer;
}

/** Confetti from the current level's label, or the diagram's top when the plan is cleared. */
function burst(): void {
  const from = document.querySelector('.pv-band.is-here .pv-band-num')
    ?? document.querySelector('[data-testid="plan-diagram"]');
  if (!from) return;
  const r = from.getBoundingClientRect();
  celebrate(r.left + r.width / 2, from.classList.contains('pv-band-num') ? r.top + r.height / 2 : r.top + 40);
}

/** The line, with Patch saying it when there is motion to spare. */
export function PlanCheer({ cheer }: { cheer: Cheer }): JSX.Element {
  const still = reducedMotion();
  return (
    <div className={'pv-cheer' + (still ? ' is-still' : '')}>
      <div className="pv-cheer-line" role="status" aria-live="polite">{cheer.beat.line}</div>
      {!still && <CheeringPatch key={cheer.id} beat={cheer.beat} />}
    </div>
  );
}

function CheeringPatch({ beat }: { beat: PlanBeat }): JSX.Element {
  const stage = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = stage.current!;
    const patch = mountPatch(el);
    patch.appear({ ...beat, time: timeOfDay(new Date().getHours()), sky: questionSky(), ...dressingOn(new Date()) });
    patchArrive(el, 0);
    const leave = setTimeout(() => { void patchLeave(el); }, CHEER_MS - 300);
    return () => {
      clearTimeout(leave);
      patch.destroy();
    };
  }, [beat]);

  return <div ref={stage} className="pv-cheer-patch" aria-hidden="true" />;
}
