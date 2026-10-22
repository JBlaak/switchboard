import { test } from 'node:test';
import assert from 'node:assert/strict';

import { issueKeyString } from '../src/domain/plan/model';
import { issueBranchName, issueSessionPrompt } from '../src/domain/plan/start';
import { issueFromBranch } from '../src/domain/session-work/issues';

const REPO = 'JBlaak/switchboard';

test('a branch is named after the issue number and the first words of its title', () => {
  /* Given */
  const issue = { repository: REPO, number: 114, title: 'Zoom & pan: the stage, with a mini-map and more' };

  /* When */
  const branch = issueBranchName(issue);

  /* Then */
  assert.equal(branch, '114-zoom-pan-the-stage-with');
});

test('the branch name round-trips through issueFromBranch', () => {
  /* Given */
  const titles = ['Plan tab: the plan domain — levels, states', 'Ünïcödé títle', '!!!', '42 is the answer'];

  for (const title of titles) {
    /* When */
    const branch = issueBranchName({ repository: REPO, number: 122, title });

    /* Then */
    assert.deepEqual(issueFromBranch(branch, REPO), { repository: REPO, number: 122 }, branch);
  }
});

test('accents are dropped and an empty slug leaves just the number', () => {
  /* When */
  const accented = issueBranchName({ repository: REPO, number: 7, title: 'Café crème' });
  const empty = issueBranchName({ repository: REPO, number: 8, title: '—' });

  /* Then */
  assert.equal(accented, '7-cafe-creme');
  assert.equal(empty, '8');
});

test('the session prompt names the issue and the epic', () => {
  /* Given */
  const issue = { repository: REPO, number: 114 };
  const plan = { repository: REPO, number: 112 };

  /* When */
  const prompt = issueSessionPrompt(issue, plan);

  /* Then */
  assert.equal(prompt, 'Work on #114, part of #112. Read the epic and the issue first. Open a PR titled with a short summary of what you implemented, with "Closes #114" in its description.');
});

test('a stacked session is asked to branch off the blocker\'s PR and target it', () => {
  /* Given */
  const issue = { repository: REPO, number: 114 };
  const plan = { repository: REPO, number: 112 };

  /* When */
  const prompt = issueSessionPrompt(issue, plan, 118);

  /* Then */
  assert.equal(prompt,
    'Work on #114, part of #112. Read the epic and the issue first. Open a PR titled with a short summary of what you implemented, with "Closes #114" in its description. ' +
    'Branch off PR #118\'s branch and open your PR against it.');
});

test('an epic in another repository is named in full', () => {
  /* When */
  const prompt = issueSessionPrompt({ repository: REPO, number: 3 }, { repository: 'JBlaak/James', number: 22 });

  /* Then */
  assert.ok(prompt.startsWith('Work on #3, part of JBlaak/James#22.'));
});

test('an issue key reads as owner/repo#n', () => {
  /* When */
  const text = issueKeyString({ repository: REPO, number: 122 });

  /* Then */
  assert.equal(text, 'JBlaak/switchboard#122');
});
