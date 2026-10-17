import { test } from 'node:test';
import assert from 'node:assert/strict';

import { enterKittySequence, shouldSendSpaceDirectly } from '../src/renderer/features/terminal/terminal-input';

// Build an Enter keydown-like event with sensible defaults (no modifiers).
function enter(overrides: Record<string, unknown> = {}): KeyboardEvent {
  return {
    key: 'Enter', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...overrides,
  } as unknown as KeyboardEvent;
}

// Build a keydown-like event with sensible defaults (plain Space, no IME).
// Only the fields the predicate reads; cast so the call site stays honest about
// what a real KeyboardEvent is.
function kd(overrides: Record<string, unknown> = {}): KeyboardEvent {
  return {
    key: ' ',
    type: 'keydown',
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    keyCode: 32,
    ...overrides,
  } as unknown as KeyboardEvent;
}

test('plain Space (no IME) is sent directly to the PTY for push-to-talk key-repeat', () => {
  // The reason the direct-send path exists (#22): xterm's keydown path drops
  // plain Space, breaking Claude Code's "Hold Space to record".
  /* When */
  const direct = shouldSendSpaceDirectly(kd());

  /* Then */
  assert.equal(direct, true);
});

test('Space during IME composition is NOT sent directly (isComposing)', () => {
  // Regression fix: intercepting this Space with preventDefault dropped/mangled
  // the in-progress Hangul syllable. Must defer to xterm's composition helper.
  /* When */
  const direct = shouldSendSpaceDirectly(kd({ isComposing: true }));

  /* Then */
  assert.equal(direct, false);
});

test('Space during IME composition is NOT sent directly (keyCode 229 sentinel)', () => {
  // Chromium reports keyCode 229 for keydowns consumed by the IME, and some
  // IMEs do not set isComposing on the committing keystroke.
  /* When */
  const direct = shouldSendSpaceDirectly(kd({ keyCode: 229 }));

  /* Then */
  assert.equal(direct, false);
});

test('Space combined with a modifier is not the push-to-talk path', () => {
  /* Given */
  const modifiers = ['ctrlKey', 'metaKey', 'altKey', 'shiftKey'];

  for (const modifier of modifiers) {
    /* When */
    const direct = shouldSendSpaceDirectly(kd({ [modifier]: true }));

    /* Then */
    assert.equal(direct, false, modifier);
  }
});

test('non-Space keys are never on the direct-send path', () => {
  /* When */
  const direct = shouldSendSpaceDirectly(kd({ key: 'a', keyCode: 65 }));

  /* Then */
  assert.equal(direct, false);
});

test('Shift+Enter → CSI 13;2u (newline, not submit) on every platform', () => {
  /* When */
  const sequence = enterKittySequence(enter({ shiftKey: true }));

  /* Then */
  assert.equal(sequence, '\x1b[13;2u');
});

test('Ctrl+Enter → CSI 13;5u ("send now") on every platform', () => {
  // Regression: mac used to fall through to xterm (bare \r), so Claude Code could
  // not tell it apart from a plain Enter and "send now" never fired.
  /* When */
  const sequence = enterKittySequence(enter({ ctrlKey: true }));

  /* Then */
  assert.equal(sequence, '\x1b[13;5u');
});

test('plain Enter is left to xterm (bare \\r submit)', () => {
  /* When */
  const sequence = enterKittySequence(enter());

  /* Then */
  assert.equal(sequence, null);
});

test('Enter with Alt or Cmd falls through to xterm', () => {
  /* Given */
  const combos: Record<string, boolean>[] = [
    { altKey: true },
    { metaKey: true },
    { ctrlKey: true, metaKey: true },
  ];

  for (const combo of combos) {
    /* When */
    const sequence = enterKittySequence(enter(combo));

    /* Then */
    assert.equal(sequence, null, JSON.stringify(combo));
  }
});

test('Ctrl+Shift+Enter is not translated (ambiguous combo falls through)', () => {
  /* When */
  const sequence = enterKittySequence(enter({ ctrlKey: true, shiftKey: true }));

  /* Then */
  assert.equal(sequence, null);
});

test('non-Enter keys are never given an Enter sequence', () => {
  /* When */
  const sequence = enterKittySequence(enter({ key: 'a', ctrlKey: true }));

  /* Then */
  assert.equal(sequence, null);
});
