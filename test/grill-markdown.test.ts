import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inlineMarkdown, markdownBlocks} from '../src/renderer/features/grill/grill-markdown';

test('inline Markdown reads code, bold, italics and links into runs', () => {
    /* When */
    const runs = inlineMarkdown('Keep `sessions` **as is**, *mostly*; see [#98](https://x/98).');

    /* Then */
    assert.deepEqual(runs, [
        {kind: 'text', text: 'Keep '},
        {kind: 'code', text: 'sessions'},
        {kind: 'text', text: ' '},
        {kind: 'strong', text: 'as is'},
        {kind: 'text', text: ', '},
        {kind: 'em', text: 'mostly'},
        {kind: 'text', text: '; see '},
        {kind: 'link', text: '#98', href: 'https://x/98'},
        {kind: 'text', text: '.'},
    ]);
});

test('a lone asterisk stays text', () => {
    /* When */
    const runs = inlineMarkdown('2 * 3 is six');

    /* Then */
    assert.deepEqual(runs, [{kind: 'text', text: '2 * 3 is six'}]);
});

test('blank lines split paragraphs and single newlines keep their lines', () => {
    /* When */
    const blocks = markdownBlocks('One\ntwo\n\nThree');

    /* Then */
    assert.deepEqual(blocks, [
        {
            kind: 'paragraph',
            lines: [[{kind: 'text', text: 'One'}], [{kind: 'text', text: 'two'}]],
        },
        {kind: 'paragraph', lines: [[{kind: 'text', text: 'Three'}]]},
    ]);
});

test('a block of bullets or numbers is a list', () => {
    /* When */
    const blocks = markdownBlocks('- a\n- b\n\n1. c\n2. d');

    /* Then */
    assert.deepEqual(blocks, [
        {kind: 'list', ordered: false, items: [[{kind: 'text', text: 'a'}], [{kind: 'text', text: 'b'}]]},
        {kind: 'list', ordered: true, items: [[{kind: 'text', text: 'c'}], [{kind: 'text', text: 'd'}]]},
    ]);
});

test('a pipe table is a table, with its alignment and ragged rows padded', () => {
    /* Given */
    const text =
        'Here is my split.\n\n| Action | Admin | Member |\n|---|:-:|--:|\n| Edit `club` | ✅ | ❌ |\n| Claim | instantly |';

    /* When */
    const blocks = markdownBlocks(text);

    /* Then */
    assert.deepEqual(blocks, [
        {kind: 'paragraph', lines: [[{kind: 'text', text: 'Here is my split.'}]]},
        {
            kind: 'table',
            align: [null, 'center', 'right'],
            header: [
                [{kind: 'text', text: 'Action'}],
                [{kind: 'text', text: 'Admin'}],
                [{kind: 'text', text: 'Member'}],
            ],
            rows: [
                [
                    [
                        {kind: 'text', text: 'Edit '},
                        {kind: 'code', text: 'club'},
                    ],
                    [{kind: 'text', text: '✅'}],
                    [{kind: 'text', text: '❌'}],
                ],
                [[{kind: 'text', text: 'Claim'}], [{kind: 'text', text: 'instantly'}], []],
            ],
        },
    ]);
});

test('a table with no blank line around it is lifted out of its paragraph', () => {
    /* When */
    const blocks = markdownBlocks('Before\n| a | b |\n| - | - |\n| `x|y` | z \\| w |\nAfter');

    /* Then */
    assert.deepEqual(blocks, [
        {kind: 'paragraph', lines: [[{kind: 'text', text: 'Before'}]]},
        {
            kind: 'table',
            align: [null, null],
            header: [[{kind: 'text', text: 'a'}], [{kind: 'text', text: 'b'}]],
            rows: [[[{kind: 'code', text: 'x|y'}], [{kind: 'text', text: 'z | w'}]]],
        },
        {kind: 'paragraph', lines: [[{kind: 'text', text: 'After'}]]},
    ]);
});

test('pipes without a divider row stay text', () => {
    /* When */
    const blocks = markdownBlocks('a | b\nc | d');

    /* Then */
    assert.deepEqual(blocks, [
        {kind: 'paragraph', lines: [[{kind: 'text', text: 'a | b'}], [{kind: 'text', text: 'c | d'}]]},
    ]);
});
