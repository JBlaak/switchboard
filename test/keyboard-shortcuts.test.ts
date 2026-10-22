import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isArchiveSessionKey, isBareQuickSessionKey, isQuickSessionKey, isSessionNavKey, isSessionPickerKey,
  isProjectSettingsKey, isSidebarFocusKey, isSidebarToggleKey, listCursorKey, sessionNavDirection,
} from '../src/renderer/lib/shortcut-keys';

/** Where a key lands: nowhere in particular, a text field, or xterm's own textarea. */
type Landing = 'page' | 'textField' | 'terminal';

interface Press {
  key?: string;
  code?: string;
  metaKey?: boolean;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

/** A keydown on `landing`, as much of one as the rules read. */
function keydown(press: Press, landing: Landing = 'page'): KeyboardEvent {
  const target = {
    // xterm's input is a textarea too: the terminal is matched before the text field.
    closest: (selector: string) => (selector === '.xterm' && landing === 'terminal' ? {} : null),
    matches: () => landing !== 'page',
  };
  return {
    key: '', code: '', metaKey: false, shiftKey: false, ctrlKey: false, altKey: false, ...press, target,
  } as unknown as KeyboardEvent;
}

const cmd = (code: string, key = '') => keydown({ code, key, metaKey: true });

// ── Cmd+, ──

test('Cmd+, is the project settings key, in a text field too, and no other chord with the comma is', () => {
  /* Given */
  const presses = [
    cmd('Comma', ','), keydown({ code: 'Comma', key: ',', metaKey: true }, 'textField'),
    keydown({ code: 'Comma', key: ',' }), keydown({ code: 'Comma', key: '<', metaKey: true, shiftKey: true }),
    keydown({ code: 'Comma', key: ',', metaKey: true, altKey: true }), keydown({ code: 'Comma', key: ',', ctrlKey: true }),
  ];

  /* When */
  const results = presses.map(isProjectSettingsKey);

  /* Then */
  assert.deepEqual(results, [true, true, false, false, false, false]);
});

// ── Cmd+L ──

test('Cmd+L is the list key, and nothing else with L is', () => {
  /* Given */
  const presses = [cmd('KeyL'), keydown({ code: 'KeyL' }), keydown({ code: 'KeyL', metaKey: true, shiftKey: true })];

  /* When */
  const listKeys = presses.map(isSidebarFocusKey);

  /* Then */
  assert.deepEqual(listKeys, [true, false, false]);
});

// ── Cmd+S ──

test('Cmd+S toggles the sidebar, wherever the key lands', () => {
  /* Given */
  const presses = [cmd('KeyS'), keydown({ code: 'KeyS', metaKey: true }, 'textField'), keydown({ code: 'KeyS', metaKey: true }, 'terminal')];

  /* When */
  const toggles = presses.map(isSidebarToggleKey);

  /* Then */
  assert.deepEqual(toggles, [true, true, true]);
});

test('S without Cmd, or with another modifier, is no sidebar toggle', () => {
  /* Given */
  const presses = [
    keydown({ code: 'KeyS' }),
    keydown({ code: 'KeyS', metaKey: true, shiftKey: true }),
    keydown({ code: 'KeyS', metaKey: true, altKey: true }),
    keydown({ code: 'KeyS', metaKey: true, ctrlKey: true }),
  ];

  /* When */
  const toggles = presses.map(isSidebarToggleKey);

  /* Then */
  assert.deepEqual(toggles, [false, false, false, false]);
});

// ── Cmd+A and Cmd+E ──

test('Cmd+A opens the picker from the page and from the terminal', () => {
  /* When */
  const fromPage = isSessionPickerKey(cmd('KeyA'));
  const fromTerminal = isSessionPickerKey(keydown({ code: 'KeyA', metaKey: true }, 'terminal'));

  /* Then */
  assert.equal(fromPage, true);
  assert.equal(fromTerminal, true);
});

test('Cmd+A in a text field stays Select All', () => {
  /* When */
  const picked = isSessionPickerKey(keydown({ code: 'KeyA', metaKey: true }, 'textField'));

  /* Then */
  assert.equal(picked, false);
});

test('Cmd+A and Cmd+E take no other modifier', () => {
  /* Given */
  const chords = (code: string) => [
    keydown({ code, metaKey: true, shiftKey: true }),
    keydown({ code, metaKey: true, altKey: true }),
    keydown({ code, metaKey: true, ctrlKey: true }),
    keydown({ code, ctrlKey: true }),
    keydown({ code, altKey: true }),
  ];

  /* When */
  const picker = chords('KeyA').map(isSessionPickerKey);
  const archive = chords('KeyE').map(isArchiveSessionKey);

  /* Then */
  assert.deepEqual(picker, [false, false, false, false, false]);
  assert.deepEqual(archive, [false, false, false, false, false]);
});

test('Cmd+E archives from the page and the terminal, and is left alone in a text field', () => {
  /* When */
  const landings = (['page', 'terminal', 'textField'] as const)
    .map(landing => isArchiveSessionKey(keydown({ code: 'KeyE', metaKey: true }, landing)));

  /* Then */
  assert.deepEqual(landings, [true, true, false]);
});

// ── Quick session ──

test('Cmd+N starts a quick session from anywhere, a terminal and a text field included', () => {
  /* When */
  const landings = (['page', 'terminal', 'textField'] as const)
    .map(landing => isQuickSessionKey(keydown({ code: 'KeyN', metaKey: true }, landing)));

  /* Then */
  assert.deepEqual(landings, [true, true, true]);
});

test('Cmd+N takes no other modifier', () => {
  /* When */
  const chords = [
    keydown({ code: 'KeyN', metaKey: true, shiftKey: true }),
    keydown({ code: 'KeyN', metaKey: true, altKey: true }),
    keydown({ code: 'KeyN', metaKey: true, ctrlKey: true }),
  ].map(isQuickSessionKey);

  /* Then */
  assert.deepEqual(chords, [false, false, false]);
});

test('a bare N starts one only outside the terminal and text fields', () => {
  /* When */
  const landings = (['page', 'terminal', 'textField'] as const)
    .map(landing => isBareQuickSessionKey(keydown({ code: 'KeyN', key: 'n' }, landing)));

  /* Then */
  assert.deepEqual(landings, [true, false, false]);
});

test('N with Shift, Ctrl or Alt is no quick session', () => {
  /* When */
  const chords = [
    keydown({ code: 'KeyN', shiftKey: true }),
    keydown({ code: 'KeyN', ctrlKey: true }),
    keydown({ code: 'KeyN', altKey: true }),
  ].map(e => isBareQuickSessionKey(e) || isQuickSessionKey(e));

  /* Then */
  assert.deepEqual(chords, [false, false, false]);
});

// ── Session navigation ──

test('Cmd+Shift+[ goes back and Cmd+Shift+] goes on', () => {
  /* When */
  const back = sessionNavDirection(keydown({ code: 'BracketLeft', key: '{', metaKey: true, shiftKey: true }));
  const on = sessionNavDirection(keydown({ code: 'BracketRight', key: '}', metaKey: true, shiftKey: true }));

  /* Then */
  assert.equal(back, -1);
  assert.equal(on, 1);
});

test('Cmd+Arrow does the same: left and up go back, right and down go on', () => {
  /* When */
  const directions = ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown']
    .map(key => sessionNavDirection(keydown({ key, metaKey: true })));

  /* Then */
  assert.deepEqual(directions, [-1, -1, 1, 1]);
});

test('without Cmd, with Alt, or with Shift on an arrow, no key moves between sessions', () => {
  /* Given */
  const presses = [
    keydown({ code: 'BracketRight', shiftKey: true }),
    keydown({ key: 'ArrowDown' }),
    keydown({ key: 'ArrowDown', metaKey: true, altKey: true }),
    keydown({ key: 'ArrowDown', metaKey: true, shiftKey: true }),
    keydown({ code: 'BracketRight', key: ']', metaKey: true }),
  ];

  /* When */
  const directions = presses.map(sessionNavDirection);

  /* Then */
  assert.deepEqual(directions, [null, null, null, null, null]);
  assert.deepEqual(presses.map(isSessionNavKey), [false, false, false, false, false]);
});

// ── The list's own keys ──

test('in the list, the arrows and J/K step, Enter activates and Escape lets go', () => {
  /* When */
  const actions = ['ArrowDown', 'j', 'ArrowUp', 'k', 'Enter', 'Escape'].map(key => listCursorKey(keydown({ key })));

  /* Then */
  assert.deepEqual(actions, ['down', 'down', 'up', 'up', 'activate', 'leave']);
});

test('in the list, R or F2 renames, E archives and A starts a new session', () => {
  /* When */
  const actions = ['r', 'F2', 'e', 'a'].map(key => listCursorKey(keydown({ key })));

  /* Then */
  assert.deepEqual(actions, ['rename', 'rename', 'archive', 'newSession']);
});

test('in the list, J, K, R, E and A are left alone with Cmd, Ctrl or Alt held', () => {
  /* Given */
  const chorded = ['j', 'k', 'r', 'F2', 'e', 'a'].flatMap(key => [
    keydown({ key, metaKey: true }), keydown({ key, ctrlKey: true }), keydown({ key, altKey: true }),
  ]);

  /* When */
  const actions = chorded.map(listCursorKey);

  /* Then */
  assert.ok(actions.every(action => action === null));
});

test('in the list, any other key is not the list\'s', () => {
  /* When */
  const actions = ['n', 'x', ' ', 'Tab'].map(key => listCursorKey(keydown({ key })));

  /* Then */
  assert.deepEqual(actions, [null, null, null, null]);
});
