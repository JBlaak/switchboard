import {test} from 'node:test';
import assert from 'node:assert/strict';

import {parseCliResult, runOutcome} from '../src/domain/schedule/outcome';
import type {RunEnding} from '../src/domain/schedule/outcome';
import {parseSchedule, scheduleWorktree} from '../src/domain/schedule/schedule';

/**
 * A schedule file's new settings, and what a run came to from what the CLI
 * printed and how its process ended.
 */

const LOCATION = {
    file: 'schedule-nightly.md',
    filePath: '/p/.claude/commands/schedule-nightly.md',
    projectPath: '/p',
    folder: '-p',
};

const ENDED: RunEnding = {
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    startError: null,
    limitHit: false,
    limitMinutes: 30,
};

function result(fields: Record<string, unknown>): string {
    return JSON.stringify({type: 'result', subtype: 'success', is_error: false, session_id: 'sess', ...fields});
}

// ── The file ──

test('a schedule file’s settings default when left out', () => {
    /* When */
    const parsed = parseSchedule('---\ncron: 0 3 * * *\n---\nTidy up.\n', LOCATION);

    /* Then */
    assert.deepEqual(
        [parsed?.enabled, parsed?.missed, parsed?.limitMinutes, parsed?.weekCap, parsed?.worktree, parsed?.slug],
        [true, 'run-once', 30, 80, true, 'nightly'],
    );
});

test('a schedule file’s settings are read, and none or 0 lifts a limit or a cap', () => {
    /* When */
    const parsed = parseSchedule(
        '---\ncron: 0 3 * * *\nenabled: false\nmissed: skip\nlimit-minutes: none\nweek-cap: 0\nworktree: false\n---\nTidy up.\n',
        LOCATION,
    );
    const odd = parseSchedule('---\ncron: 0 3 * * *\nlimit-minutes: soon\nweek-cap: 65%\n---\nTidy up.\n', LOCATION);

    /* Then */
    assert.deepEqual(
        [parsed?.enabled, parsed?.missed, parsed?.limitMinutes, parsed?.weekCap, parsed?.worktree],
        [false, 'skip', null, null, false],
    );
    assert.deepEqual([odd?.limitMinutes, odd?.weekCap], [30, 65]);
});

test('a file with no cron or no body is not a schedule yet', () => {
    /* When */
    const noCron = parseSchedule('---\nname: x\n---\nTidy up.\n', LOCATION);
    const noBody = parseSchedule('---\ncron: 0 3 * * *\n---\n', LOCATION);

    /* Then */
    assert.deepEqual([noCron, noBody], [null, null]);
});

test('a run’s worktree and branch are named after the slug and its start, in local time', () => {
    /* When */
    const named = scheduleWorktree('/p/', 'nightly', new Date(2026, 10, 3, 3, 5).getTime());

    /* Then */
    assert.deepEqual(named, {
        path: '/p/.claude/worktrees/schedule-nightly-20261103-0305',
        branch: 'schedule/nightly-20261103-0305',
    });
});

// ── The CLI's result ──

test('the result is found after what a login shell printed first, and garbage is no result', () => {
    /* When */
    const afterShell = parseCliResult('Last login: today\nnvm: using 22\n' + result({result: 'Did it.'}) + '\n');
    const mid = parseCliResult('motd ' + result({result: 'Mid.'}));
    const garbage = parseCliResult('{not json\nhello');

    /* Then */
    assert.deepEqual(afterShell, {result: 'Did it.', isError: false, subtype: 'success', sessionId: 'sess'});
    assert.equal(mid?.result, 'Mid.');
    assert.equal(garbage, null);
});

test('a clean exit with a report is done, with the CLI’s session', () => {
    /* When */
    const outcome = runOutcome({...ENDED, stdout: result({result: 'Merged one PR.\nClosed two issues.'})});

    /* Then */
    assert.deepEqual(outcome, {
        status: 'done',
        reason: null,
        report: 'Merged one PR.\nClosed two issues.',
        seen: false,
        sessionId: 'sess',
    });
});

test('a report that starts with Nothing to do. arrives seen', () => {
    /* When */
    const outcome = runOutcome({...ENDED, stdout: result({result: '  Nothing to do.\nAll green.'})});

    /* Then */
    assert.deepEqual([outcome.status, outcome.seen], ['done', true]);
});

test('an error result is failed with its subtype; a non-zero exit with stderr’s last line', () => {
    /* When */
    const isError = runOutcome({...ENDED, stdout: result({is_error: true, subtype: 'error_max_turns', result: ''})});
    const exit = runOutcome({...ENDED, exitCode: 2, stderr: 'one\ntwo: bad flag\n\n'});
    const bareExit = runOutcome({...ENDED, exitCode: 1});
    const signal = runOutcome({...ENDED, exitCode: null, signal: 'SIGTERM'});
    const notStarted = runOutcome({...ENDED, exitCode: null, startError: 'spawn zsh ENOENT'});

    /* Then */
    assert.deepEqual(
        [isError, exit, bareExit, signal, notStarted].map((o) => [o.status, o.reason]),
        [
            ['failed', 'error_max_turns'],
            ['failed', 'exit 2: two: bad flag'],
            ['failed', 'exit 1'],
            ['failed', 'killed by SIGTERM'],
            ['failed', 'it could not start: spawn zsh ENOENT'],
        ],
    );
});

test('a run its limit stopped is limit, keeping whatever report it gave', () => {
    /* When */
    const outcome = runOutcome({...ENDED, exitCode: null, signal: 'SIGTERM', limitHit: true, limitMinutes: 20});

    /* Then */
    assert.deepEqual([outcome.status, outcome.reason, outcome.report], ['limit', 'its 20 min limit', null]);
});
