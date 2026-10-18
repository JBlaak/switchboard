/**
 * Patch, the friend on the empty screen.
 *
 * Patch appears each time the placeholder comes into view, reading the board as
 * it is at that moment: how many sessions run, how close the usage limit is,
 * the weather, the hour, the season and any holiday. It does not follow those
 * while it is on screen; the next appearance picks up whatever changed. The
 * placeholder is shown and hidden imperatively, with the rest of the main
 * area's panel swap, and `showEmptyScreen` says so with `emptyScreenShown`.
 *
 * Clicking Patch pokes it, and dragging picks it up; either way it answers
 * straight away with a reaction, dressed as it was, without gathering the
 * board again. Asking it something in the box below (#135) is answered the
 * same way: it thinks while the text is routed, and says why when it cannot
 * tell where the text belongs.
 *
 * Patch itself is the package's imperative handle, mounted into the stage from
 * an effect; the counts that cycle its lines are refs, since nothing renders
 * from them.
 */
import { useEffect, useRef } from 'react';
import { mountPatch } from '@jblaak/patch';
import '@jblaak/patch/patch.css';
import {
  RAPID_POKE_WINDOW_MS, beatFor, dropBeat, patchMood, pokeBeat, timeOfDay,
} from '../../../domain/companion/patch';
import { dressingOn } from '../../../domain/companion/calendar';
import { fetchWeather } from '../../app/weather';
import { getState, onEvent } from '../../state/app-store';
import { askOutcome } from '../../state/ask-slice';
import { CANCELLED_BEAT, outcomeBeat, thinkingBeat } from '../ask/ask-keys';
import { tightestUsage, whenUsageLoaded } from '../../state/usage-store';
import type { JSX } from 'react';
import type { Fling, PatchHandle, PatchScene } from '@jblaak/patch';
import type { PatchBeat, PatchContext, PatchSky } from '../../../domain/companion/patch';

/**
 * How long an appearance waits for the numbers before going with what it has.
 *
 * The first one after launch races the usage and weather fetches; a Patch that
 * shows up late reads as a glitch, one with a slightly stale line does not.
 */
const GATHER_TIMEOUT_MS = 1500;

export function EmptyScreenPatch(): JSX.Element {
  const stage = useRef<HTMLDivElement>(null);
  const counts = useRef({
    appearances: 0,
    /** Bumped per appearance, so a slow gather cannot overwrite a newer one. */
    latest: 0,
    pokes: 0,
    drops: 0,
    thoughts: 0,
    /** When the recent pokes landed, oldest first. */
    pokeTimes: [] as number[],
    /** The scene on screen, which a poke keeps the dressing of. */
    shown: null as PatchScene | null,
  });

  useEffect(() => {
    const c = counts.current;
    const placeholder = stage.current!.parentElement!;
    const visible = (): boolean => placeholder.style.display !== 'none';

    /** Answer the user straight away, keeping the dressing Patch arrived in. */
    const react = (beat: PatchBeat): void => {
      if (!c.shown) return;
      // A reaction during a gather wins; the gathered scene would replace it.
      c.latest++;
      c.shown = { ...c.shown, move: beat.move, line: beat.line };
      patch.appear(c.shown);
    };

    const patch: PatchHandle = mountPatch(stage.current!, {
      onPoke: () => {
        const now = Date.now();
        c.pokeTimes = c.pokeTimes.filter(t => now - t < RAPID_POKE_WINDOW_MS);
        const beat = pokeBeat(c.pokes++, now, c.pokeTimes);
        c.pokeTimes.push(now);
        react(beat);
      },
      onDrop: ({ speed }: Fling) => react(dropBeat(c.drops++, speed)),
    });

    let mounted = true;
    const appear = async (): Promise<void> => {
      const token = ++c.latest;
      const ctx = await gatherContext();
      if (!mounted || token !== c.latest || !visible()) return;
      const beat = beatFor(ctx, c.appearances++);
      c.shown = {
        move: beat.move, line: beat.line, mood: patchMood(ctx),
        sky: ctx.sky, time: timeOfDay(ctx.hour), season: ctx.season, holiday: ctx.holiday,
      };
      patch.appear(c.shown);
    };

    // Warm main's weather cache, so the first appearance does not wait on it.
    void fetchWeather();
    if (visible()) void appear();
    const unsubscribers = [
      onEvent('emptyScreenShown', () => void appear()),
      // Only what the box's reducer took: a stale answer, or Enter on nothing, says nothing.
      onEvent('askSent', (_e, state, previous) => {
        if (state.ask !== previous.ask) react(thinkingBeat(c.thoughts++));
      }),
      onEvent('askCancelled', (_e, state, previous) => {
        if (state.ask !== previous.ask) react(CANCELLED_BEAT);
      }),
      onEvent('askAnswered', (e, state, previous) => {
        if (state.ask === previous.ask) return;
        const beat = outcomeBeat(askOutcome(e.result, previous.ask.text));
        if (beat) react(beat);
      }),
    ];

    return () => {
      mounted = false;
      unsubscribers.forEach(unsubscribe => unsubscribe());
      patch.destroy();
    };
  }, []);

  return <div ref={stage} className="placeholder-patch" />;
}

async function gatherContext(): Promise<PatchContext> {
  const [running, sky] = await Promise.all([
    withTimeout(window.api.getActiveSessions().then(ids => ids.length), getState().view.activePtyIds.size),
    withTimeout<PatchSky | null>(fetchWeather().then(w => w?.sky ?? null), null),
    withTimeout(whenUsageLoaded(), undefined),
  ]);
  const usage = tightestUsage();
  const now = new Date();
  return {
    running,
    usagePercent: usage?.percent ?? null,
    usageReset: usage?.reset ?? null,
    sky,
    hour: now.getHours(),
    ...dressingOn(now),
  };
}

/** The promise's value, or `fallback` if it fails or takes too long. */
function withTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([
    promise.catch(() => fallback),
    new Promise<T>(resolve => setTimeout(() => resolve(fallback), GATHER_TIMEOUT_MS)),
  ]);
}
