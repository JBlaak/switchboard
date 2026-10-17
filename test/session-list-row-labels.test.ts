/**
 * What a session list row and a slug group say and offer: the pure labels and
 * rules the components render (`ui/session-list`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  agentsTitle, askingLabel, groupDisplayName, renamedName, rowButtons, sessionTimeLabel, showsTerminalBadge,
  splitGroupRows,
} from '../src/renderer/state/session-list-layout';
import { projectLabel } from '../src/renderer/features/sessions/project-label';
import type { SessionListGroup, SessionListRow } from '../src/renderer/state/session-list-layout';
import type { SessionRow } from '../src/domain/session/session';

const NOW = 1_700_000_000_000;
const MINUTE = 60000;

function session(id: string, extra: Partial<SessionRow> = {}): SessionRow {
  return {
    sessionId: id, summary: 'Session ' + id, firstPrompt: '', projectPath: '/repo',
    created: new Date(NOW - 60 * MINUTE).toISOString(), modified: new Date(NOW - 20 * MINUTE).toISOString(),
    messageCount: 12, name: null, starred: 0, archived: 0, ...extra,
  };
}

function row(id: string, extra: Partial<SessionRow> = {}): SessionListRow {
  return { kind: 'row', id: 'si-' + id, session: session(id, extra), projectPath: '/repo' };
}

function group(...rows: SessionListRow[]): SessionListGroup {
  return { kind: 'group', id: 'slug-g', slug: 'gentle-orbiting-falcon', projectPath: '/repo', sessions: rows };
}

// ── The meta line ──

test('the time label is relative to the list\'s clock, with the message count', () => {
  /* Given */
  const row = session('a');

  /* When */
  const labels = [sessionTimeLabel(row, NOW), sessionTimeLabel(row, NOW + 5 * MINUTE)];

  /* Then */
  assert.deepEqual(labels, ['20m ago · 12 msgs', '25m ago · 12 msgs']);
});

test('the time label leaves out a count of no messages', () => {
  /* Given */
  const row = session('a', { messageCount: 0, modified: new Date(NOW - 30_000).toISOString() });

  /* When */
  const label = sessionTimeLabel(row, NOW);

  /* Then */
  assert.equal(label, 'just now');
});

test('the project label is the last two path segments, a worktree as "parent ⎇ branch"', () => {
  /* When */
  const labels = [
    projectLabel('/Users/me/Development/acme-api'),
    projectLabel('/Users/me/Development/old-parser/.claude/worktrees/streaming'),
  ];

  /* Then */
  assert.deepEqual(labels, ['Development/acme-api', 'Development/old-parser ⎇ streaming']);
});

test('the asking label counts the questions', () => {
  /* When */
  const labels = [askingLabel(1), askingLabel(2)];

  /* Then */
  assert.deepEqual(labels, ['Asking 1 question', 'Asking 2 questions']);
});

test('the agents tooltip counts the agents and lists each one\'s task', () => {
  /* Given */
  const two = [{ id: 'agents/1', title: 'Explore the redirect handler' }, { id: 'agents/2', title: 'Read the session middleware' }];

  /* When */
  const titles = [agentsTitle(two), agentsTitle([{ id: 'agents/1' }])];

  /* Then */
  assert.deepEqual(titles, [
    '2 agents working\n• Explore the redirect handler\n• Read the session middleware',
    '1 agent working\n• Untitled agent',
  ]);
});

// ── The row ──

test('a terminal badge on terminals, local and remote, and on nothing else', () => {
  /* Given */
  const sessions = [
    session('t', { type: 'terminal' }),
    session('rs', { type: 'remote', remoteKind: 'shell' }),
    session('rc', { type: 'remote', remoteKind: 'claude' }),
    session('c'),
  ];

  /* When */
  const badges = sessions.map(showsTerminalBadge);

  /* Then */
  assert.deepEqual(badges, [true, true, false, false]);
});

test('a Claude session can be stopped, archived and resumed with a config', () => {
  /* When */
  const buttons = rowButtons(session('c'));

  /* Then */
  assert.deepEqual(buttons, { stop: 'Stop session', archive: 'Archive', resume: true });
});

test('a remote session can be disconnected and archived, not resumed', () => {
  /* When */
  const buttons = rowButtons(session('r', { type: 'remote', remoteKind: 'claude' }));

  /* Then */
  assert.deepEqual(buttons, { stop: 'Disconnect (keeps running on the remote)', archive: 'Archive', resume: false });
});

test('a plain terminal can only be stopped', () => {
  /* When */
  const buttons = rowButtons(session('t', { type: 'terminal' }));

  /* Then */
  assert.deepEqual(buttons, { stop: 'Stop session', archive: null, resume: false });
});

test('an archived session offers to unarchive', () => {
  /* When */
  const buttons = rowButtons(session('c', { archived: 1 }));

  /* Then */
  assert.equal(buttons.archive, 'Unarchive');
});

// ── Rename ──

test('a rename stores what was typed, trimmed', () => {
  /* When */
  const name = renamedName('  Redirect loop, take two ', session('a'));

  /* Then */
  assert.equal(name, 'Redirect loop, take two');
});

test('an empty rename stores no name, so the row follows the CLI title again', () => {
  /* When */
  const names = [renamedName('', session('a')), renamedName('   ', session('a'))];

  /* Then */
  assert.deepEqual(names, [null, null]);
});

test('typing the fallback title back stores no name', () => {
  /* Given */
  const titled = session('a', { aiTitle: 'Add a dark mode to the dashboard charts', name: 'Charts' });

  /* When */
  const names = [renamedName('Add a dark mode to the dashboard charts', titled), renamedName('Session a', session('a'))];

  /* Then */
  assert.deepEqual(names, [null, null]);
});

// ── Slug groups ──

test('a group is named after its newest session, falling back to its slug', () => {
  /* Given */
  const named = group(row('b', { name: 'Refactor billing into its own service' }), row('a'));
  const untitled = group(row('b', { summary: '' }));

  /* When */
  const names = [groupDisplayName(named), groupDisplayName(untitled)];

  /* Then */
  assert.deepEqual(names, ['Refactor billing into its own service', 'gentle-orbiting-falcon']);
});

test('a group puts its running sessions first and keeps the rest behind, newest first', () => {
  /* Given */
  const sessions = [row('step-2'), row('step-1'), row('plan')];

  /* When */
  const { promoted, rest } = splitGroupRows(sessions, new Set(['plan']));

  /* Then */
  assert.deepEqual(promoted.map(r => r.id), ['si-plan']);
  assert.deepEqual(rest.map(r => r.id), ['si-step-2', 'si-step-1']);
});

test('a group with nothing running promotes nothing', () => {
  /* Given */
  const sessions = [row('step-2'), row('step-1')];

  /* When */
  const { promoted, rest } = splitGroupRows(sessions, new Set());

  /* Then */
  assert.deepEqual(promoted, []);
  assert.deepEqual(rest.map(r => r.id), ['si-step-2', 'si-step-1']);
});
