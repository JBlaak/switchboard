/**
 * Patch, the friend on the empty screen.
 *
 * Patch appears each time the placeholder comes into view, reading the board as
 * it is at that moment: how many sessions run, how close the usage limit is,
 * the weather and the hour. It does not follow those while it is on screen; the
 * next appearance picks up whatever changed.
 *
 * Every path that shows the placeholder goes through `showEmptyScreen`, which
 * is what makes "comes into view" a single event rather than a display change
 * scattered across the features.
 *
 * Clicking Patch pokes it, and dragging picks it up; either way it answers
 * straight away with a reaction, dressed as it was, without gathering the
 * board again.
 */
import { mountPatch } from '@jblaak/patch';
import '@jblaak/patch/patch.css';
import {
  RAPID_POKE_WINDOW_MS, beatFor, dropBeat, patchMood, pokeBeat, timeOfDay,
} from '../../../domain/companion/patch';
import { placeholder } from '../../lib/dom';
import { view } from '../../state/session-store';
import { tightestUsage, whenUsageLoaded } from '../../state/usage-store';
import type { PatchBeat, PatchContext, PatchSky } from '../../../domain/companion/patch';
import type { Fling, PatchHandle, PatchScene } from '@jblaak/patch';

/**
 * How long an appearance waits for the numbers before going with what it has.
 *
 * The first one after launch races the usage and weather fetches; a Patch that
 * shows up late reads as a glitch, one with a slightly stale line does not.
 */
const GATHER_TIMEOUT_MS = 1500;

let patch: PatchHandle | null = null;
let appearances = 0;
/** Bumped per appearance, so a slow gather cannot overwrite a newer one. */
let latest = 0;
/** The scene on screen, which a poke keeps the dressing of. */
let shown: PatchScene | null = null;
let pokes = 0;
let drops = 0;
/** When the recent pokes landed, oldest first. */
let pokeTimes: number[] = [];

export function installPatch(): void {
  const stage = document.createElement('div');
  stage.className = 'placeholder-patch';
  placeholder.prepend(stage);
  patch = mountPatch(stage, { onPoke: poke, onDrop: drop });
  // Warm main's weather cache, so the first appearance does not wait on it.
  void window.api.getWeather().catch(() => null);
  if (placeholder.style.display !== 'none') void appear();
}

/** Show the empty screen, with Patch coming into view on it. */
export function showEmptyScreen(): void {
  const wasHidden = placeholder.style.display === 'none';
  placeholder.style.display = '';
  if (wasHidden) void appear();
}

async function appear(): Promise<void> {
  if (!patch) return;
  const token = ++latest;
  const ctx = await gatherContext();
  if (token !== latest || placeholder.style.display === 'none') return;
  const beat = beatFor(ctx, appearances++);
  shown = {
    move: beat.move,
    line: beat.line,
    mood: patchMood(ctx),
    sky: ctx.sky,
    time: timeOfDay(ctx.hour),
  };
  patch.appear(shown);
}

function poke(): void {
  const now = Date.now();
  pokeTimes = pokeTimes.filter(t => now - t < RAPID_POKE_WINDOW_MS);
  const beat = pokeBeat(pokes++, now, pokeTimes);
  pokeTimes.push(now);
  react(beat);
}

function drop({ speed }: Fling): void {
  react(dropBeat(drops++, speed));
}

/** Answer the user straight away, keeping the dressing Patch arrived in. */
function react(beat: PatchBeat): void {
  if (!patch || !shown) return;
  // A reaction during a gather wins; the gathered scene would replace it.
  latest++;
  shown = { ...shown, move: beat.move, line: beat.line };
  patch.appear(shown);
}

async function gatherContext(): Promise<PatchContext> {
  const [running, sky] = await Promise.all([
    withTimeout(window.api.getActiveSessions().then(ids => ids.length), view.activePtyIds.size),
    withTimeout<PatchSky | null>(window.api.getWeather().then(w => w?.sky ?? null), null),
    withTimeout(whenUsageLoaded(), undefined),
  ]);
  const usage = tightestUsage();
  return {
    running,
    usagePercent: usage?.percent ?? null,
    usageReset: usage?.reset ?? null,
    sky,
    hour: new Date().getHours(),
  };
}

/** The promise's value, or `fallback` if it fails or takes too long. */
function withTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([
    promise.catch(() => fallback),
    new Promise<T>(resolve => setTimeout(() => resolve(fallback), GATHER_TIMEOUT_MS)),
  ]);
}
