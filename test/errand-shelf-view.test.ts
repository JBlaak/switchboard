/** The Errands shelf as drawn: its header, folded and open, its rows, and the session header's errand strip. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import './support/static-markup-dom';
import {ErrandShelfView} from '../src/renderer/ui/session-list/ErrandShelf';
import {ErrandStripContent} from '../src/renderer/ui/terminal/ErrandStrip';
import {
    errandPlace,
    errandPullRequestUrl,
    errandRowName,
    errandShelfSummary,
} from '../src/renderer/ui/session-list/errand-view';
import type {ErrandShelfActions, ErrandShelfViewProps} from '../src/renderer/ui/session-list/ErrandShelf';
import type {ErrandEntry} from '../src/domain/session/errand-shelf';
import type {LaidErrand} from '../src/renderer/state/session-list-layout';
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
        doing: 'fixing checks',
        needsYou: false,
        host: null,
        ...fields,
    };
}

function laid(entry: ErrandEntry, startedHoursAgo = 1): LaidErrand {
    const session = {
        sessionId: entry.sessionId,
        created: new Date(NOW - startedHoursAgo * HOUR).toISOString(),
        modified: new Date(NOW).toISOString(),
    } as SessionRow;
    return {entry: {kind: 'row', id: 'er-' + entry.sessionId, session, projectPath: '/p'}, errand: entry};
}

const NO_ACTIONS: ErrandShelfActions = {toggle() {}, open() {}, openPullRequest() {}, stop() {}, archive() {}};

function render(props: Partial<ErrandShelfViewProps>): string {
    return renderToStaticMarkup(
        createElement(ErrandShelfView, {
            errands: [],
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

/** The ids of the rows outside the folding body, then inside it. */
function rowIds(html: string): {always: string[]; folding: string[]} {
    const [before, body = ''] = html.split('class="errand-shelf-body');
    const ids = (part: string): string[] =>
        [...part.matchAll(/class="errand-row[^"]*" id="([^"]+)"/g)].map((m) => m[1]);
    return {always: ids(before), folding: ids(body)};
}

// ── The shelf ──

test('with no errand the shelf is not drawn at all', () => {
    /* When */
    const html = render({errands: []});

    /* Then */
    assert.equal(html, '');
});

test('the header is a button saying how many errands there are and how many are running', () => {
    /* Given */
    const errands = [laid(errand('a')), laid(errand('b', {kind: 'nudge', doing: 'nudging the reviewer'}))];

    /* When */
    const html = render({errands, open: false});

    /* Then */
    assert.match(
        html,
        /<button type="button" class="errand-shelf-header is-folded" id="errand-shelf-header" aria-expanded="false"/,
    );
    assert.match(html, /<span class="errand-shelf-label">Errands<\/span>/);
    assert.match(html, /<span class="errand-shelf-count">2<\/span>/);
    assert.match(
        html,
        /<span class="errand-shelf-summary"><span class="errand-shelf-dot" aria-hidden="true"><\/span>2 running<\/span>/,
    );
});

test('when an errand needs you the header says so in red instead', () => {
    /* Given */
    const errands = [laid(errand('a', {needsYou: true, doing: 'stopped'})), laid(errand('b')), laid(errand('c'))];

    /* When */
    const html = render({errands, open: true});

    /* Then */
    assert.match(html, /aria-expanded="true"/);
    assert.match(html, /class="errand-shelf-summary is-needs-you">.*1 needs you<\/span>/);
});

test('folded, only the errands that need you stay out; the rest fold away under the header', () => {
    /* Given */
    const errands = [laid(errand('a', {needsYou: true})), laid(errand('b')), laid(errand('c'))];

    /* When */
    const html = render({errands, open: false});

    /* Then */
    assert.deepEqual(rowIds(html), {always: ['er-a'], folding: ['er-b', 'er-c']});
    assert.match(html, /class="errand-shelf-body is-folded" id="errand-shelf-body" inert=""/);
});

test('open, every errand shows', () => {
    /* Given */
    const errands = [laid(errand('a', {needsYou: true})), laid(errand('b'))];

    /* When */
    const html = render({errands, open: true});

    /* Then */
    assert.deepEqual(rowIds(html), {always: ['er-a'], folding: ['er-b']});
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

test('the summary counts the errands that need you, or else all of them as running', () => {
    /* Given */
    const calm = [laid(errand('a')), laid(errand('b'))];
    const stuck = [laid(errand('a', {needsYou: true})), laid(errand('b', {needsYou: true})), laid(errand('c'))];

    /* When */
    const summaries = [errandShelfSummary(calm), errandShelfSummary(stuck)];

    /* Then */
    assert.deepEqual(summaries, [
        {text: '2 running', needsYou: false},
        {text: '2 needs you', needsYou: true},
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

test('a row on its way out is marked as leaving', () => {
    /* Given */
    const errands = [laid(errand('a')), laid(errand('b'))];

    /* When */
    const html = render({errands, open: true, leaving: {'er-a': true}});

    /* Then */
    assert.match(html, /id="er-a" data-session-id="a" data-kind="fix" data-leaving=""/);
    assert.doesNotMatch(html, /id="er-b"[^>]*data-leaving/);
});
