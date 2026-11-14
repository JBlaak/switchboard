/**
 * Reading a VM's gh token scopes from `gh auth status`, and which of the
 * scopes Switchboard needs it lacks.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ghTokenScopes, missingGhScopes} from '../src/domain/agent/gh-scopes';

const status = (scopes: string) =>
    [
        'github.com',
        '  ✓ Logged in to github.com account someone (keyring)',
        '  - Active account: true',
        '  - Git operations protocol: https',
        '  - Token: gho_************************************',
        `  - Token scopes: ${scopes}`,
    ].join('\n');

test('the scopes are read from the quoted list gh prints', () => {
    /* When */
    const scopes = ghTokenScopes(status("'gist', 'read:org', 'repo', 'workflow'"));

    /* Then */
    assert.deepEqual(scopes, ['gist', 'read:org', 'repo', 'workflow']);
});

test('the scopes are read from the unquoted list older gh prints', () => {
    /* When */
    const scopes = ghTokenScopes(
        'github.com\n  ✓ Logged in to github.com as someone\n  ✓ Token scopes: gist, read:org, repo\n',
    );

    /* Then */
    assert.deepEqual(scopes, ['gist', 'read:org', 'repo']);
});

test('only the first account’s scopes count, the active one gh lists first', () => {
    /* Given */
    const output =
        status("'gist'") + "\n\n  ✓ Logged in to github.com account other (keyring)\n  - Token scopes: 'repo'\n";

    /* When */
    const missing = missingGhScopes(output);

    /* Then */
    assert.deepEqual(missing, ['repo']);
});

test('a token without repo misses it', () => {
    /* When */
    const missing = missingGhScopes(status("'gist', 'read:org'"));

    /* Then */
    assert.deepEqual(missing, ['repo']);
});

test('a token with no scopes at all misses repo', () => {
    /* When */
    const missing = missingGhScopes(status('none'));

    /* Then */
    assert.deepEqual(missing, ['repo']);
});

test('a token with repo misses nothing', () => {
    /* When */
    const missing = missingGhScopes(status("'gist', 'read:org', 'repo'"));

    /* Then */
    assert.deepEqual(missing, []);
});

test('nothing is missing when gh lists no scopes, as for a fine-grained token', () => {
    /* Given */
    const output = 'github.com\n  ✓ Logged in to github.com account someone (GH_TOKEN)\n  - Token: github_pat_****\n';

    /* When */
    const scopes = ghTokenScopes(output);
    const missing = missingGhScopes(output);

    /* Then */
    assert.equal(scopes, null);
    assert.deepEqual(missing, []);
});
