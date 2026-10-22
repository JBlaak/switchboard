/**
 * The Projects modal (#171): what the search text is, which rows it lists,
 * what each key does, and how the folder check reads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyQuery } from '../src/renderer/ui/dialogs/projects-query';
import { projectsRows } from '../src/renderer/ui/dialogs/projects-rows';
import { pickerKeyAction, rowMenuKeyAction } from '../src/renderer/ui/dialogs/picker-selection';
import { canAddFolder, folderCheckLines, folderSummary } from '../src/renderer/ui/dialogs/add-project-request';
import type { PickerKey } from '../src/renderer/ui/dialogs/picker-selection';
import type { ProjectsRow } from '../src/renderer/ui/dialogs/projects-rows';
import type { Project } from '../src/domain/project/project';
import type { SessionRow } from '../src/domain/session/session';
import type { ProjectFolderCheck } from '../src/domain/project/folder-check';

// ── What the search text is ──

test('plain text filters the projects', () => {
  /* When */
  const query = classifyQuery('  acme ');

  /* Then */
  assert.deepEqual(query, { kind: 'filter', text: 'acme' });
});

test('text starting with / or ~ is a folder to add', () => {
  /* When */
  const absolute = classifyQuery('/Users/someone/Development/rowlog');
  const home = classifyQuery('~/Development/rowlog');

  /* Then */
  assert.deepEqual(absolute, { kind: 'path', path: '/Users/someone/Development/rowlog' });
  assert.deepEqual(home, { kind: 'path', path: '~/Development/rowlog' });
});

test('~ alone is the home folder, and so a path', () => {
  /* When */
  const query = classifyQuery('~');

  /* Then */
  assert.deepEqual(query, { kind: 'path', path: '~' });
});

test('user@host is a machine to add over SSH, with no port', () => {
  /* When */
  const query = classifyQuery('deploy@staging.example.com');

  /* Then */
  assert.deepEqual(query, { kind: 'ssh', user: 'deploy', host: 'staging.example.com', port: '' });
});

test('user@host:port keeps the port', () => {
  /* When */
  const query = classifyQuery('deploy@staging.example.com:2222');

  /* Then */
  assert.deepEqual(query, { kind: 'ssh', user: 'deploy', host: 'staging.example.com', port: '2222' });
});

test('user@ with no host yet is still a filter', () => {
  /* When */
  const queries = [classifyQuery('deploy@'), classifyQuery('@host'), classifyQuery('deploy@host:')];

  /* Then */
  assert.deepEqual(queries.map(q => q.kind), ['filter', 'filter', 'filter']);
});

test('a port that is not a number, or text with spaces, is a filter', () => {
  /* When */
  const queries = [classifyQuery('deploy@host:ssh'), classifyQuery('deploy@host extra')];

  /* Then */
  assert.deepEqual(queries.map(q => q.kind), ['filter', 'filter']);
});

// ── The rows ──

function project(projectPath: string, modified = '2026-10-01T00:00:00Z'): Project {
  return {
    projectPath,
    folder: projectPath.replace(/\//g, '-'),
    sessions: [{ sessionId: projectPath + '-1', modified } as SessionRow],
  };
}

function describe(rows: readonly ProjectsRow[]): string[] {
  return rows.map(row => {
    switch (row.kind) {
      case 'project': return (row.nested ? '  ' : '') + row.candidate.project.projectPath;
      case 'add-folder': return 'add folder ' + row.path;
      case 'add-remote': return `add remote ${row.user}@${row.host}:${row.port}`;
      case 'add-project': return 'add project';
    }
  });
}

const APP = '/code/app';
const APP_WORKTREE = '/code/app/.claude/worktrees/issue-7';
const OTHER = '/code/other';

test('Add project… is the last row, after every project', () => {
  /* Given */
  const projects = [project(APP, '2026-10-02T00:00:00Z'), project(OTHER, '2026-10-01T00:00:00Z')];

  /* When */
  const rows = projectsRows(projects, classifyQuery(''));

  /* Then */
  assert.deepEqual(describe(rows), [APP, OTHER, 'add project']);
});

test('a worktree is listed under its repository, however recently it was used', () => {
  /* Given */
  const projects = [
    project(APP_WORKTREE, '2026-10-05T00:00:00Z'),
    project(OTHER, '2026-10-03T00:00:00Z'),
    project(APP, '2026-10-01T00:00:00Z'),
  ];

  /* When */
  const rows = projectsRows(projects, classifyQuery(''));

  /* Then */
  assert.deepEqual(describe(rows), [OTHER, APP, '  ' + APP_WORKTREE, 'add project']);
});

test('a worktree whose repository is not listed stands on its own', () => {
  /* Given */
  const projects = [project(APP_WORKTREE), project(OTHER)];

  /* When */
  const rows = projectsRows(projects, classifyQuery('issue'));

  /* Then */
  assert.deepEqual(describe(rows), [APP_WORKTREE, 'add project']);
});

test('a path puts an Add folder row on top', () => {
  /* Given */
  const projects = [project(APP), project(OTHER)];

  /* When */
  const rows = projectsRows(projects, classifyQuery('/code/rowlog'));

  /* Then */
  assert.equal(describe(rows)[0], 'add folder /code/rowlog');
  assert.equal(describe(rows).at(-1), 'add project');
});

test('an ssh target puts an Add remote row on top', () => {
  /* When */
  const rows = projectsRows([project(APP)], classifyQuery('deploy@box:2222'));

  /* Then */
  assert.deepEqual(describe(rows), ['add remote deploy@box:2222', 'add project']);
});

// ── The keys ──

function key(name: string, fields: Partial<PickerKey> = {}): PickerKey {
  return { key: name, shiftKey: false, metaKey: false, caretAtStart: true, caretAtEnd: true, ...fields };
}

test('↵ starts a session and ⌘↵ adds a project, in the list', () => {
  /* When */
  const enter = pickerKeyAction('projects', key('Enter'), true);
  const cmdEnter = pickerKeyAction('projects', key('Enter', { metaKey: true }), true);

  /* Then */
  assert.equal(enter, 'open');
  assert.equal(cmdEnter, 'add-project');
});

test('⌘. opens the highlighted row’s menu; a bare . is typed', () => {
  /* When */
  const cmdDot = pickerKeyAction('projects', key('.', { metaKey: true }), false);
  const dot = pickerKeyAction('projects', key('.'), false);

  /* Then */
  assert.equal(cmdDot, 'row-menu');
  assert.equal(dot, null);
});

test('→ on a highlighted project opens its page', () => {
  /* Given */
  const right = key('ArrowRight');

  /* When */
  const action = pickerKeyAction('projects', right, true);

  /* Then */
  assert.equal(action, 'open-project');
});

test('→ does nothing with a prompt waiting or no project highlighted, so the caret is left alone', () => {
  /* Given: canOpenProject is false while a prompt waits, or on an Add row */
  const right = key('ArrowRight');

  /* When */
  const action = pickerKeyAction('projects', right, false);

  /* Then */
  assert.equal(action, null);
});

test('→ in the middle of typed text moves the caret instead', () => {
  /* Given */
  const right = key('ArrowRight', { caretAtEnd: false });

  /* When */
  const action = pickerKeyAction('projects', right, true);

  /* Then */
  assert.equal(action, null);
});

test('Tab completes a path, and → stays in the path', () => {
  /* When */
  const tab = pickerKeyAction('projects', key('Tab'), true, true);
  const right = pickerKeyAction('projects', key('ArrowRight'), true, true);

  /* Then */
  assert.equal(tab, 'complete-path');
  assert.equal(right, null);
});

test('Tab and Shift-Tab are swallowed outside a path, so focus stays in the filter and no plans open', () => {
  /* When */
  const tab = pickerKeyAction('projects', key('Tab'), true);
  const shiftTab = pickerKeyAction('projects', key('Tab', { shiftKey: true }), true, true);

  /* Then */
  assert.equal(tab, 'swallow');
  assert.equal(shiftTab, 'swallow');
});

test('← in the list is the field’s: there are no plans to go back from', () => {
  /* When */
  const left = pickerKeyAction('projects', key('ArrowLeft'), true);

  /* Then */
  assert.equal(left, null);
});

test('the arrows move and a plain letter is typed', () => {
  /* When */
  const actions = ['ArrowDown', 'ArrowUp', 'a'].map(name => pickerKeyAction('projects', key(name), false));

  /* Then */
  assert.deepEqual(actions, ['down', 'up', null]);
});

test('in the add step ↵ adds, ⌘[ goes back, and ← goes back only from the start of a field', () => {
  /* When */
  const enter = pickerKeyAction('add', key('Enter'), false);
  const bracket = pickerKeyAction('add', key('[', { metaKey: true }), false);
  const leftAtStart = pickerKeyAction('add', key('ArrowLeft'), false);
  const leftInText = pickerKeyAction('add', key('ArrowLeft', { caretAtStart: false }), false);

  /* Then */
  assert.equal(enter, 'open');
  assert.equal(bracket, 'back-to-projects');
  assert.equal(leftAtStart, 'back-to-projects');
  assert.equal(leftInText, null);
});

test('the add step leaves the arrows, Tab and ⌘↵ to its fields', () => {
  /* When */
  const actions = ['ArrowDown', 'ArrowUp', 'Tab'].map(name => pickerKeyAction('add', key(name), true));
  const cmdEnter = pickerKeyAction('add', key('Enter', { metaKey: true }), true);

  /* Then */
  assert.deepEqual(actions, [null, null, null]);
  assert.equal(cmdEnter, null);
});

test('an open menu takes the arrows, ↵, Esc and ⌘., and leaves typing alone', () => {
  /* When */
  const actions = [
    rowMenuKeyAction(key('ArrowDown')),
    rowMenuKeyAction(key('ArrowUp')),
    rowMenuKeyAction(key('Enter')),
    rowMenuKeyAction(key('Escape')),
    rowMenuKeyAction(key('.', { metaKey: true })),
    rowMenuKeyAction(key('Tab')),
    rowMenuKeyAction(key('a')),
  ];

  /* Then */
  assert.deepEqual(actions, ['down', 'up', 'choose', 'close', 'close', 'swallow', null]);
});

// ── The folder check ──

function check(fields: Partial<ProjectFolderCheck> = {}): ProjectFolderCheck {
  return {
    path: '/code/rowlog', exists: true, directory: true, git: true, branch: 'main',
    gitHubRepository: 'JBlaak/rowlog', completion: null, ...fields,
  };
}

test('a repository on GitHub passes every line of the check', () => {
  /* When */
  const lines = folderCheckLines(check());

  /* Then */
  assert.deepEqual(lines, [
    { ok: true, text: 'Folder exists' },
    { ok: true, text: 'Git repository on main' },
    { ok: true, text: 'On GitHub as JBlaak/rowlog, so plans and PRs will show' },
  ]);
});

test('a folder outside git stops the check at git', () => {
  /* When */
  const lines = folderCheckLines(check({ git: false, branch: null, gitHubRepository: null }));

  /* Then */
  assert.deepEqual(lines, [{ ok: true, text: 'Folder exists' }, { ok: false, text: 'Not a git repository' }]);
});

test('a missing folder says so, and cannot be added from the row', () => {
  /* Given */
  const missing = check({ exists: false, directory: false, git: false });

  /* When */
  const lines = folderCheckLines(missing);
  const addable = canAddFolder(missing);

  /* Then */
  assert.deepEqual(lines, [{ ok: false, text: 'No folder at this path' }]);
  assert.equal(addable, false);
});

test('the Add folder row sums the check up on one line', () => {
  /* When */
  const fresh = folderSummary(check(), false);
  const known = folderSummary(check({ gitHubRepository: null }), true);
  const waiting = folderSummary(null, false);

  /* Then */
  assert.equal(fresh, 'Git repository · github.com/JBlaak/rowlog · not added yet');
  assert.equal(known, 'Git repository · already added');
  assert.equal(waiting, 'Checking…');
});
