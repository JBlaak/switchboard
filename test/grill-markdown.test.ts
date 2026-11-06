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
