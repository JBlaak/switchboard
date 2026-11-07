import {test} from 'node:test';
import assert from 'node:assert/strict';

import {availableUpdate, isNewer, parseLatestRelease, updateAssetName} from '../src/domain/update/release';
import {downloadWorthReporting, updateOutcome} from '../src/domain/update/progress';
import {UpdateService} from '../src/application/services/update-service';
import {fakeRenderer, fakeTimers, silentLog} from './support/fakes';
import type {PublishedRelease} from '../src/domain/update/release';
import type {AppInstaller, PendingUpdateStore, PrepareListener, ReleaseFeed} from '../src/application/ports/updates';
import type {PendingUpdate} from '../src/domain/update/progress';

const RELEASE: PublishedRelease = {
    version: '2.1.0',
    pageUrl: 'https://github.com/JBlaak/switchboard/releases/tag/v2.1.0',
    assets: [
        {name: 'Switchboard-2.1.0-arm64.dmg', url: 'https://example.test/arm64.dmg'},
        {name: 'Switchboard-2.1.0-arm64.zip', url: 'https://example.test/arm64.zip'},
        {name: 'Switchboard-2.1.0-x64.zip', url: 'https://example.test/x64.zip'},
    ],
};

// ── Versions ──

test('a later minor or patch is newer, the same or an earlier one is not', () => {
    /* Given */
    const cases: [string, string, boolean][] = [
        ['2.1.0', '2.0.9', true],
        ['2.0.10', '2.0.9', true],
        ['v2.0.0', '0.0.33', true],
        ['2.0.0', '2.0.0', false],
        ['2.0.0', '2.1.0', false],
    ];

    for (const [candidate, current, expected] of cases) {
        /* When */
        const newer = isNewer(candidate, current);

        /* Then */
        assert.equal(newer, expected, `${candidate} vs ${current}`);
    }
});

test('an unreadable version is never newer', () => {
    /* Given */
    const cases: [string, string][] = [
        ['2.1.0-beta.1', '2.0.0'],
        ['latest', '2.0.0'],
        ['2.1.0', 'dev'],
    ];

    for (const [candidate, current] of cases) {
        /* When */
        const newer = isNewer(candidate, current);

        /* Then */
        assert.equal(newer, false, `${candidate} vs ${current}`);
    }
});

// ── GitHub's answer ──

test("the latest release is read from GitHub's response", () => {
    /* Given */
    const response = {
        tag_name: 'v2.1.0',
        html_url: RELEASE.pageUrl,
        draft: false,
        prerelease: false,
        assets: [
            {name: 'Switchboard-2.1.0-arm64.zip', browser_download_url: 'https://example.test/arm64.zip'},
            {name: 'broken'},
        ],
    };

    /* When */
    const release = parseLatestRelease(response);

    /* Then */
    assert.deepEqual(release, {
        version: '2.1.0',
        pageUrl: RELEASE.pageUrl,
        assets: [{name: 'Switchboard-2.1.0-arm64.zip', url: 'https://example.test/arm64.zip'}],
    });
});

test('drafts, pre-releases and odd tags are not releases', () => {
    /* Given */
    const responses = [
        {tag_name: 'v2.1.0', draft: true},
        {tag_name: 'v2.1.0', prerelease: true},
        {tag_name: 'nightly'},
        null,
    ];

    for (const response of responses) {
        /* When */
        const release = parseLatestRelease(response);

        /* Then */
        assert.equal(release, null, JSON.stringify(response));
    }
});

// ── Which file to install ──

test('the update asset is the zip for this architecture', () => {
    /* When */
    const name = updateAssetName('2.1.0', 'arm64');

    /* Then */
    assert.equal(name, 'Switchboard-2.1.0-arm64.zip');
});

test('the update points at the zip for this architecture', () => {
    /* When */
    const update = availableUpdate(RELEASE, '2.0.0', 'x64');

    /* Then */
    assert.equal(update?.downloadUrl, 'https://example.test/x64.zip');
});

test('a release without a zip for this architecture is still offered, without a download', () => {
    /* When */
    const update = availableUpdate(RELEASE, '2.0.0', 'ia32');

    /* Then */
    assert.equal(update?.version, '2.1.0');
    assert.equal(update?.downloadUrl, null);
});

test('nothing is offered when the running version is current', () => {
    /* When */
    const update = availableUpdate(RELEASE, '2.1.0', 'arm64');

    /* Then */
    assert.equal(update, null);
});

// ── Install progress ──

test('a download is reported again each whole percent, or each megabyte when its size is unknown', () => {
    /* Given */
    const cases: [number | null, number, number | null, boolean][] = [
        [null, 0, 1000, true],
        [0, 9, 1000, false],
        [0, 10, 1000, true],
        [10, 19, 1000, false],
        [990, 1000, 1000, true],
        [0, 999_999, null, false],
        [999_999, 1_000_000, null, true],
    ];

    for (const [last, received, total, expected] of cases) {
        /* When */
        const report = downloadWorthReporting(last, received, total);

        /* Then */
        assert.equal(report, expected, `${last} → ${received} of ${total}`);
    }
});

test('the launch after an install is updated when it runs the version installed', () => {
    /* When */
    const outcomes = [
        updateOutcome({from: '2.0.0', to: '2.1.0'}, '2.1.0'),
        updateOutcome({from: '2.0.0', to: '2.1.0'}, '2.0.0'),
    ];

    /* Then */
    assert.deepEqual(outcomes, [
        {kind: 'updated', version: '2.1.0'},
        {kind: 'notApplied', version: '2.1.0', running: '2.0.0'},
    ]);
});

// ── The service ──

type PrepareScript = (listener: PrepareListener) => Promise<void>;

function harness(
    opts: {
        release?: PublishedRelease | null;
        fails?: boolean;
        canInstall?: boolean;
        prepare?: PrepareScript;
        swapFails?: boolean;
        pending?: PendingUpdate | null;
    } = {},
) {
    const installs: string[] = [];
    const swapped: string[] = [];
    const feed: ReleaseFeed = {
        latest: async () => {
            if (opts.fails) throw new Error('offline');
            return opts.release === undefined ? RELEASE : opts.release;
        },
    };
    const installer: AppInstaller = {
        canInstall: () => opts.canInstall ?? true,
        prepare: async (url, listener) => {
            installs.push(url);
            await (opts.prepare ?? (async () => {}))(listener);
            return {path: '/tmp/Switchboard.app'};
        },
        swapAndRestart: (bundle) => {
            if (opts.swapFails) throw new Error('spawn failed');
            swapped.push(bundle.path);
        },
    };
    let stored: PendingUpdate | null = opts.pending ?? null;
    const pending: PendingUpdateStore = {
        write: async (entry) => {
            stored = entry;
        },
        take: async () => {
            const taken = stored;
            stored = null;
            return taken;
        },
    };
    const renderer = fakeRenderer();
    const timers = fakeTimers();
    const service = new UpdateService({
        feed,
        installer,
        pending,
        renderer,
        timers,
        log: silentLog,
        currentVersion: '2.0.0',
        arch: 'arm64',
    });
    return {service, renderer, timers, installs, swapped, stored: () => stored};
}

test('a newer release is announced once, however often it is found', async () => {
    /* Given */
    const {service, renderer} = harness();

    /* When */
    await service.check();
    await service.check();

    /* Then */
    assert.deepEqual(renderer.only('updateAvailable'), [
        [
            'updateAvailable',
            {
                version: '2.1.0',
                pageUrl: RELEASE.pageUrl,
                installable: true,
            },
        ],
    ]);
});

test('no release, or a failed check, announces nothing', async () => {
    /* Given */
    const cases = [{release: null}, {fails: true}];

    for (const opts of cases) {
        const {service, renderer} = harness(opts);

        /* When */
        await service.check();

        /* Then */
        assert.equal(renderer.only('updateAvailable').length, 0);
        assert.equal(service.notice(), null);
    }
});

test('an app that cannot replace itself is offered the release page instead', async () => {
    /* Given */
    const {service} = harness({canInstall: false});

    /* When */
    await service.check();

    /* Then */
    assert.equal(service.notice()?.installable, false);
});

test('an app that cannot replace itself does not install', async () => {
    /* Given */
    const {service, installs} = harness({canInstall: false});
    await service.check();

    /* When */
    const installed = await service.install();

    /* Then */
    assert.equal(installed.ok, false);
    assert.deepEqual(installs, []);
});

test('there is nothing to install before a check', async () => {
    /* Given */
    const {service, installs} = harness();

    /* When */
    const installed = await service.install();

    /* Then */
    assert.equal(installed.ok, false, 'nothing to install before a check');
    assert.deepEqual(installs, []);
});

test('install fetches the zip for this architecture', async () => {
    /* Given */
    const {service, installs} = harness();
    await service.check();

    /* When */
    const installed = await service.install();

    /* Then */
    assert.deepEqual(installed, {ok: true});
    assert.deepEqual(installs, ['https://example.test/arm64.zip']);
});

test('an install tells the renderer each step in order, and the download each percent', async () => {
    /* Given */
    const {service, renderer, swapped} = harness({
        prepare: async (listener) => {
            listener.downloaded(0, 1000);
            for (let received = 1; received <= 1000; received++) listener.downloaded(received, 1000);
            listener.unpacking();
            listener.checking();
        },
    });
    await service.check();

    /* When */
    await service.install();

    /* Then */
    const steps = renderer.only('updateProgress').map(([, progress]) => progress as {step: string; received?: number});
    const downloads = steps.filter((p) => p.step === 'downloading');
    assert.equal(downloads.length, 101, 'once at the start and once per percent');
    assert.equal(downloads.at(-1)?.received, 1000);
    assert.deepEqual(
        steps.filter((p) => p.step !== 'downloading').map((p) => p.step),
        ['unpacking', 'checking', 'restarting'],
    );
    assert.deepEqual(swapped, ['/tmp/Switchboard.app']);
});

test('a failed install names the step it stopped at, and swaps nothing in', async () => {
    /* Given */
    const {service, swapped} = harness({
        prepare: async (listener) => {
            listener.downloaded(500, 1000);
            listener.unpacking();
            throw new Error('ditto failed: not a zip');
        },
    });
    await service.check();

    /* When */
    const result = await service.install();

    /* Then */
    assert.deepEqual(result, {ok: false, failure: {step: 'unpacking', reason: 'ditto failed: not a zip'}});
    assert.deepEqual(swapped, []);
});

test('a download that fails before any progress is a download failure', async () => {
    /* Given */
    const {service} = harness({
        prepare: async () => {
            throw new Error('GitHub answered 404.');
        },
    });
    await service.check();

    /* When */
    const result = await service.install();

    /* Then */
    assert.deepEqual(result, {ok: false, failure: {step: 'downloading', reason: 'GitHub answered 404.'}});
});

test('the version being installed is noted for the next launch, and forgotten if the swap fails', async () => {
    /* Given */
    const working = harness();
    const failing = harness({swapFails: true});
    await working.service.check();
    await failing.service.check();

    /* When */
    await working.service.install();
    const result = await failing.service.install();

    /* Then */
    assert.deepEqual(working.stored(), {from: '2.0.0', to: '2.1.0'});
    assert.deepEqual(result, {ok: false, failure: {step: 'restarting', reason: 'spawn failed'}});
    assert.equal(failing.stored(), null);
});

test('the launch after an install says how it went, once', async () => {
    /* Given */
    const {service, stored} = harness({pending: {from: '1.9.0', to: '2.0.0'}});

    /* When */
    service.start();

    /* Then */
    assert.deepEqual(await service.outcome(), {kind: 'updated', version: '2.0.0'});
    assert.equal(stored(), null);
});

test('a launch with no install before it has nothing to say', async () => {
    /* Given */
    const {service} = harness();

    /* When */
    service.start();

    /* Then */
    assert.equal(await service.outcome(), null);
});

test('checks are scheduled after launch, not during it', () => {
    /* Given */
    const {service, timers} = harness();

    /* When */
    service.start();

    /* Then */
    assert.equal(timers.pending, 2);
});
