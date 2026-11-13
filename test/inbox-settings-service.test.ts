/**
 * The managers' settings service (#412) with fakes: the snooze options with
 * and without a Planner, how a Planner that is down is remembered, and
 * Releases are tagged from a repository's tags or the project's own say.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    InboxSettingsService,
    PLANNER_FAILURE_MS,
    RELEASE_TAGS_CACHE_MS,
} from '../src/application/services/inbox-settings-service';
import {toCycle} from '../src/domain/inbox/cycle';
import type {Cycle} from '../src/domain/inbox/cycle';
import cycles from './fixtures/planner-cycles.json';

const APP = '/Users/me/code/app';
const PLANNER = 'https://planner.example.com';
const DAY = 24 * 60 * 60 * 1000;
/** Friday 13 November 2026, 14:00 local. */
const FRIDAY = new Date(2026, 10, 13, 14).getTime();

interface World {
    global?: Record<string, unknown>;
    project?: Record<string, unknown>;
    cycle?: Cycle | null;
    origin?: string | null;
    latestTag?: {at: string | null} | null;
}

function service(world: World = {}) {
    const asked = {cycles: [] as string[], tags: [] as string[]};
    const clock = {time: FRIDAY, now: () => clock.time};
    const inbox = new InboxSettingsService({
        settings: {global: () => world.global ?? {}, project: () => world.project ?? {}},
        cycles: {
            cycleOn: async (url, day) => {
                asked.cycles.push(url + ' ' + day);
                return world.cycle === undefined ? toCycle(cycles['42']) : world.cycle;
            },
        },
        github: {
            latestTag: async (repo) => {
                asked.tags.push(repo);
                return world.latestTag === undefined
                    ? {at: new Date(FRIDAY - 10 * DAY).toISOString()}
                    : world.latestTag;
            },
        },
        git: {worktreeRoot: async (path) => path},
        remotes: {originUrl: async () => (world.origin === undefined ? 'git@github.com:me/app.git' : world.origin)},
        clock,
        agentlessRemote: () => false,
    });
    return {inbox, asked, clock};
}

test('without a Planner URL the snooze options leave out the cycle ones and nothing is asked', async () => {
    /* Given */
    const {inbox, asked} = service();

    /* When */
    const options = await inbox.snoozeOptions();

    /* Then */
    assert.deepEqual(
        options.map((o) => o.label),
        ['Tomorrow', '1 week', 'Until it changes'],
    );
    assert.deepEqual(asked.cycles, []);
});

test('with a Planner that answers the cycle options follow, each with its time', async () => {
    /* Given */
    const {inbox, asked} = service({global: {plannerUrl: PLANNER}});

    /* When */
    const options = await inbox.snoozeOptions();

    /* Then */
    assert.deepEqual(
        options.filter((o) => o.cycle).map((o) => [o.label, o.until]),
        [
            ['Last week of this cycle', new Date(2026, 11, 14, 9).toISOString()],
            ['Upcoming cooldown week', new Date(2026, 11, 21, 9).toISOString()],
            ['Next cycle', new Date(2026, 11, 28, 9).toISOString()],
        ],
    );
    assert.deepEqual(asked.cycles, [PLANNER + ' 2026-11-13']);
});

test('until it changes crosses as no date', async () => {
    /* Given */
    const {inbox} = service();

    /* When */
    const options = await inbox.snoozeOptions();

    /* Then */
    assert.equal(options.find((o) => o.kind === 'untilChanged')?.until, null);
});

test('a cycle read is kept for the rest of the day', async () => {
    /* Given */
    const {inbox, asked, clock} = service({global: {plannerUrl: PLANNER}});
    await inbox.snoozeOptions();

    /* When */
    clock.time += 6 * 60 * 60 * 1000;
    await inbox.snoozeOptions();

    /* Then */
    assert.equal(asked.cycles.length, 1);
});

test('a Planner that gave no cycle is not asked again for five minutes', async () => {
    /* Given */
    const {inbox, asked, clock} = service({global: {plannerUrl: PLANNER}, cycle: null});
    const first = await inbox.snoozeOptions();

    /* When */
    clock.time += PLANNER_FAILURE_MS - 1;
    const again = await inbox.snoozeOptions();
    clock.time += 1;
    await inbox.snoozeOptions();

    /* Then */
    assert.equal(
        first.some((o) => o.cycle),
        false,
    );
    assert.equal(
        again.some((o) => o.cycle),
        false,
    );
    assert.equal(asked.cycles.length, 2);
});

test('the Settings field asks the URL typed into it, not the stored one', async () => {
    /* Given */
    const {inbox, asked} = service({global: {plannerUrl: 'https://old.example.com'}});

    /* When */
    const cycle = await inbox.plannerCycle(' ' + PLANNER + ' ');

    /* Then */
    assert.deepEqual(cycle, {number: 42});
    assert.deepEqual(asked.cycles, [PLANNER + ' 2026-11-13']);
});

test('an empty Planner URL gives no cycle and asks nothing', async () => {
    /* Given */
    const {inbox, asked} = service();

    /* When */
    const cycle = await inbox.plannerCycle('');

    /* Then */
    assert.equal(cycle, null);
    assert.deepEqual(asked.cycles, []);
});

test('a repository tagged ten days ago is detected as tagging its releases', async () => {
    /* Given */
    const {inbox, asked} = service();

    /* When */
    const tags = await inbox.releaseTags(APP);

    /* Then */
    assert.deepEqual(tags, {
        repository: 'me/app',
        latestTagAt: new Date(FRIDAY - 10 * DAY).toISOString(),
        detected: true,
        override: null,
        tagged: true,
    });
    assert.deepEqual(asked.tags, ['me/app']);
});

test('a repository without tags is detected as not tagging them', async () => {
    /* Given */
    const {inbox} = service({latestTag: {at: null}});

    /* When */
    const tags = await inbox.releaseTags(APP);

    /* Then */
    assert.equal(tags.detected, false);
    assert.equal(tags.tagged, false);
});

test('the project’s own Not tagged wins over a recent tag', async () => {
    /* Given */
    const {inbox} = service({project: {releasesTagged: false}});

    /* When */
    const tagged = await inbox.releasesTagged(APP);

    /* Then */
    assert.equal(tagged, false);
});

test('a project without a GitHub repository is not asked about and counts as not tagged', async () => {
    /* Given */
    const {inbox, asked} = service({origin: null});

    /* When */
    const tags = await inbox.releaseTags(APP);

    /* Then */
    assert.deepEqual(tags, {repository: null, latestTagAt: null, detected: null, override: null, tagged: false});
    assert.deepEqual(asked.tags, []);
});

test('tags that could not be read leave the detection unknown', async () => {
    /* Given */
    const {inbox} = service({latestTag: null, project: {releasesTagged: true}});

    /* When */
    const tags = await inbox.releaseTags(APP);

    /* Then */
    assert.equal(tags.detected, null);
    assert.equal(tags.tagged, true);
});

test('a repository’s tags are read once an hour', async () => {
    /* Given */
    const {inbox, asked, clock} = service();
    await inbox.releaseTags(APP);

    /* When */
    clock.time += RELEASE_TAGS_CACHE_MS - 1;
    await inbox.releaseTags(APP);
    clock.time += 1;
    await inbox.releaseTags(APP);

    /* Then */
    assert.equal(asked.tags.length, 2);
});
