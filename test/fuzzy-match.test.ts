import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fuzzyMatch } from '../src/domain/search/fuzzy';
import type { FuzzyMatch } from '../src/domain/search/fuzzy';

// Rank a list of candidates the way the project picker does: best score first.
function rank(query: string, candidates: string[]): string[] {
  return candidates
    .map(text => ({ text, match: fuzzyMatch(query, text) }))
    .filter((c): c is { text: string; match: FuzzyMatch } => c.match !== null)
    .sort((a, b) => b.match.score - a.match.score)
    .map(c => c.text);
}

test('matches characters in order, not just substrings', () => {
  /* When */
  const initials = fuzzyMatch('swb', 'switchboard');
  const acrossSegments = fuzzyMatch('jbsw', 'JBlaak/switchboard');

  /* Then */
  assert.ok(initials);
  assert.ok(acrossSegments);
});

test('characters out of order are not a match', () => {
  /* When */
  const match = fuzzyMatch('bws', 'switchboard');

  /* Then */
  assert.equal(match, null);
});

test('a character that isn\'t there at all is not a match', () => {
  /* When */
  const match = fuzzyMatch('swbz', 'switchboard');

  /* Then */
  assert.equal(match, null);
});

test('matching is case-insensitive', () => {
  /* When */
  const upperQuery = fuzzyMatch('SWB', 'switchboard');
  const upperText = fuzzyMatch('jb', 'JBlaak/switchboard');

  /* Then */
  assert.ok(upperQuery);
  assert.ok(upperText);
});

test('an empty query matches everything at score 0', () => {
  /* When */
  const match = fuzzyMatch('', 'switchboard');

  /* Then */
  assert.deepEqual(match, { score: 0, positions: [] });
});

test('positions point at the matched characters', () => {
  /* When */
  const match = fuzzyMatch('swb', 'switchboard');

  /* Then */
  assert.deepEqual(match?.positions, [0, 1, 6]);
});

test('a contiguous run beats scattered characters', () => {
  /* Given */
  // "board" is contiguous in the first, scattered in the second.
  const candidates = ['me/switchboard', 'b-o-a-r-d-x'];

  /* When */
  const ranked = rank('board', candidates);

  /* Then */
  assert.deepEqual(ranked, ['me/switchboard', 'b-o-a-r-d-x']);
});

test('a later contiguous run wins over an earlier scattered one', () => {
  // The greedy first pass would settle for a[0] + b[3]; restarting finds "ab".
  /* When */
  const match = fuzzyMatch('ab', 'a-ab');

  /* Then */
  assert.deepEqual(match?.positions, [2, 3]);
});

test('word boundaries rank above mid-word matches', () => {
  /* Given */
  // "sp" as two segment initials beats the same letters buried in one word.
  const candidates = ['switchboard/public', 'inspector'];

  /* When */
  const ranked = rank('sp', candidates);

  /* Then */
  assert.deepEqual(ranked, ['switchboard/public', 'inspector']);
});

test('camelCase humps count as word boundaries', () => {
  /* Given */
  // 'l' lands on the hump in moveLab, mid-word in malformed.
  const candidates = ['malformed', 'moveLab'];

  /* When */
  const ranked = rank('ml', candidates);

  /* Then */
  assert.deepEqual(ranked, ['moveLab', 'malformed']);
});

test('the match anchor outweighs a boundary mid-match', () => {
  /* Given */
  // Both are label-style strings; "sb" should anchor on switchboard rather than
  // on the s of joris just because its b follows a separator.
  const candidates = ['joris@build-box/deploy', 'JBlaak/switchboard'];

  /* When */
  const ranked = rank('sb', candidates);

  /* Then */
  assert.deepEqual(ranked, ['JBlaak/switchboard', 'joris@build-box/deploy']);
});

test('an early match ranks above a late one', () => {
  /* Given */
  const candidates = ['lab/api', 'work/some/deep/nested/lab'];

  /* When */
  const ranked = rank('lab', candidates);

  /* Then */
  assert.deepEqual(ranked, ['lab/api', 'work/some/deep/nested/lab']);
});

test('no text is never a match', () => {
  /* When */
  const empty = fuzzyMatch('a', '');
  const missing = fuzzyMatch('a', null as unknown as string);

  /* Then */
  assert.equal(empty, null);
  assert.equal(missing, null);
});
