import { test } from 'node:test';
import assert from 'node:assert/strict';

import { repoWebUrl } from '../src/domain/project/repo-url';

test('turns an scp-style ssh remote into its web page', () => {
  assert.equal(repoWebUrl('git@github.com:MoveLab-Studio/ISMS.git'), 'https://github.com/MoveLab-Studio/ISMS');
  assert.equal(repoWebUrl('git@gitlab.com:group/sub/repo'), 'https://gitlab.com/group/sub/repo');
});

test('turns an ssh:// remote into its web page, dropping user and port', () => {
  assert.equal(repoWebUrl('ssh://git@github.com:22/JBlaak/switchboard.git'), 'https://github.com/JBlaak/switchboard');
});

test('turns an https remote into its web page, dropping credentials', () => {
  assert.equal(repoWebUrl('https://github.com/JBlaak/switchboard.git\n'), 'https://github.com/JBlaak/switchboard');
  assert.equal(repoWebUrl('https://token@github.com/JBlaak/switchboard'), 'https://github.com/JBlaak/switchboard');
});

test('answers null for a remote with no web page', () => {
  assert.equal(repoWebUrl('/Users/me/repos/thing.git'), null);
  assert.equal(repoWebUrl('file:///Users/me/repos/thing.git'), null);
  assert.equal(repoWebUrl(''), null);
});
