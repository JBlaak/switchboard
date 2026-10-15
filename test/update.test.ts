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
  assert.equal(isNewer('2.1.0', '2.0.9'), true);
  assert.equal(isNewer('2.0.10', '2.0.9'), true);
  assert.equal(isNewer('v2.0.0', '0.0.33'), true);
  assert.equal(isNewer('2.0.0', '2.0.0'), false);
  assert.equal(isNewer('2.0.0', '2.1.0'), false);
});

test('an unreadable version is never newer', () => {
  assert.equal(isNewer('2.1.0-beta.1', '2.0.0'), false);
  assert.equal(isNewer('latest', '2.0.0'), false);
  assert.equal(isNewer('2.1.0', 'dev'), false);
});

// ── GitHub's answer ──

test('the latest release is read from GitHub\'s response', () => {
  const release = parseLatestRelease({
    tag_name: 'v2.1.0',
    html_url: RELEASE.pageUrl,
    draft: false,
    prerelease: false,
    assets: [
      { name: 'Switchboard-2.1.0-arm64.zip', browser_download_url: 'https://example.test/arm64.zip' },
      { name: 'broken' },
    ],
  });
  assert.deepEqual(release, {
    version: '2.1.0',
    pageUrl: RELEASE.pageUrl,
    assets: [{ name: 'Switchboard-2.1.0-arm64.zip', url: 'https://example.test/arm64.zip' }],
  });
});

test('drafts, pre-releases and odd tags are not releases', () => {
  assert.equal(parseLatestRelease({ tag_name: 'v2.1.0', draft: true }), null);
  assert.equal(parseLatestRelease({ tag_name: 'v2.1.0', prerelease: true }), null);
  assert.equal(parseLatestRelease({ tag_name: 'nightly' }), null);
  assert.equal(parseLatestRelease(null), null);
});

// ── Which file to install ──

test('the update points at the zip for this architecture', () => {
  assert.equal(updateAssetName('2.1.0', 'arm64'), 'Switchboard-2.1.0-arm64.zip');
  assert.equal(availableUpdate(RELEASE, '2.0.0', 'x64')?.downloadUrl, 'https://example.test/x64.zip');
});

test('a release without a zip for this architecture is still offered, without a download', () => {
  const update = availableUpdate(RELEASE, '2.0.0', 'ia32');
  assert.equal(update?.version, '2.1.0');
  assert.equal(update?.downloadUrl, null);
});

test('nothing is offered when the running version is current', () => {
  assert.equal(availableUpdate(RELEASE, '2.1.0', 'arm64'), null);
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
  const { service, renderer } = harness();
  await service.check();
  await service.check();
  assert.deepEqual(renderer.only('updateAvailable'), [['updateAvailable', {
    version: '2.1.0', pageUrl: RELEASE.pageUrl, installable: true,
  }]]);
});

test('no release, or a failed check, announces nothing', async () => {
  for (const opts of [{ release: null }, { fails: true }]) {
    const { service, renderer } = harness(opts);
    await service.check();
    assert.equal(renderer.only('updateAvailable').length, 0);
    assert.equal(service.notice(), null);
  }
});

test('an app that cannot replace itself is offered the release page instead', async () => {
  const { service, installs } = harness({ canInstall: false });
  await service.check();
  assert.equal(service.notice()?.installable, false);
  assert.equal(await service.install(), false);
  assert.deepEqual(installs, []);
});

test('install fetches the zip for this architecture', async () => {
  const { service, installs } = harness();
  assert.equal(await service.install(), false, 'nothing to install before a check');
  await service.check();
  assert.equal(await service.install(), true);
  assert.deepEqual(installs, ['https://example.test/arm64.zip']);
});

test('checks are scheduled after launch, not during it', () => {
  const { service, timers } = harness();
  service.start();
  assert.equal(timers.pending, 2);
});
