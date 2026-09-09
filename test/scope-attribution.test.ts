import { test } from 'node:test';
import assert from 'node:assert';
import { absorbedProjectPaths, attributeToScope } from '../src/domain/git/scope';

const PROJECT = '/Users/j/dev/proj';
const CLAUDE_WT = '/Users/j/dev/proj/.claude/worktrees/feat-x';
const PLAIN_WT = '/Users/j/dev/proj-feature';
const OTHER = '/Users/j/dev/other';

// The parent's `git worktree list`: the primary first, then both flavours.
const KNOWN = [PROJECT, CLAUDE_WT, PLAIN_WT];

// A session that ran in the project itself.
const inProject = { cwd: PROJECT, projectPath: PROJECT };
// Claude CLI's --worktree: the indexer folded projectPath into the parent, cwd says where.
const inClaudeWorktree = { cwd: CLAUDE_WT, projectPath: PROJECT };
// `git worktree add ../proj-feature`: nothing folded it, so it is its own project today.
const inPlainWorktree = { cwd: PLAIN_WT, projectPath: PLAIN_WT };
// An unrelated project.
const elsewhere = { cwd: OTHER, projectPath: OTHER };
// A row indexed before cwd was recorded.
const noCwd = { cwd: null, projectPath: PROJECT };

test('a null scope admits every row', () => {
  for (const row of [inProject, inClaudeWorktree, inPlainWorktree, elsewhere, noCwd]) {
    assert.strictEqual(attributeToScope(row, null, []), true);
  }
});

test('a project scope admits the project and both flavours of its worktrees, not other projects', () => {
  const scope = { projectPath: PROJECT, worktreePath: null };
  assert.strictEqual(attributeToScope(inProject, scope, KNOWN), true);
  assert.strictEqual(attributeToScope(inClaudeWorktree, scope, KNOWN), true, 'folded worktree rows belong to the parent');
  assert.strictEqual(attributeToScope(inPlainWorktree, scope, KNOWN), true, 'a plain worktree is tied to the parent only by git worktree list');
  assert.strictEqual(attributeToScope(noCwd, scope, KNOWN), true, 'a row without cwd falls back to its projectPath');
  assert.strictEqual(attributeToScope(elsewhere, scope, KNOWN), false);
});

test('a project scope recognises the .claude/worktrees shape even without a worktree list', () => {
  const scope = { projectPath: PROJECT, worktreePath: null };
  // projectPath differs from the scope (say the parent was missing at index time) but the cwd shape gives it away.
  const unfolded = { cwd: CLAUDE_WT, projectPath: CLAUDE_WT };
  assert.strictEqual(attributeToScope(unfolded, scope, []), true);
  // Without the list, a plain worktree has nothing to tie it to the parent.
  assert.strictEqual(attributeToScope(inPlainWorktree, scope, []), false);
});

test('a worktree scope admits only rows that ran in that worktree', () => {
  const claudeScope = { projectPath: PROJECT, worktreePath: CLAUDE_WT };
  assert.strictEqual(attributeToScope(inClaudeWorktree, claudeScope, KNOWN), true);
  assert.strictEqual(attributeToScope(inProject, claudeScope, KNOWN), false, 'the primary checkout is a different place');
  assert.strictEqual(attributeToScope(inPlainWorktree, claudeScope, KNOWN), false);
  assert.strictEqual(attributeToScope(noCwd, claudeScope, KNOWN), false, 'no cwd means the primary, not this worktree');

  const plainScope = { projectPath: PROJECT, worktreePath: PLAIN_WT };
  assert.strictEqual(attributeToScope(inPlainWorktree, plainScope, KNOWN), true);
  assert.strictEqual(attributeToScope(inClaudeWorktree, plainScope, KNOWN), false);
  assert.strictEqual(attributeToScope(inProject, plainScope, KNOWN), false);
});

test('scoping to the primary checkout admits the project rows and rows with no cwd, but no worktree rows', () => {
  const primary = { projectPath: PROJECT, worktreePath: PROJECT };
  assert.strictEqual(attributeToScope(inProject, primary, KNOWN), true);
  assert.strictEqual(attributeToScope(noCwd, primary, KNOWN), true, 'a row that never recorded a cwd lands on the primary');
  assert.strictEqual(attributeToScope(inClaudeWorktree, primary, KNOWN), false);
  assert.strictEqual(attributeToScope(inPlainWorktree, primary, KNOWN), false);
  assert.strictEqual(attributeToScope(elsewhere, primary, KNOWN), false);
});

test('trailing slashes and Windows separators do not break the comparison', () => {
  const scope = { projectPath: PROJECT + '/', worktreePath: null };
  assert.strictEqual(attributeToScope({ cwd: PROJECT, projectPath: PROJECT }, scope, []), true);
  assert.strictEqual(attributeToScope({ cwd: CLAUDE_WT + '/', projectPath: PROJECT }, scope, []), true);

  // git prints forward slashes on Windows; a transcript cwd has backslashes.
  const winScope = { projectPath: 'C:\\Users\\j\\dev\\proj', worktreePath: 'C:/Users/j/dev/proj-feature' };
  const winRow = { cwd: 'C:\\Users\\j\\dev\\proj-feature', projectPath: 'C:\\Users\\j\\dev\\proj-feature' };
  assert.strictEqual(attributeToScope(winRow, winScope, ['C:/Users/j/dev/proj', 'C:/Users/j/dev/proj-feature']), true);
});

test('absorbedProjectPaths folds a plain git worktree that is also a top-level project under its parent', () => {
  const projects = [PROJECT, PLAIN_WT, OTHER];
  const lists = new Map([[PROJECT, KNOWN]]);
  const absorbed = absorbedProjectPaths(projects, lists);
  assert.deepStrictEqual([...absorbed], [PLAIN_WT]);
});

test('absorbedProjectPaths folds a .claude/worktrees project under its parent even with no worktree list', () => {
  const absorbed = absorbedProjectPaths([PROJECT, CLAUDE_WT, OTHER], new Map());
  assert.deepStrictEqual([...absorbed], [CLAUDE_WT]);
  // ...but not when the parent is not a project: there is nothing to draw it under.
  assert.deepStrictEqual([...absorbedProjectPaths([CLAUDE_WT, OTHER], new Map())], []);
});

test('absorbedProjectPaths never lets two checkouts of one repository absorb each other', () => {
  // Every worktree of a repo prints the same list, primary first.
  const lists = new Map([
    [PROJECT, [PROJECT, PLAIN_WT]],
    [PLAIN_WT, [PROJECT, PLAIN_WT]],
  ]);
  const absorbed = absorbedProjectPaths([PROJECT, PLAIN_WT], lists);
  assert.deepStrictEqual([...absorbed], [PLAIN_WT], 'the primary stays; the linked worktree folds under it');
});

test('absorbedProjectPaths never absorbs a project into itself and returns paths as given', () => {
  const withSlash = PROJECT + '/';
  const absorbed = absorbedProjectPaths([withSlash, PLAIN_WT], new Map([[PROJECT, [PROJECT, PLAIN_WT + '/']]]));
  assert.ok(!absorbed.has(withSlash), 'the primary is its own project');
  assert.ok(absorbed.has(PLAIN_WT), 'matched despite the trailing slash in the list, returned as the caller spelled it');
});
