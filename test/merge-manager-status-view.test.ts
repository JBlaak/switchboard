/**
 * What the Merge manager's page by status says in words (`status-view`): a
 * parked flag's cloth, a lane's facts beside its track, the counts, the time
 * pins under the blocks, Coming up's footer, a card's kind line and the
 * folded group the selection unfolds, and the repository headers a compact
 * group's rows sit under.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mergeManagerState} from '../src/domain/merge-manager/landed';
import {pageLanes} from '../src/domain/merge-manager/page';
import {statusGroups} from '../src/domain/merge-manager/status';
import type {LaneTimes, Timeline, TimelineFlag} from '../src/domain/merge-manager/times';
import type {OpenPullRequest} from '../src/domain/merge-manager/not-landed';
import {
    clock,
    comingUpFooter,
    countText,
    expectedClock,
    flagText,
    foldedGroupOf,
    itemKind,
    laneFacts,
    byRepository,
    timePins,
} from '../src/renderer/ui/merge-manager/status-view';
import {HEAD, MIN, NOW, REPO, landedPr} from './support/merge-manager-fixtures';

function flag(over: Partial<TimelineFlag>): TimelineFlag {
    return {at: 0.5, keys: ['a#1'], numbers: [498], tone: 'needsYou', title: '', ...over};
}

function times(rows: [string, number, boolean][], over: Partial<LaneTimes> = {}): LaneTimes {
    return {
        runMs: 11 * MIN,
        rows: new Map(rows.map(([key, at, rough]) => [key, {from: NOW, at, minutes: 0, rough}])),
        clearsAt: rows.length > 0 ? Math.max(...rows.map(([, at]) => at)) : null,
        ...over,
    };
}

function draft(number: number): OpenPullRequest {
    return {
        repository: REPO,
        number,
        title: 'Draft',
        url: '',
        isDraft: true,
        createdAt: NOW,
        headRef: 'b',
        reviewDecision: null,
        mergeable: 'MERGEABLE',
        checks: null,
        reviewRequested: [],
        changesRequestedBy: [],
        approvedBy: [],
    };
}

test('a flag says its sign and the PR for one, its sign and how many for several', () => {
    /* Given */
    const one = flag({tone: 'needsYou', numbers: [498]});
    const fixing = flag({tone: 'fixing', numbers: [503]});
    const several = flag({tone: 'held', numbers: [511, 512, 513], keys: ['a', 'b', 'c']});

    /* When */
    const texts = [one, fixing, several].map(flagText);

    /* Then */
    assert.deepEqual(texts, ['! #498', '↻ #503', '‖ 3']);
});

test("a lane's facts: its kind, one CI run and when it is clear, and the approval warning apart", () => {
    /* Given */
    const lane = {...pageLanes(mergeManagerState([landedPr(1, 10, 'switchboard', HEAD)], new Map()))[0]!};
    const warned = {...lane, approvalLostOnPush: true};
    const lt = times([['k', NOW + 14 * MIN, false]]);

    /* When */
    const facts = laneFacts(warned, lt);

    /* Then */
    assert.equal(facts.line, `Switchboard lane · CI ~11 min · clear by ~${clock(NOW + 14 * MIN)}`);
    assert.equal(facts.warning, 'updating the head loses its approval');
    assert.match(facts.title, /dismisses its approval/);
    assert.equal(laneFacts(lane, times([], {runMs: null})).line, 'Switchboard lane');
});

test('a count reads lower-case', () => {
    /* Given */
    const count = {id: 'ready' as const, name: 'Ready to land', count: 2};

    /* When */
    const text = countText(count);

    /* Then */
    assert.equal(text, '2 ready to land');
});

test('one draft or one conflict reads singular', () => {
    /* Given */
    const drafts = {id: 'drafts' as const, name: 'Drafts', count: 1};
    const conflicts = {id: 'conflicts' as const, name: 'Conflicts', count: 1};

    /* When */
    const texts = [countText(drafts), countText(conflicts), countText({...drafts, count: 2})];

    /* Then */
    assert.deepEqual(texts, ['1 draft', '1 conflict', '2 drafts']);
});

test('pins stand at their blocks’ ends, rough ones with ≈, and one too close to the last is left out', () => {
    /* Given */
    const lt = times([
        ['a', NOW + 10 * MIN, false],
        ['b', NOW + 12 * MIN, false],
        ['c', NOW + 40 * MIN, true],
    ]);
    const blocks = [
        {key: 'c', end: 0.66},
        {key: 'a', end: 0.16},
        {key: 'b', end: 0.2},
    ];

    /* When */
    const pins = timePins(blocks, lt);

    /* Then */
    assert.deepEqual(
        pins.map((pin) => [pin.key, pin.text]),
        [
            ['a', '~' + clock(NOW + 10 * MIN)],
            ['c', '≈' + clock(NOW + 40 * MIN)],
        ],
    );
    assert.equal(expectedClock({at: NOW, rough: true}), '≈' + clock(NOW));
});

test("Coming up's footer: how many landed with the next and the last merge, how many parked, and the not landed", () => {
    /* Given */
    const lt = times([
        ['a', NOW + 10 * MIN, false],
        ['b', NOW + 30 * MIN, false],
    ]);
    const line: Timeline = {
        from: NOW,
        to: NOW + 60 * MIN,
        ticks: [],
        tracks: [{repository: REPO, blocks: [], flags: [flag({keys: ['x', 'y']}), flag({keys: ['z']})]}],
    };

    /* When */
    const footer = comingUpFooter(line, new Map([[REPO, lt]]), 4);

    /* Then */
    assert.equal(footer.landed, `2 landed: next ~${clock(NOW + 10 * MIN)}, all by ~${clock(NOW + 30 * MIN)}`);
    assert.equal(footer.parked, '3 parked');
    assert.equal(footer.notLanded, '+ 4 not landed');
    assert.deepEqual(comingUpFooter({...line, tracks: []}, new Map(), 0), {
        landed: null,
        parked: null,
        notLanded: null,
    });
});

test("a card's kind says landed, its lane's kind and where it is, or not landed", () => {
    /* Given */
    const state = mergeManagerState([landedPr(1, 30, 'switchboard', HEAD), landedPr(2, 20, 'switchboard')], new Map());
    const lanes = pageLanes(state);
    const groups = statusGroups(lanes, [draft(9)]);
    const items = groups.flatMap((group) => group.items);

    /* When */
    const kinds = Object.fromEntries(items.map((item) => [item.key, itemKind(item, lanes)]));

    /* Then */
    assert.equal(kinds[lanes[0]!.rows[0]!.key], 'Landed · Switchboard lane · head');
    assert.equal(kinds[lanes[0]!.rows[1]!.key], 'Landed · Switchboard lane · 2nd');
    assert.equal(kinds[`${REPO}#9`], 'Not landed');
});

test('the selection on a draft unfolds Drafts; elsewhere or none unfolds nothing', () => {
    /* Given */
    const lanes = pageLanes(mergeManagerState([landedPr(1, 30, 'switchboard', HEAD)], new Map()));
    const groups = statusGroups(lanes, [draft(9)]);

    /* When */
    const onDraft = foldedGroupOf(groups, `${REPO}#9`);

    /* Then */
    assert.equal(onDraft, 'drafts');
    assert.equal(foldedGroupOf(groups, lanes[0]!.rows[0]!.key), null);
    assert.equal(foldedGroupOf(groups, null), null);
});

test("a compact group's rows sit under their repository, in the order the group has them", () => {
    /* Given: two drafts in the lane's repository around one elsewhere */
    const lanes = pageLanes(mergeManagerState([landedPr(1, 30, 'queue', HEAD)], new Map()));
    const items = statusGroups(lanes, [draft(9), {...draft(4), repository: 'movelab/patch'}, draft(7)]).find(
        (group) => group.id === 'drafts',
    )!.items;

    /* When */
    const repos = byRepository(items, lanes);

    /* Then */
    assert.deepEqual(
        repos.map((repo) => [repo.name, repo.lane, repo.items.map((item) => item.key)]),
        [
            ['connect', 'Queue lane', [`${REPO}#9`, `${REPO}#7`]],
            ['patch', null, ['movelab/patch#4']],
        ],
    );
});
