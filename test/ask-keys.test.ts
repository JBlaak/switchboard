/**
 * The box on the empty screen (#135): what each key does in each phase, when
 * the box takes the focus, what Patch says, and the request it sends.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CANCELLED_BEAT, askKey, boxTakesFocus, isCaretChord, outcomeBeat, thinkingBeat,
} from '../src/renderer/ui/ask/ask-keys';
import { routeRequest } from '../src/renderer/ui/ask/route-request';
import type { AskKeyPress } from '../src/renderer/ui/ask/ask-keys';
import type { Project } from '../src/domain/project/project';
import type { SessionRow } from '../src/domain/session/session';

function press(key: string, fields: Partial<AskKeyPress> = {}): AskKeyPress {
  return { key, shiftKey: false, isComposing: false, ...fields };
}

// ── Editing ──

test('Enter sends', () => {
  /* When */
  const action = askKey('editing', press('Enter'));

  /* Then */
  assert.equal(action, 'send');
});

test('Shift+Enter is left to the box, for a new line', () => {
  /* When */
  const action = askKey('editing', press('Enter', { shiftKey: true }));

  /* Then */
  assert.equal(action, null);
});

test('Enter that ends an IME composition is the composition’s', () => {
  /* When */
  const action = askKey('editing', press('Enter', { isComposing: true }));

  /* Then */
  assert.equal(action, null);
});

test('Esc and the arrows do nothing special while editing', () => {
  /* When */
  const actions = ['Escape', 'ArrowUp', 'ArrowDown', 'Tab'].map(key => askKey('editing', press(key)));

  /* Then */
  assert.deepEqual(actions, [null, null, null, null]);
});

// ── Waiting ──

test('Esc while waiting cancels', () => {
  /* When */
  const action = askKey('waiting', press('Escape'));

  /* Then */
  assert.equal(action, 'cancel');
});

test('Enter while waiting is swallowed', () => {
  /* When */
  const action = askKey('waiting', press('Enter'));

  /* Then */
  assert.equal(action, 'swallow');
});

// ── Choosing ──

for (const [key, shiftKey, expected] of [
  ['Enter', false, 'start'],
  ['ArrowUp', false, 'up'],
  ['ArrowDown', false, 'down'],
  ['Tab', false, 'picker'],
  ['Escape', false, 'close'],
  ['Tab', true, 'swallow'],
  ['Enter', true, 'swallow'],
] as const) {
  test(`${shiftKey ? 'Shift+' : ''}${key} in the choice list: ${expected}`, () => {
    /* When */
    const action = askKey('choosing', press(key, { shiftKey }));

    /* Then */
    assert.equal(action, expected);
  });
}

// ── The app's shortcuts ──

test('Cmd+Arrow is the caret’s in the box, not a step between sessions', () => {
  /* When */
  const chords = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']
    .map(key => isCaretChord({ key, metaKey: true, altKey: false }));

  /* Then */
  assert.deepEqual(chords, [true, true, true, true]);
});

test('a bare arrow, or another Cmd chord, is not claimed', () => {
  /* When */
  const bare = isCaretChord({ key: 'ArrowLeft', metaKey: false, altKey: false });
  const other = isCaretChord({ key: 'n', metaKey: true, altKey: false });

  /* Then */
  assert.equal(bare, false);
  assert.equal(other, false);
});

// ── Focus ──

test('the box takes the focus as the empty screen comes into view', () => {
  /* When */
  const takes = boxTakesFocus({ dialogOpen: false, focusInSidebar: false });

  /* Then */
  assert.equal(takes, true);
});

test('the box does not take the focus from an open dialog', () => {
  /* When */
  const takes = boxTakesFocus({ dialogOpen: true, focusInSidebar: false });

  /* Then */
  assert.equal(takes, false);
});

test('the box does not take the focus from the session list', () => {
  /* When */
  const takes = boxTakesFocus({ dialogOpen: false, focusInSidebar: true });

  /* Then */
  assert.equal(takes, false);
});

// ── What Patch says ──

test('Patch thinks while the text is routed, cycling its lines', () => {
  /* When */
  const beats = [0, 1, 2, 3].map(thinkingBeat);

  /* Then */
  assert.ok(beats.every(beat => beat.line.length > 0));
  assert.notEqual(beats[0].line, beats[1].line);
  assert.deepEqual(beats[3], beats[0]);
});

test('Patch says the reason when the picker opens instead', () => {
  /* When */
  const beat = outcomeBeat({ kind: 'picker', prompt: 'x', say: 'You hit your usage limit.' });

  /* Then */
  assert.equal(beat?.line, 'You hit your usage limit.');
});

test('Patch has a line for the choices, and none for a sure answer or a cancel', () => {
  /* When */
  const choose = outcomeBeat({ kind: 'choose', choices: ['/a'], prompt: 'p' });
  const start = outcomeBeat({ kind: 'start', projectPath: '/a', prompt: 'p' });
  const unlock = outcomeBeat({ kind: 'unlock' });

  /* Then */
  assert.ok(choose && choose.line.length > 0);
  assert.equal(start, null);
  assert.equal(unlock, null);
  assert.ok(CANCELLED_BEAT.line.length > 0);
});

// ── The request ──

function session(fields: Partial<SessionRow>): SessionRow {
  return {
    sessionId: 's', summary: '', firstPrompt: '', projectPath: '/dev/app', name: null,
    starred: 0, archived: 0, messageCount: 0, modified: '2026-10-01T00:00:00Z', created: '2026-10-01T00:00:00Z',
    ...fields,
  };
}

function project(projectPath: string, fields: Partial<Project> = {}): Project {
  return { projectPath, folder: projectPath.replaceAll('/', '-'), sessions: [], ...fields };
}

test('the request carries the text exactly as typed', () => {
  /* When */
  const request = routeRequest('  fix it\n', []);

  /* Then */
  assert.equal(request.text, '  fix it\n');
});

test('the request offers local projects only, no remotes or worktrees', () => {
  /* Given */
  const projects = [
    project('/dev/app'),
    project('ssh://box/dev/api', { remote: true }),
    project('/dev/app/.claude/worktrees/fix-login'),
  ];

  /* When */
  const request = routeRequest('fix it', projects);

  /* Then */
  assert.deepEqual(request.candidates.map(c => c.projectPath), ['/dev/app']);
});

test('a candidate carries its folder name and its newest session titles first', () => {
  /* Given */
  const projects = [project('/dev/rp3-web', {
    sessions: [
      session({ summary: 'Old one', modified: '2026-09-01T00:00:00Z' }),
      session({ summary: 'Summary', name: 'Renamed', modified: '2026-10-02T00:00:00Z' }),
    ],
  })];

  /* When */
  const [candidate] = routeRequest('fix it', projects).candidates;

  /* Then */
  assert.equal(candidate.folder, 'rp3-web');
  assert.deepEqual(candidate.recentTitles, ['Renamed', 'Old one']);
});
