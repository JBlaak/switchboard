import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    installConfirmation,
    runningLabel,
    quotaGaugeView,
    updateNoticeView,
    updateOutcomeView,
} from '../src/renderer/ui/footer/footer-view';
import {usageGaugeRows} from '../src/domain/usage/usage';
import type {UsageLimit} from '../src/domain/usage/usage';
import type {UpdateNotice} from '../src/domain/update/release';
import type {InstallProgress} from '../src/domain/update/progress';

const sessionAt = (percent: number): UsageLimit => ({
    kind: 'session',
    label: 'Current session',
    model: null,
    percent,
    reset: '6pm (UTC)',
    severity: 'normal',
});

const weekAt = (percent: number): UsageLimit => ({
    kind: 'weekly_all',
    label: 'Week (all models)',
    model: null,
    percent,
    reset: 'Jun 12 at 9am (UTC)',
    severity: 'normal',
});

const notice = (installable = true): UpdateNotice => ({
    version: '9.1.0',
    pageUrl: 'https://example.com/v9.1.0',
    installable,
});

const idle = {installing: false, progress: null, failure: null};
const installingAt = (progress: InstallProgress | null) => ({installing: true, progress, failure: null});

// ── Quota gauges ──

test('a gauge is titled short, with the full label, percentage and reset in its tooltip', () => {
    /* When */
    const gauges = [sessionAt(42), weekAt(67)].map(quotaGaugeView);

    /* Then */
    assert.deepEqual(
        gauges.map((g) => [g.label, g.percentText, g.tooltip]),
        [
            ['5h', '42%', 'Current session: 42% — resets 6pm (UTC)'],
            ['Week', '67%', 'Week (all models): 67% — resets Jun 12 at 9am (UTC)'],
        ],
    );
});

test('a gauge without a reset leaves it out of the tooltip', () => {
    /* When */
    const gauge = quotaGaugeView({...sessionAt(42), reset: null});

    /* Then */
    assert.equal(gauge.tooltip, 'Current session: 42%');
});

test('the 5-hour gauge is coloured from 60% and again from 80%', () => {
    /* When */
    const classes = [0, 59, 60, 79, 80, 100].map((p) => quotaGaugeView(sessionAt(p)).fillClass);

    /* Then */
    assert.deepEqual(classes, [
        'quota-fill',
        'quota-fill',
        'quota-fill quota-mid',
        'quota-fill quota-mid',
        'quota-fill quota-high',
        'quota-fill quota-high',
    ]);
});

test('the weekly gauge is coloured from 80% and again from 90%', () => {
    /* When */
    const classes = [0, 79, 80, 89, 90, 100].map((p) => quotaGaugeView(weekAt(p)).fillClass);

    /* Then */
    assert.deepEqual(classes, [
        'quota-fill',
        'quota-fill',
        'quota-fill quota-mid',
        'quota-fill quota-mid',
        'quota-fill quota-high',
        'quota-fill quota-high',
    ]);
});

test('a gauge never draws less than 1% or more than 100%', () => {
    /* When */
    const widths = [0, 1, 80, 130].map((p) => quotaGaugeView(sessionAt(p)).width);

    /* Then */
    assert.deepEqual(widths, ['1%', '1%', '80%', '100%']);
});

test('no usage means no gauges', () => {
    /* When */
    const rows = usageGaugeRows(null);

    /* Then */
    assert.deepEqual(rows, []);
});

test('only the shared windows get a gauge, not the per-model ones', () => {
    /* Given */
    const perModel: UsageLimit = {...weekAt(30), kind: 'weekly_model', label: 'Week (Opus)', model: 'Opus'};

    /* When */
    const rows = usageGaugeRows({limits: [sessionAt(42), perModel, weekAt(67)]});

    /* Then */
    assert.deepEqual(
        rows.map((r) => r.label),
        ['Current session', 'Week (all models)'],
    );
});

// ── Update notice ──

test('an installable release offers Install, which replaces the app', () => {
    /* When */
    const shown = updateNoticeView(notice(), idle);

    /* Then */
    assert.deepEqual(shown, {
        label: 'Version 9.1.0 is available',
        detail: null,
        action: 'Install',
        actionTitle: 'Download, replace this app and restart',
        bar: null,
        dismissible: true,
    });
});

test('a release the app cannot install itself offers the release page instead', () => {
    /* When */
    const shown = updateNoticeView(notice(false), idle);

    /* Then */
    assert.deepEqual([shown.action, shown.actionTitle], ['View', 'Open the release page']);
});

test('an install says each step, with no button or × while it runs', () => {
    /* Given */
    const steps: [InstallProgress | null, string, number | 'indeterminate'][] = [
        [null, 'Starting the 9.1.0 download…', 'indeterminate'],
        [{step: 'downloading', received: 41_200_000, total: 98_000_000}, 'Downloading 9.1.0… 42%', 0.42],
        [{step: 'downloading', received: 41_200_000, total: null}, 'Downloading 9.1.0… 41.2 MB', 'indeterminate'],
        [{step: 'unpacking'}, 'Unpacking 9.1.0…', 'indeterminate'],
        [{step: 'checking'}, 'Checking 9.1.0…', 'indeterminate'],
        [{step: 'restarting'}, 'Restarting into 9.1.0…', 1],
    ];

    for (const [progress, label, bar] of steps) {
        /* When */
        const shown = updateNoticeView(notice(), installingAt(progress));

        /* Then */
        assert.deepEqual(
            [shown.label, shown.bar, shown.action, shown.dismissible],
            [label, bar, null, false],
            JSON.stringify(progress),
        );
    }
});

test('a download of known size gives its megabytes in the tooltip', () => {
    /* When */
    const shown = updateNoticeView(
        notice(),
        installingAt({step: 'downloading', received: 41_200_000, total: 98_000_000}),
    );

    /* Then */
    assert.equal(shown.detail, '41.2 MB of 98.0 MB');
});

test('a failed install names the step it stopped at, says why, and offers a retry', () => {
    /* Given */
    const cases = [
        ['downloading', 'Download failed'],
        ['unpacking', 'Unpacking failed'],
        ['checking', 'The download is damaged'],
        ['restarting', 'Restart failed'],
    ] as const;

    for (const [step, label] of cases) {
        /* When */
        const shown = updateNoticeView(notice(), {
            installing: false,
            progress: null,
            failure: {step, reason: 'GitHub answered 404.'},
        });

        /* Then */
        assert.deepEqual(
            [shown.label, shown.detail, shown.action, shown.bar],
            [label, 'GitHub answered 404. This app was left as it was.', 'Retry', null],
        );
    }
});

test('after a restart the line says whether the update arrived', () => {
    /* When */
    const updated = updateOutcomeView({kind: 'updated', version: '9.1.0'});
    const notApplied = updateOutcomeView({kind: 'notApplied', version: '9.1.0', running: '9.0.0'});

    /* Then */
    assert.deepEqual(updated, {label: 'Updated to 9.1.0', detail: null});
    assert.equal(notApplied.label, "Update to 9.1.0 didn't apply");
    assert.match(notApplied.detail ?? '', /restarted on 9\.0\.0/);
});

test('installing with nothing running asks nothing', () => {
    /* When */
    const question = installConfirmation(0);

    /* Then */
    assert.equal(question, null);
});

test('installing with sessions running asks first, counting them', () => {
    /* When */
    const questions = [1, 2].map(installConfirmation);

    /* Then */
    assert.deepEqual(questions, [
        'Restarting to update stops 1 running session. Install now?',
        'Restarting to update stops 2 running sessions. Install now?',
    ]);
});

test('runningLabel counts the running sessions', () => {
    /* Given */
    const running = 7;

    /* When */
    const label = runningLabel(running);

    /* Then */
    assert.equal(label, '7 running');
});

test('runningLabel says nothing when no session is running', () => {
    /* Given */
    const running = 0;

    /* When */
    const label = runningLabel(running);

    /* Then */
    assert.equal(label, '');
});
