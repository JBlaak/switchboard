import { test } from 'node:test';
import assert from 'node:assert/strict';

import { repoWebUrl } from '../src/domain/project/repo-url';

test('turns an scp-style ssh remote into its web page', () => {
  /* When */
  const github = repoWebUrl('git@github.com:MoveLab-Studio/ISMS.git');
  const gitlab = repoWebUrl('git@gitlab.com:group/sub/repo');

  /* Then */
  assert.equal(github, 'https://github.com/MoveLab-Studio/ISMS');
  assert.equal(gitlab, 'https://gitlab.com/group/sub/repo');
});

test('turns an ssh:// remote into its web page, dropping user and port', () => {
  /* When */
  const url = repoWebUrl('ssh://git@github.com:22/JBlaak/switchboard.git');

  /* Then */
  assert.equal(url, 'https://github.com/JBlaak/switchboard');
});

test('turns an https remote into its web page, dropping credentials', () => {
  /* When */
  const withSuffix = repoWebUrl('https://github.com/JBlaak/switchboard.git\n');
  const withToken = repoWebUrl('https://token@github.com/JBlaak/switchboard');

  /* Then */
  assert.equal(withSuffix, 'https://github.com/JBlaak/switchboard');
  assert.equal(withToken, 'https://github.com/JBlaak/switchboard');
});

test('answers null for a remote with no web page', () => {
  /* Given */
  const remotes = ['/Users/me/repos/thing.git', 'file:///Users/me/repos/thing.git', ''];

  for (const remote of remotes) {
    /* When */
    const url = repoWebUrl(remote);

    /* Then */
    assert.equal(url, null, remote);
  }
});
