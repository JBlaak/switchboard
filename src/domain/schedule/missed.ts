/**
 * Cron times the Mac slept through, or Switchboard was not running for.
 *
 * The tick only ever asks "is now a cron time", so a time that passed while
 * the Mac was asleep or the app was closed is simply gone. On start and on
 * wake the scheduler asks once per schedule for the latest such time, and
 * either runs it now or records it missed, by the schedule's `missed:`
 * setting. Only the latest: a Mac closed for a week owes a nightly schedule
 * one run, not seven.
 */
import {latestCronTime} from './cron';
import type {MissedPolicy} from './manager';

/** How far back a missed time is still owed. */
export const MISSED_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** Why the scheduler is looking back: Switchboard started, or the Mac woke. */
export type CatchUpCause = 'start' | 'wake';

export interface MissedQuestion {
    cron: string;
    missed: MissedPolicy;
    now: number;
    /** When its first prompt version was saved: it owes nothing from before it was turned on. Null with none. */
    firstVersionAt: number | null;
    /** Whether a run was already recorded for a cron time. */
    hasRunFor(dueAt: number): boolean;
}

/** What to do about a missed time. */
export type MissedDecision =
    | {readonly kind: 'none'}
    | {readonly kind: 'catch-up'; readonly dueAt: number}
    | {readonly kind: 'missed'; readonly dueAt: number};

/** The latest cron time in the last week with no run, and what the schedule says to do about it. */
export function missedDecision(q: MissedQuestion): MissedDecision {
    if (q.firstVersionAt === null) return {kind: 'none'};
    const dueAt = latestCronTime(q.cron, q.now, MISSED_WINDOW_MS);
    if (dueAt === null || dueAt <= q.firstVersionAt || q.hasRunFor(dueAt)) return {kind: 'none'};
    return q.missed === 'skip' ? {kind: 'missed', dueAt} : {kind: 'catch-up', dueAt};
}

/** `HH:MM`, local time. */
export function clockTime(at: number): string {
    const d = new Date(at);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Why a time was missed: "the Mac was asleep at 03:00", "Switchboard was not running at 03:00". */
export function missedReason(cause: CatchUpCause, dueAt: number): string {
    return cause === 'wake'
        ? `the Mac was asleep at ${clockTime(dueAt)}`
        : `Switchboard was not running at ${clockTime(dueAt)}`;
}

/** A missed time run now: "the Mac was asleep at 03:00, ran on wake". */
export function catchUpReason(cause: CatchUpCause, dueAt: number): string {
    return `${missedReason(cause, dueAt)}, ran on ${cause}`;
}
