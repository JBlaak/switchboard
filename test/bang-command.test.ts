import {test} from 'node:test';
import assert from 'node:assert/strict';

import {bangCommandKeys, findBangCommands, type BangCell} from '../src/domain/terminal/bang-command';

const CODE = 'rgb(177,185,249)';

/** A line of cells; text inside [[…]] is drawn in the inline-code colour. */
function line(source: string): BangCell[] {
    const cells: BangCell[] = [];
    let styled = false;
    for (let i = 0; i < source.length; i++) {
        if (source.startsWith('[[', i)) {
            styled = true;
            i++;
            continue;
        }
        if (source.startsWith(']]', i)) {
            styled = false;
            i++;
            continue;
        }
        cells.push({text: source[i], style: styled ? CODE : '', plain: !styled});
    }
    return cells;
}

/** A column on the first line searched. */
function at(col: number, lineIndex = 0) {
    return {line: lineIndex, col};
}

test('inline code ends where its colour does', () => {
    /* Given */
    const cells = line('To push, run [[! git push -u origin nohrd-faq-sync]] in the prompt.');

    /* When */
    const found = findBangCommands([cells]);

    /* Then */
    assert.deepEqual(found, [{start: at(13), end: at(47), command: 'git push -u origin nohrd-faq-sync'}]);
});

test('a code block line runs to the end of the line, past its bullet', () => {
    /* Given */
    const cells = line('⏺ ! git push -u origin nohrd-faq-sync      ');

    /* When */
    const found = findBangCommands([cells]);

    /* Then */
    assert.deepEqual(found, [{start: at(2), end: at(36), command: 'git push -u origin nohrd-faq-sync'}]);
});

test('a command in backticks ends at the closing backtick', () => {
    /* Given */
    const cells = line('Type `! gcloud auth login` then come back.');

    /* When */
    const found = findBangCommands([cells]);

    /* Then */
    assert.deepEqual(found, [{start: at(6), end: at(24), command: 'gcloud auth login'}]);
});

test('every command on a line is found', () => {
    /* Given */
    const cells = line('Run [[! npm ci]] and then [[! npm test]].');

    /* When */
    const found = findBangCommands([cells]);

    /* Then */
    assert.deepEqual(
        found.map((f) => f.command),
        ['npm ci', 'npm test'],
    );
});

test('an exclamation in prose is not a command', () => {
    /* Given */
    const lines = ['Done! git is clean now.', 'That worked ! nice', 'It is !important', '[[!]]', 'Type `! unclosed'];

    /* When */
    const found = lines.map((text) => findBangCommands([line(text)]));

    /* Then */
    assert.deepEqual(found, [[], [], [], [], []]);
});

test('inline code the CLI wrapped goes on onto the next line', () => {
    /* Given */
    const lines = [
        line('  [[! git push --force-with-lease=branch:93b5e7 https://github.com/o/r.git]]   '),
        line('  [[branch]]'),
        line(''),
        line('  It only overwrites the branch.'),
    ];

    /* When */
    const found = findBangCommands(lines);

    /* Then */
    assert.deepEqual(found, [
        {
            start: at(2),
            end: at(7, 1),
            command: 'git push --force-with-lease=branch:93b5e7 https://github.com/o/r.git branch',
        },
    ]);
});

test('inline code wrapped over several lines is one command', () => {
    /* Given */
    const lines = [line('Run [[! echo one]]'), line('  [[two]]'), line('  [[three]] and wait.')];

    /* When */
    const found = findBangCommands(lines);

    /* Then */
    assert.deepEqual(found, [{start: at(4), end: at(6, 2), command: 'echo one two three'}]);
});

test('inline code that stops before the end of its line does not go on', () => {
    /* Given */
    const lines = [line('Run [[! npm ci]] first,'), line('  [[npm test]] second.')];

    /* When */
    const found = findBangCommands(lines);

    /* Then */
    assert.deepEqual(found, [{start: at(4), end: at(11), command: 'npm ci'}]);
});

test('a line after inline code that picks up in another colour does not join it', () => {
    /* Given */
    const lines = [line('Run [[! npm ci]]'), line('  then come back.')];

    /* When */
    const found = findBangCommands(lines);

    /* Then */
    assert.deepEqual(found, [{start: at(4), end: at(11), command: 'npm ci'}]);
});

test('running a command types !, then the command, then Enter', () => {
    /* When */
    const keys = bangCommandKeys('git push\x1b[A -u origin main');

    /* Then */
    assert.deepEqual(keys, ['!', 'git push[A -u origin main', '\r']);
});
