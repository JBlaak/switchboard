import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bangCommandKeys, findBangCommands, type BangCell } from '../src/domain/terminal/bang-command';

const CODE = 'rgb(177,185,249)';

/** A line of cells; text inside [[…]] is drawn in the inline-code colour. */
function line(source: string): BangCell[] {
  const cells: BangCell[] = [];
  let styled = false;
  for (let i = 0; i < source.length; i++) {
    if (source.startsWith('[[', i)) { styled = true; i++; continue; }
    if (source.startsWith(']]', i)) { styled = false; i++; continue; }
    cells.push({ text: source[i], style: styled ? CODE : '', plain: !styled });
  }
  return cells;
}

test('inline code ends where its colour does', () => {
  /* Given */
  const cells = line('To push, run [[! git push -u origin nohrd-faq-sync]] in the prompt.');

  /* When */
  const found = findBangCommands(cells);

  /* Then */
  assert.deepEqual(found, [{ start: 13, end: 47, command: 'git push -u origin nohrd-faq-sync' }]);
});

test('a code block line runs to the end of the line, past its bullet', () => {
  /* Given */
  const cells = line('⏺ ! git push -u origin nohrd-faq-sync      ');

  /* When */
  const found = findBangCommands(cells);

  /* Then */
  assert.deepEqual(found, [{ start: 2, end: 36, command: 'git push -u origin nohrd-faq-sync' }]);
});

test('a command in backticks ends at the closing backtick', () => {
  /* Given */
  const cells = line('Type `! gcloud auth login` then come back.');

  /* When */
  const found = findBangCommands(cells);

  /* Then */
  assert.deepEqual(found, [{ start: 6, end: 24, command: 'gcloud auth login' }]);
});

test('every command on a line is found', () => {
  /* Given */
  const cells = line('Run [[! npm ci]] and then [[! npm test]].');

  /* When */
  const found = findBangCommands(cells);

  /* Then */
  assert.deepEqual(found.map(f => f.command), ['npm ci', 'npm test']);
});

test('an exclamation in prose is not a command', () => {
  /* Given */
  const lines = [
    'Done! git is clean now.',
    'That worked ! nice',
    'It is !important',
    '[[!]]',
    'Type `! unclosed',
  ];

  /* When */
  const found = lines.map(text => findBangCommands(line(text)));

  /* Then */
  assert.deepEqual(found, [[], [], [], [], []]);
});

test('running a command types !, then the command, then Enter', () => {
  /* When */
  const keys = bangCommandKeys('git push\x1b[A -u origin main');

  /* Then */
  assert.deepEqual(keys, ['!', 'git push[A -u origin main', '\r']);
});
