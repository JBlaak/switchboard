/** The Automatic shelf as drawn: its header, folded and open, its sections and rows, and the session header's errand strip. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import './support/static-markup-dom';
import {ErrandShelfView} from '../src/renderer/ui/session-list/ErrandShelf';
import {ErrandStripContent} from '../src/renderer/ui/terminal/ErrandStrip';
import {
    automaticShelf,
    errandLead,
    errandPlace,
    errandPullRequestUrl,
    errandRowName,
} from '../src/renderer/ui/session-list/errand-view';
import {errandsBySession} from '../src/domain/session/errand-shelf';
import {EMPTY_MERGE_MANAGER_STATE} from '../src/domain/merge-manager/model';
import {facts, local, run, schedule} from './support/schedule-shelf-fixtures';
import type {ScheduleManagerFacts} from '../src/domain/schedule/manager';
import type {ErrandShelfActions, ErrandShelfViewProps} from '../src/renderer/ui/session-list/ErrandShelf';
import type {ErrandEntry} from '../src/domain/session/errand-shelf';
import {orderErrands, type LaidErrand} from '../src/renderer/state/session-list-layout';
import type {SessionRow} from '../src/domain/session/session';

const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const HOUR = 3_600_000;

function errand(sessionId: string, fields: Partial<ErrandEntry> = {}): ErrandEntry {
    return {
        sessionId,
        kind: 'fix',
        owner: 'merge-manager',
        repository: 'movelab/switchboard',
        number: 431,
        title: null,
        doing: 'fixing checks',
        needsYou: false,
        host: null,
        ...fields,
    } as ErrandEntry;
}

function laid(entry: ErrandEntry, startedHoursAgo = 1): LaidErrand {
    const session = {
        sessionId: entry.sessionId,
        created: new Date(NOW - startedHoursAgo * HOUR).toISOString(),
        modified: new Date(NOW).toISOString(),
    } as SessionRow;
    return {entry: {kind: 'row', id: 'er-' + entry.sessionId, session, projectPath: '/p'}, errand: entry};
}

const NO_ACTIONS: ErrandShelfActions = {
    toggle() {},
    open() {},
    openPullRequest() {},
    stop() {},
    archive() {},
    openSchedule() {},
    markSeen() {},
    markAllSeen() {},
    openMergeManager() {},
};

function render(props: Partial<ErrandShelfViewProps>): string {
    return renderToStaticMarkup(
        createElement(ErrandShelfView, {
            errands: [],
            schedules: null,
            filtering: false,
            open: false,
            cursor: null,
            onScreen: null,
            now: NOW,
            leaving: {},
            actions: NO_ACTIONS,
            ...props,
        }),
    );
}

/** The ids of the session rows outside the folding body, then inside it. */
function rowIds(html: string): {always: string[]; folding: string[]} {
    const [before, body = ''] = html.split('class="errand-shelf-body');
    const ids = (part: string): string[] =>
        [...part.matchAll(/class="errand-row[^"]*" id="([^"]+)"/g)].map((m) => m[1]);
    return {always: ids(before), folding: ids(body)};
}

/** The section labels and row names, top to bottom. */
function lines(html: string): string[] {
    return [...html.matchAll(/class="errand-shelf-section">([^<]+)<|class="errand-row-name">([^<]+)</g)].map(
        (m) => m[1] ?? m[2],
    );
}

// ── The shelf ──

test('with no errand, no run and no schedule on, the shelf is not drawn at all', () => {
    /* When */
    const html = render({errands: []});

    /* Then */
    assert.equal(html, '');
});

test('the header is a button saying "Automatic", how many rows it holds and how many are running', () => {
    /* Given */
    const errands = [laid(errand('a')), laid(errand('b', {kind: 'nudge', doing: 'nudging the reviewer'}))];

    /* When */
    const html = render({errands, open: false});

    /* Then */
    assert.match(
        html,
        /<button type="button" class="errand-shelf-header is-folded" id="errand-shelf-header" aria-expanded="false"/,
    );
    assert.match(html, /<span class="errand-shelf-label">Automatic<\/span>/);
    assert.match(html, /<span class="errand-shelf-count">2<\/span>/);
    assert.match(html, /<span class="errand-shelf-summary"><span class="errand-shelf-rest">2 running<\/span><\/span>/);
});

test('when an errand needs you the header says so in red first', () => {
    /* Given */
    const errands = [laid(errand('a', {needsYou: true, doing: 'stopped'})), laid(errand('b')), laid(errand('c'))];

    /* When */
    const html = render({errands, open: true});

    /* Then */
    assert.match(html, /aria-expanded="true"/);
    assert.match(
        html,
        /<span class="errand-shelf-needs-you">1 needs you<\/span><span class="errand-shelf-rest">· 2 running<\/span>/,
    );
});

test('folded, the shelf is one line: every row folds away under the header, the ones that need you too', () => {
    /* Given */
    const errands = [laid(errand('a', {needsYou: true})), laid(errand('b')), laid(errand('c'))];

    /* When */
    const html = render({errands, open: false});

    /* Then: a asks in Blocked instead */
    assert.deepEqual(rowIds(html), {always: [], folding: ['er-a', 'er-b', 'er-c']});
    assert.match(html, /class="errand-shelf-body is-folded" id="errand-shelf-body" inert=""/);
});

test('open, every errand shows under Running', () => {
    /* Given */
    const errands = [laid(errand('a', {needsYou: true})), laid(errand('b'))];

    /* When */
    const html = render({errands, open: true});

    /* Then */
    assert.deepEqual(rowIds(html), {always: [], folding: ['er-a', 'er-b']});
    assert.deepEqual(lines(html), ['Running', '#431 · fixing checks', '#431 · fixing checks']);
    assert.match(html, /class="errand-shelf-body" id="errand-shelf-body"/);
    assert.doesNotMatch(html, /inert/);
});

// ── A row ──

test('a row shows its kind, the PR and what it does, and where it runs with its age', () => {
    /* Given */
    const errands = [laid(errand('a', {number: 512, doing: 'rebasing'}), 3)];

    /* When */
    const html = render({errands});

    /* Then */
    assert.match(html, /<svg class="errand-row-glyph" data-kind="fix"/);
    assert.match(html, /<span class="errand-row-name">#512 · rebasing<\/span>/);
    assert.match(html, /<span class="errand-row-meta">switchboard · 3h ago<\/span>/);
    assert.match(html, />PR ↗<\/button>/);
    assert.match(html, />Stop<\/button>/);
    assert.match(html, /<button type="button" class="errand-row-btn session-archive-btn" title="Archive"/);
});

test('a nudge is drawn as a paper plane, and an errand on a VM names the VM', () => {
    /* Given */
    const errands = [laid(errand('a', {kind: 'nudge', host: 'build-vm'}))];

    /* When */
    const html = render({errands});

    /* Then */
    assert.match(html, /data-kind="nudge"/);
    assert.match(html, /<span class="errand-row-meta">build-vm · 1h ago<\/span>/);
});

test('the session on screen, a stuck errand and the keyboard cursor each mark their row', () => {
    /* Given */
    const errands = [laid(errand('a', {needsYou: true})), laid(errand('b')), laid(errand('c'))];

    /* When */
    const html = render({errands, open: true, onScreen: 'b', cursor: 'er-c'});

    /* Then */
    assert.match(html, /class="errand-row needs-you" id="er-a"/);
    assert.match(html, /class="errand-row active" id="er-b"/);
    assert.match(html, /class="errand-row kbd-cursor" id="er-c"/);
});

test('the keyboard cursor on the header rings it', () => {
    /* Given */
    const errands = [laid(errand('a'))];

    /* When */
    const html = render({errands, open: true, cursor: 'errand-shelf-header'});

    /* Then */
    assert.match(html, /class="errand-shelf-header kbd-cursor"/);
});

// ── What a row says ──

test('an errand row is named after its PR and what it is doing', () => {
    /* When */
    const name = errandRowName(errand('a', {number: 7, doing: 'stopped: asks'}));

    /* Then */
    assert.equal(name, '#7 · stopped: asks');
});

test('it runs on the VM merging was handed to, or in the repository on this Mac', () => {
    /* When */
    const places = [errandPlace(errand('a')), errandPlace(errand('b', {host: 'vm-1'}))];

    /* Then */
    assert.deepEqual(places, ['switchboard', 'vm-1']);
});

test('PR ↗ opens the pull request on GitHub', () => {
    /* When */
    const url = errandPullRequestUrl(errand('a', {number: 99}));

    /* Then */
    assert.equal(url, 'https://github.com/movelab/switchboard/pull/99');
});

test('the summary counts the errands that need you apart from the ones running', () => {
    /* Given */
    const calm = [laid(errand('a')), laid(errand('b'))];
    const stuck = [laid(errand('a', {needsYou: true})), laid(errand('b', {needsYou: true})), laid(errand('c'))];

    /* When */
    const summaries = [
        automaticShelf(calm, null, NOW, false)?.summary,
        automaticShelf(stuck, null, NOW, false)?.summary,
    ];

    /* Then */
    assert.deepEqual(summaries, [
        {needsYou: null, rest: '2 running'},
        {needsYou: '2 needs you', rest: '1 running'},
    ]);
});

// ── The session header's strip ──

test('the header strip says whose errand it is and what it does, "Errand" in bold', () => {
    /* Given */
    const entry = errand('a', {owner: 'queue', kind: 'nudge', doing: 'nudging the reviewer', number: 12});

    /* When */
    const html = renderToStaticMarkup(createElement(ErrandStripContent, {errand: entry}));

    /* Then */
    assert.match(html, /data-kind="nudge"/);
    assert.match(
        html,
        /<span class="errand-strip-text"><strong>Errand<\/strong> for the merge queue · nudging the reviewer on #12 · archives itself<\/span>/,
    );
});

// ── A triage ──

const TRIAGE: Partial<ErrandEntry> = {
    kind: 'triage',
    owner: 'bug-manager',
    number: null,
    title: 'TypeError: Cannot read properties of undefined (reading x)',
    doing: 'triaging',
};

test('a triage row shows a magnifier, "Triage · " and the short title, and offers no PR ↗', () => {
    /* Given */
    const errands = [laid(errand('t', TRIAGE), 2)];

    /* When */
    const html = render({errands});

    /* Then */
    assert.match(html, /<svg class="errand-row-glyph" data-kind="triage"[^>]*><circle/);
    assert.match(html, /<span class="errand-row-name">Triage · TypeError: Cannot read properties of un…<\/span>/);
    assert.match(html, /<span class="errand-row-meta">switchboard · 2h ago<\/span>/);
    assert.doesNotMatch(html, /PR ↗/);
    assert.match(html, />Stop<\/button>/);
});

test('a stuck triage is marked like any stuck errand', () => {
    /* Given */
    const errands = [laid(errand('t', {...TRIAGE, doing: 'stopped', needsYou: true})), laid(errand('b'))];

    /* When */
    const html = render({errands, open: true});

    /* Then */
    assert.match(html, /class="errand-row needs-you" id="er-t"/);
    assert.match(html, /1 needs you/);
});

test('a triage is named after its bug, and has no pull request to open', () => {
    /* Given */
    const entry = errand('t', {...TRIAGE, title: 'RangeError: bad length'});

    /* When */
    const name = errandRowName(entry);
    const url = errandPullRequestUrl(entry);

    /* Then */
    assert.equal(name, 'Triage · RangeError: bad length');
    assert.equal(url, null);
});

test('the header strip of a triage names the Bug manager and the bug', () => {
    /* Given */
    const entry = errand('t', {...TRIAGE, title: 'RangeError: bad length'});

    /* When */
    const html = renderToStaticMarkup(createElement(ErrandStripContent, {errand: entry}));

    /* Then */
    assert.match(html, /data-kind="triage"/);
    assert.match(
        html,
        /<strong>Errand<\/strong> for the Bug manager · triaging RangeError: bad length · archives itself<\/span>/,
    );
});

test('a row on its way out is marked as leaving', () => {
    /* Given */
    const errands = [laid(errand('a')), laid(errand('b'))];

    /* When */
    const html = render({errands, open: true, leaving: {'er-a': true}});

    /* Then */
    assert.match(html, /id="er-a" data-session-id="a" data-kind="fix" data-leaving=""/);
    assert.doesNotMatch(html, /id="er-b"[^>]*data-leaving/);
});

// ── Scheduled runs and schedules ──

/** The shelf's session rows for the runs `world` lists, in the layout's order. */
function runRows(world: ScheduleManagerFacts, extra: readonly LaidErrand[] = []): LaidErrand[] {
    const index = errandsBySession(EMPTY_MERGE_MANAGER_STATE, {}, [], world);
    return orderErrands([...extra, ...[...index.values()].map((entry) => laid(entry))]);
}

const SWEEP = schedule('sweep', {settings: {name: 'Bugsnag sweep'}, nextRunAt: local(3, 0, 24)});
const NOTES = schedule('notes', {settings: {name: 'Release notes'}, nextRunAt: local(4, 0, 24)});

test('with nothing listed but a schedule on, the folded line says when the night starts', () => {
    /* Given */
    const world = facts([schedule('weekly', {nextRunAt: local(3, 0, 30)})]);

    /* When */
    const html = render({schedules: world, now: local(12)});

    /* Then */
    assert.match(html, /<span class="errand-shelf-label">Automatic<\/span>/);
    assert.doesNotMatch(html, /errand-shelf-count/);
    assert.match(html, /<span class="errand-shelf-rest">next Mon 03:00<\/span>/);
});

test('with every schedule off and nothing listed, the shelf hides; while filtering, it always does', () => {
    /* Given */
    const off = facts([schedule('a', {settings: {enabled: false}})]);
    const on = facts([SWEEP]);

    /* When */
    const html = [render({schedules: off}), render({schedules: on, filtering: true})];

    /* Then */
    assert.deepEqual(html, ['', '']);
});

test('at night: Running holds the runs and the errands going now, then Coming up the next two times', () => {
    /* Given */
    const world = facts(
        [SWEEP, NOTES, schedule('hours', {settings: {name: 'Log my hours'}, nextRunAt: local(6, 30, 24)})],
        [run('r-1', 'sweep', {status: 'running', dueAt: local(3, 0, 24), endedAt: null})],
    );
    const errands = runRows(world, [laid(errand('fix', {number: 514}))]);

    /* When */
    const html = render({errands, schedules: world, open: true, now: local(3, 10, 24)});

    /* Then */
    assert.deepEqual(lines(html), [
        'Running',
        '#514 · fixing checks',
        'Bugsnag sweep · 03:00',
        'Coming up',
        'Release notes',
        'Log my hours',
    ]);
    assert.match(html, /<span class="errand-shelf-count">4<\/span>/);
    assert.match(html, /<span class="errand-shelf-rest">2 running · next 04:00<\/span>/);
    assert.match(html, /class="errand-row is-coming-up" data-schedule-key="notes"/);
    assert.match(html, /<span class="errand-row-meta">04:00<\/span>/);
});

test('in the morning: Last night lists the unread runs newest first, one that needs you in red; 03:00 is too far for Coming up', () => {
    /* Given */
    const world = facts(
        [SWEEP, NOTES],
        [
            run('limit', 'sweep', {status: 'limit', endedAt: local(3, 20), reason: 'its 20 min limit'}),
            run('notes', 'notes', {report: 'Draft updated', endedAt: local(4, 5)}),
            run('quiet', 'notes', {report: 'Nothing new', seen: true, endedAt: local(4, 1)}),
        ],
    );

    /* When */
    const html = render({errands: runRows(world), schedules: world, open: true, now: local(9)});

    /* Then */
    assert.deepEqual(lines(html), ['Last night', 'Release notes · Draft updated', 'Bugsnag sweep · limit hit']);
    assert.match(html, /class="errand-row needs-you" id="er-s-limit"/);
    assert.match(
        html,
        /<span class="errand-shelf-needs-you">1 needs you<\/span><span class="errand-shelf-rest">· 2 to read<\/span>/,
    );
});

test('a run that ended shows an unread dot instead of its age, with no Stop', () => {
    /* Given */
    const world = facts([SWEEP], [run('r', 'sweep')]);

    /* When */
    const html = render({errands: runRows(world), schedules: world, open: true, now: local(9)});

    /* Then */
    assert.match(html, /<svg class="errand-row-glyph" data-kind="scheduled"/);
    assert.match(html, /<span class="errand-row-unread" aria-label="Not read yet"><\/span>/);
    assert.doesNotMatch(html, />Stop</);
    assert.doesNotMatch(html, /errand-row-meta/);
});

test('a missed run, which has no session, still shows under Last night and needs you', () => {
    /* Given */
    const world = facts(
        [SWEEP],
        [run('m', 'sweep', {status: 'missed', sessionId: null, startedAt: null, endedAt: null, dueAt: local(3)})],
    );

    /* When */
    const html = render({errands: runRows(world), schedules: world, open: true, now: local(9)});

    /* Then */
    assert.match(html, /class="errand-row is-run needs-you" data-run-id="m" data-kind="scheduled"/);
    assert.deepEqual(lines(html).slice(0, 2), ['Last night', 'Bugsnag sweep · missed']);
    assert.match(html, /1 needs you/);
});

test('the links: Mark all read while there is something to read, the Schedule manager, and the Merge manager for its errands', () => {
    /* Given */
    const world = facts([SWEEP], [run('r', 'sweep')]);
    const errands = runRows(world, [laid(errand('fix'))]);

    /* When */
    const html = render({errands, schedules: world, open: true, now: local(9)});

    /* Then */
    assert.deepEqual(
        [...html.matchAll(/class="errand-shelf-link">([^<]+)</g)].map((m) => m[1]),
        ['Mark all read', 'Schedule manager', 'Merge manager'],
    );
});

test('a scheduled run in Blocked leads its meta line with "scheduled" and why', () => {
    /* Given */
    const world = facts([SWEEP], [run('r', 'sweep', {status: 'limit', reason: 'its 20 min limit'})]);
    const [entry] = errandsBySession(EMPTY_MERGE_MANAGER_STATE, {}, [], world).values();

    /* When */
    const leads = [errandLead(entry), errandLead(errand('a'))];

    /* Then */
    assert.deepEqual(leads, ['scheduled · its 20 min limit', 'errand']);
});

test('the header strip of a scheduled run says whose run it is, "Scheduled run" in bold', () => {
    /* Given */
    const world = facts([SWEEP], [run('r', 'sweep', {status: 'done', endedAt: local(3, 14)})]);
    const [entry] = errandsBySession(EMPTY_MERGE_MANAGER_STATE, {}, [], world).values();

    /* When */
    const html = renderToStaticMarkup(createElement(ErrandStripContent, {errand: entry}));

    /* Then */
    assert.match(html, /data-kind="scheduled"/);
    assert.match(html, /<strong>Scheduled run<\/strong> of Bugsnag sweep · done at 03:14<\/span>/);
});
