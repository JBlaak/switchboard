import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    markHighlighted,
    markPlain,
    markSplitRows,
    markUnifiedRows,
} from '../src/renderer/ui/session-work/support/change-marks';
import {ensureLanguage, highlightUnifiedRows} from '../src/renderer/ui/session-work/support/highlight';
import {parseUnifiedDiff} from '../src/domain/session-work/diff';
import {splitRows, unifiedRows} from '../src/domain/session-work/diff-layout';
import type {FileRefinement} from '../src/domain/session-work/refinement';

/** The text a line's HTML shows, its tags dropped and its entities decoded. */
function textOf(html: string): string {
    return html
        .replace(/<[^>]*>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&amp;/g, '&');
}

/**
 * The text of each marked stretch, in order: marks a span tag cut in two,
 * with no text between them, count as one stretch.
 */
function markedTexts(html: string): string[] {
    const stretches: string[] = [];
    let inMark = false;
    let joined = false;
    for (const [piece] of html.matchAll(/<[^>]*>|&[^;\s]*;|[\s\S]/g)) {
        if (piece.startsWith('<mark')) inMark = true;
        else if (piece === '</mark>') inMark = false;
        else if (piece.startsWith('<')) continue;
        else if (inMark) {
            if (joined) stretches[stretches.length - 1] += textOf(piece);
            else stretches.push(textOf(piece));
            joined = true;
        } else joined = false;
    }
    return stretches;
}

/** Whether every tag opened in `html` is closed in order. */
function wellFormed(html: string): boolean {
    const open: string[] = [];
    for (const [, closing, name] of html.matchAll(/<(\/?)(span|mark)\b[^>]*>/g)) {
        if (!closing) open.push(name);
        else if (open.pop() !== name) return false;
    }
    return open.length === 0;
}

test('markHighlighted wraps a marked stretch of plain text in a mark of its kind', () => {
    /* Given */
    const html = 'total = price * item.quantity;';

    /* When */
    const out = markHighlighted(html, [{start: 14, end: 29, kind: 'insert'}], 'after');

    /* Then */
    assert.equal(out, 'total = price <mark class="sw-ch is-insert">* item.quantity</mark>;');
});

test('markHighlighted closes a mark before a span tag and opens it again after, so the line stays well formed', () => {
    /* Given */
    const html = '<span class="hljs-keyword">let</span> x = <span class="hljs-number">1</span>;';

    /* When */
    // "t x = 1" crosses out of the keyword span, through text, into the number span.
    const out = markHighlighted(html, [{start: 2, end: 9, kind: 'update'}], 'after');

    /* Then */
    assert.equal(
        out,
        '<span class="hljs-keyword">le<mark class="sw-ch is-update">t</mark></span>' +
            '<mark class="sw-ch is-update"> x = </mark>' +
            '<span class="hljs-number"><mark class="sw-ch is-update">1</mark></span>;',
    );
    assert.ok(wellFormed(out));
    assert.equal(textOf(out), 'let x = 1;');
});

test('markHighlighted counts an entity as one character', () => {
    /* Given */
    const html = 'a &lt; b &amp;&amp; c == &quot;d&#x27;';

    /* When */
    // The text is `a < b && c == "d'`: mark `<`, `&&` and `"d'`.
    const out = markHighlighted(
        html,
        [
            {start: 2, end: 3, kind: 'insert'},
            {start: 6, end: 8, kind: 'insert'},
            {start: 14, end: 17, kind: 'insert'},
        ],
        'after',
    );

    /* Then */
    assert.deepEqual(markedTexts(out), ['<', '&&', '"d\'']);
    assert.equal(textOf(out), 'a < b && c == "d\'');
});

test('markHighlighted clamps marks beyond the line and drops ones left empty', () => {
    /* Given */
    const html = 'abc';

    /* When */
    const out = markHighlighted(
        html,
        [
            {start: 1, end: 99, kind: 'delete'},
            {start: 50, end: 60, kind: 'delete'},
            {start: -4, end: 0, kind: 'delete'},
        ],
        'before',
    );

    /* Then */
    assert.equal(out, 'a<mark class="sw-ch is-delete">bc</mark>');
});

test('markHighlighted sorts marks and trims an overlapping one to where the last ended', () => {
    /* Given */
    const html = 'abcdef';

    /* When */
    const out = markHighlighted(
        html,
        [
            {start: 3, end: 6, kind: 'insert'},
            {start: 0, end: 4, kind: 'update'},
        ],
        'after',
    );

    /* Then */
    assert.equal(out, '<mark class="sw-ch is-update">abcd</mark><mark class="sw-ch is-insert">ef</mark>');
});

test('markHighlighted answers the HTML unchanged when there are no marks to draw', () => {
    /* Given */
    const html = '<span class="hljs-keyword">const</span> x';

    /* When */
    const none = markHighlighted(html, [], 'after');
    const empty = markHighlighted(html, [{start: 3, end: 3, kind: 'insert'}], 'after');

    /* Then */
    assert.equal(none, html);
    assert.equal(empty, html);
});

test('a move says which line it moved from on the new side and to on the old side', () => {
    /* Given */
    const mark = {start: 0, end: 3, kind: 'move' as const, otherLine: 12};

    /* When */
    const after = markHighlighted('foo()', [mark], 'after');
    const before = markHighlighted('foo()', [mark], 'before');

    /* Then */
    assert.equal(after, '<mark class="sw-ch is-move" data-moved-line="12" title="Moved from line 12">foo</mark>()');
    assert.equal(before, '<mark class="sw-ch is-move" data-moved-line="12" title="Moved to line 12">foo</mark>()');
});

test('markPlain escapes the text, then marks it by its own columns', () => {
    /* Given */
    const text = 'if (a < b && c) "x"';

    /* When */
    const out = markPlain(text, [{start: 6, end: 14, kind: 'insert'}], 'after');

    /* Then */
    assert.equal(textOf(out), text);
    assert.deepEqual(markedTexts(out), ['< b && c']);
    assert.doesNotMatch(out.replace(/<\/?mark[^>]*>/g, ''), /[<>"]/);
});

const DIFF = [
    'diff --git a/a.ts b/a.ts',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1,2 +1,2 @@',
    ' const keep = 1;',
    '-let total = price;',
    '+const total = price * item.quantity;',
    '',
].join('\n');

/** `let`→`const` on both sides, and the added factor on line 2 of the new file. */
const REFINEMENT: FileRefinement = {
    summary: null,
    before: {2: [{start: 0, end: 3, kind: 'update'}], 1: [{start: 0, end: 5, kind: 'delete'}]},
    after: {
        2: [
            {start: 0, end: 5, kind: 'update'},
            {start: 20, end: 35, kind: 'insert'},
        ],
        1: [{start: 0, end: 5, kind: 'insert'}],
    },
};

test('unified rows: a deletion takes the old file marks, an addition the new file, context lines none', () => {
    /* Given */
    const rows = unifiedRows(parseUnifiedDiff(DIFF)[0]);

    /* When */
    // No language: plain text, so marked lines become escaped HTML.
    const html = markUnifiedRows(rows, 0, rows.length, null, REFINEMENT)!;

    /* Then */
    assert.equal(html[0], null, 'hunk header');
    assert.equal(html[1], null, 'context line 1 is on both sides but takes no marks');
    assert.deepEqual(markedTexts(html[2]!), ['let']);
    assert.deepEqual(markedTexts(html[3]!), ['const', '* item.quantity']);
});

test('unified rows with highlighting keep it and add the marks; no refinement answers the highlighting as it is', async () => {
    /* Given */
    await ensureLanguage('typescript');
    const rows = unifiedRows(parseUnifiedDiff(DIFF)[0]);
    const highlighted = highlightUnifiedRows(rows, 0, rows.length, 'typescript');

    /* When */
    const marked = markUnifiedRows(rows, 0, rows.length, highlighted, REFINEMENT)!;
    const unmarked = markUnifiedRows(rows, 0, rows.length, highlighted, null);

    /* Then */
    assert.equal(unmarked, highlighted);
    assert.equal(marked[1], highlighted![1]);
    assert.match(marked[3]!, /hljs-keyword/);
    assert.deepEqual(markedTexts(marked[3]!), ['const', '* item.quantity']);
    assert.ok(wellFormed(marked[3]!));
});

test('unified rows: offsets count from start, as the chunk draws them', () => {
    /* Given */
    const rows = unifiedRows(parseUnifiedDiff(DIFF)[0]);

    /* When */
    const part = markUnifiedRows(rows, 2, 4, null, REFINEMENT)!;

    /* Then */
    assert.equal(part.length, 2);
    assert.deepEqual(markedTexts(part[0]!), ['let']);
    assert.deepEqual(markedTexts(part[1]!), ['const', '* item.quantity']);
});

test('split rows: deletions on the left take the old file marks, additions on the right the new file', () => {
    /* Given */
    const rows = splitRows(parseUnifiedDiff(DIFF)[0]);

    /* When */
    const html = markSplitRows(rows, 0, rows.length, null, REFINEMENT)!;

    /* Then */
    assert.equal(html.left[1], null, 'context');
    assert.equal(html.right[1], null, 'context');
    assert.deepEqual(markedTexts(html.left[2]!), ['let']);
    assert.deepEqual(markedTexts(html.right[2]!), ['const', '* item.quantity']);
});
