/**
 * What a Bug manager row and its detail say: how long ago, counts made
 * short, today against the daily average, and where a quick triage is and
 * which button its suggestion makes primary.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    compactCount,
    groupedCount,
    primarySortAction,
    relativeAge,
    timesItsAverage,
    triagePhase,
    type BugSortAction,
} from '../src/renderer/ui/bug-manager/bug-row-words';
import type {BugTriage, BugTriageVerdict} from '../src/domain/inbox/model';
import {DAY, HOUR, MINUTE, NOW} from './support/inbox-fixtures';

function triage(patch: Partial<BugTriage> = {}): BugTriage {
    return {
        sessionId: 's1',
        currentId: 's1',
        worktree: '/code/connect/.claude/worktrees/triage',
        startedAt: NOW - 5 * MINUTE,
        verdict: null,
        stoppedAt: null,
        ...patch,
    };
}

function verdict(patch: Partial<BugTriageVerdict> = {}): BugTriageVerdict {
    return {
        happened: 'The export dialog read a closed file.',
        why: 'The handle is dropped before the write.',
        where: 'src/export.ts:42',
        impact: 'A few users lose an export.',
        suggestion: 'fix',
        summary: 'one-line guard',
        confidence: 'high',
        at: NOW,
        ...patch,
    };
}

const ALL: ReadonlySet<BugSortAction> = new Set(['fix', 'snooze', 'backlog']);

// ── How long ago ──

test('under a minute ago is just now, and so is a time in the future', () => {
    /* Given */
    const recent = NOW - 20_000;
    const future = NOW + HOUR;

    /* When */
    const said = [relativeAge(recent, NOW), relativeAge(future, NOW)];

    /* Then */
    assert.deepEqual(said, ['just now', 'just now']);
});

test('minutes, then hours, then yesterday', () => {
    /* Given */
    const times = [NOW - 2 * MINUTE, NOW - 59 * MINUTE, NOW - 3 * HOUR, NOW - 23 * HOUR, NOW - 30 * HOUR];

    /* When */
    const said = times.map((at) => relativeAge(at, NOW));

    /* Then */
    assert.deepEqual(said, ['2 min ago', '59 min ago', '3 h ago', '23 h ago', 'yesterday']);
});

test('days, then months, then years', () => {
    /* Given */
    const times = [
        NOW - 2 * DAY,
        NOW - 6 * DAY,
        NOW - 29 * DAY,
        NOW - 40 * DAY,
        NOW - 95 * DAY,
        NOW - 400 * DAY,
        NOW - 800 * DAY,
    ];

    /* When */
    const said = times.map((at) => relativeAge(at, NOW));

    /* Then */
    assert.deepEqual(said, [
        '2 days ago',
        '6 days ago',
        '29 days ago',
        'a month ago',
        '3 months ago',
        'a year ago',
        '2 years ago',
    ]);
});

test('an ISO time reads the same as its epoch ms, and one that does not parse is empty', () => {
    /* Given */
    const iso = new Date(NOW - 3 * HOUR).toISOString();

    /* When */
    const said = [relativeAge(iso, NOW), relativeAge('not a date', NOW)];

    /* Then */
    assert.deepEqual(said, ['3 h ago', '']);
});

// ── Counts ──

test('a count gets thousands separators', () => {
    /* Given */
    const counts = [7, 1234, 73_412, 1_250_000];

    /* When */
    const said = counts.map(groupedCount);

    /* Then */
    assert.deepEqual(said, ['7', '1,234', '73,412', '1,250,000']);
});

test('a count made short: as is under a thousand, then k with a decimal under ten, then M', () => {
    /* Given */
    const counts = [950, 1000, 1234, 9_990, 73_412, 999_499, 1_450_000, 23_600_000];

    /* When */
    const said = counts.map(compactCount);

    /* Then */
    assert.deepEqual(said, ['950', '1k', '1.2k', '9.9k', '73k', '999k', '1.4M', '24M']);
});

// ── Today against the average ──

test('today is mentioned against its average from 1.5 times it', () => {
    /* Given */
    const hot = {events24h: 30, events7d: 70};
    const barely = {events24h: 15, events7d: 70};
    const calm = {events24h: 14, events7d: 70};

    /* When */
    const said = [timesItsAverage(hot), timesItsAverage(barely), timesItsAverage(calm)];

    /* Then */
    assert.deepEqual(said, [3, 1.5, null]);
});

test('without an average to compare with, today is not mentioned', () => {
    /* Given */
    const fresh = {events24h: 12, events7d: 0};

    /* When */
    const said = timesItsAverage(fresh);

    /* Then */
    assert.equal(said, null);
});

// ── Triage ──

test('a triage is none, running, stopped or in', () => {
    /* Given */
    const cases = [null, undefined, triage(), triage({stoppedAt: NOW}), triage({verdict: verdict()})];

    /* When */
    const phases = cases.map(triagePhase);

    /* Then */
    assert.deepEqual(phases, ['none', 'none', 'running', 'stopped', 'verdict']);
});

test('a verdict that suggests snoozing or the backlog makes that button primary', () => {
    /* Given */
    const snooze = triage({verdict: verdict({suggestion: 'snooze'})});
    const backlog = triage({verdict: verdict({suggestion: 'backlog'})});

    /* When */
    const primary = [primarySortAction(snooze, ALL), primarySortAction(backlog, ALL)];

    /* Then */
    assert.deepEqual(primary, ['snooze', 'backlog']);
});

test('Fix stays primary for a fix or needs-you verdict, a running triage, or none', () => {
    /* Given */
    const cases = [
        triage({verdict: verdict({suggestion: 'fix'})}),
        triage({verdict: verdict({suggestion: 'needsYou'})}),
        triage(),
        null,
    ];

    /* When */
    const primary = cases.map((each) => primarySortAction(each, ALL));

    /* Then */
    assert.deepEqual(primary, ['fix', 'fix', 'fix', 'fix']);
});

test('a suggested button that is not there leaves Fix primary', () => {
    /* Given */
    const snooze = triage({verdict: verdict({suggestion: 'snooze'})});
    const snoozedBug = new Set<BugSortAction>(['fix', 'backlog']);

    /* When */
    const primary = primarySortAction(snooze, snoozedBug);

    /* Then */
    assert.equal(primary, 'fix');
});
