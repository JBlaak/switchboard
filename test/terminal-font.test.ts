import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeTerminalFont, DEFAULT_TERMINAL_FONT_FAMILY as DEFAULT_FAMILY } from '../src/renderer/features/terminal/terminal-input';

const DEFAULT_FONT = { fontFamily: DEFAULT_FAMILY, fontSize: 12, lineHeight: 1 };

test('unset font settings fall back to the defaults', () => {
  /* When */
  const font = normalizeTerminalFont();

  /* Then */
  assert.deepEqual(font, DEFAULT_FONT);
});

test('empty font settings fall back to the defaults', () => {
  /* Given */
  const settings = { fontFamily: '', fontSize: undefined, lineHeight: null };

  /* When */
  const font = normalizeTerminalFont(settings);

  /* Then */
  assert.deepEqual(font, DEFAULT_FONT);
});

test('a blank/whitespace font family never reaches xterm', () => {
  // An empty family would leave the terminal with no font stack at all.
  /* When */
  const font = normalizeTerminalFont({ fontFamily: '   ' });

  /* Then */
  assert.equal(font.fontFamily, DEFAULT_FAMILY);
});

test('the chosen family keeps the default monospace stack behind it', () => {
  // A family the browser can't resolve is not a CSS error — it silently falls back to
  // the default PROPORTIONAL font, which wrecks the terminal's column alignment.
  /* Given */
  const cases: [string, string][] = [
    ['  Menlo  ', 'Menlo, ' + DEFAULT_FAMILY],
    ["'Mono Lisa'", "'Mono Lisa', " + DEFAULT_FAMILY],
  ];

  for (const [fontFamily, expected] of cases) {
    /* When */
    const font = normalizeTerminalFont({ fontFamily });

    /* Then */
    assert.equal(font.fontFamily, expected);
  }
});

test('every stack ends in a monospace font, whatever the user typed', () => {
  /* When */
  const font = normalizeTerminalFont({ fontFamily: 'kapot' });

  /* Then */
  assert.match(font.fontFamily, /monospace$/);
});

test('the default stack is not appended to itself', () => {
  /* When */
  const font = normalizeTerminalFont({ fontFamily: DEFAULT_FAMILY });

  /* Then */
  assert.equal(font.fontFamily, DEFAULT_FAMILY);
});

test('numeric settings arrive from number inputs as strings', () => {
  /* When */
  const font = normalizeTerminalFont({ fontSize: '14', lineHeight: '1.25' });

  /* Then */
  assert.equal(font.fontSize, 14);
  assert.equal(font.lineHeight, 1.25);
});

test('line height is clamped to at least 1 — xterm throws below that', () => {
  /* Given */
  const cases: [number, number][] = [[0.8, 1], [-2, 1], [99, 3]];

  for (const [lineHeight, expected] of cases) {
    /* When */
    const font = normalizeTerminalFont({ lineHeight });

    /* Then */
    assert.equal(font.lineHeight, expected);
  }
});

test('font size is clamped to a legible range', () => {
  /* Given */
  const cases: [number, number][] = [[2, 6], [500, 32]];

  for (const [fontSize, expected] of cases) {
    /* When */
    const font = normalizeTerminalFont({ fontSize });

    /* Then */
    assert.equal(font.fontSize, expected);
  }
});

test('garbage values fall back instead of producing NaN', () => {
  /* When */
  const font = normalizeTerminalFont({ fontSize: 'abc', lineHeight: 'x' });

  /* Then */
  assert.equal(font.fontSize, 12);
  assert.equal(font.lineHeight, 1);
});
