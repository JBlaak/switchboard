import {test} from 'node:test';
import assert from 'node:assert/strict';

import {isSafeConfigPath, isSafeRepoPath} from '../src/domain/agent/protocol';

/** Which paths the global config copy may write under `~/.claude` on a VM. */

test('skills, commands, agents and CLAUDE.md may be copied', () => {
    /* Given */
    const paths = ['CLAUDE.md', 'skills/tdd/SKILL.md', 'commands/release.md', 'agents/reviewer.md'];

    /* When */
    const verdicts = paths.map(isSafeConfigPath);

    /* Then */
    assert.deepEqual(verdicts, [true, true, true, true]);
});

test('a path that could leave ~/.claude is refused', () => {
    /* Given */
    const paths = ['/etc/passwd', '../.ssh/authorized_keys', 'skills/../../x', 'skills//x', './CLAUDE.md', '', 'a\\b'];

    /* When */
    const verdicts = paths.map(isSafeConfigPath);

    /* Then */
    assert.deepEqual(
        verdicts,
        paths.map(() => false),
    );
});

test('credentials, transcripts and local settings are never written', () => {
    /* Given */
    const paths = ['.credentials.json', 'projects/-Users-me-app/abc.jsonl', 'settings.local.json', 'todos/x.json'];

    /* When */
    const verdicts = paths.map(isSafeConfigPath);

    /* Then */
    assert.deepEqual(
        verdicts,
        paths.map(() => false),
    );
});

test('a hand-off may write config files in the repository but never inside .git', () => {
    /* Given */
    const paths = ['.env', 'apps/web/.env.local', '.git/config', '../outside', '/abs', 'a//b'];

    /* When */
    const verdicts = paths.map(isSafeRepoPath);

    /* Then */
    assert.deepEqual(verdicts, [true, true, false, false, false, false]);
});
