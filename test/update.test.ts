import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  availableUpdate, isNewer, parseLatestRelease, updateAssetName,
} from '../src/domain/update/release';
import { UpdateService } from '../src/application/services/update-service';
import { fakeRenderer, fakeTimers, silentLog } from './support/fakes';
import type { PublishedRelease } from '../src/domain/update/release';
import type { AppInstaller, ReleaseFeed } from '../src/application/ports/updates';

const RELEASE: PublishedRelease = {
  version: '2.1.0',
  pageUrl: 'https://github.com/JBlaak/switchboard/releases/tag/v2.1.0',
  assets: [
    { name: 'Switchboard-2.1.0-arm64.dmg', url: 'https://example.test/arm64.dmg' },
    { name: 'Switchboard-2.1.0-arm64.zip', url: 'https://example.test/arm64.zip' },
    { name: 'Switchboard-2.1.0-x64.zip', url: 'https://example.test/x64.zip' },
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

test('the latest release is read from GitHub\'s response', () => {
  /* Given */
  const response = {
    tag_name: 'v2.1.0',
    html_url: RELEASE.pageUrl,
    draft: false,
    prerelease: false,
    assets: [
      { name: 'Switchboard-2.1.0-arm64.zip', browser_download_url: 'https://example.test/arm64.zip' },
      { name: 'broken' },
    ],
  };

  /* When */
  const release = parseLatestRelease(response);

  /* Then */
  assert.deepEqual(release, {
    version: '2.1.0',
    pageUrl: RELEASE.pageUrl,
    assets: [{ name: 'Switchboard-2.1.0-arm64.zip', url: 'https://example.test/arm64.zip' }],
  });
});

test('drafts, pre-releases and odd tags are not releases', () => {
  /* Given */
  const responses = [
    { tag_name: 'v2.1.0', draft: true },
    { tag_name: 'v2.1.0', prerelease: true },
    { tag_name: 'nightly' },
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

// ── The service ──

function harness(opts: { release?: PublishedRelease | null; fails?: boolean; canInstall?: boolean } = {}) {
  const installs: string[] = [];
  const feed: ReleaseFeed = {
    latest: async () => {
      if (opts.fails) throw new Error('offline');
      return opts.release === undefined ? RELEASE : opts.release;
    },
  };
  const installer: AppInstaller = {
    canInstall: () => opts.canInstall ?? true,
    install: async (url) => { installs.push(url); },
  };
  const renderer = fakeRenderer();
  const timers = fakeTimers();
  const service = new UpdateService({
    feed, installer, renderer, timers, log: silentLog, currentVersion: '2.0.0', arch: 'arm64',
  });
  return { service, renderer, timers, installs };
}

test('a newer release is announced once, however often it is found', async () => {
  /* Given */
  const { service, renderer } = harness();

  /* When */
  await service.check();
  await service.check();

  /* Then */
  assert.deepEqual(renderer.only('updateAvailable'), [['updateAvailable', {
    version: '2.1.0', pageUrl: RELEASE.pageUrl, installable: true,
  }]]);
});

test('no release, or a failed check, announces nothing', async () => {
  /* Given */
  const cases = [{ release: null }, { fails: true }];

  for (const opts of cases) {
    const { service, renderer } = harness(opts);

    /* When */
    await service.check();

    /* Then */
    assert.equal(renderer.only('updateAvailable').length, 0);
    assert.equal(service.notice(), null);
  }
});

test('an app that cannot replace itself is offered the release page instead', async () => {
  /* Given */
  const { service } = harness({ canInstall: false });

  /* When */
  await service.check();

  /* Then */
  assert.equal(service.notice()?.installable, false);
});

test('an app that cannot replace itself does not install', async () => {
  /* Given */
  const { service, installs } = harness({ canInstall: false });
  await service.check();

  /* When */
  const installed = await service.install();

  /* Then */
  assert.equal(installed, false);
  assert.deepEqual(installs, []);
});

test('there is nothing to install before a check', async () => {
  /* Given */
  const { service, installs } = harness();

  /* When */
  const installed = await service.install();

  /* Then */
  assert.equal(installed, false, 'nothing to install before a check');
  assert.deepEqual(installs, []);
});

test('install fetches the zip for this architecture', async () => {
  /* Given */
  const { service, installs } = harness();
  await service.check();

  /* When */
  const installed = await service.install();

  /* Then */
  assert.equal(installed, true);
  assert.deepEqual(installs, ['https://example.test/arm64.zip']);
});

test('checks are scheduled after launch, not during it', () => {
  /* Given */
  const { service, timers } = harness();

  /* When */
  service.start();

  /* Then */
  assert.equal(timers.pending, 2);
});
