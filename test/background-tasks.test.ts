import {test} from 'node:test';
import assert from 'node:assert';
import {isWatch, runningBackgroundTasks, turnHolds} from '../src/domain/session/background-tasks';

const T0 = '2026-11-06T10:00:00.000Z';
const T1 = '2026-11-06T10:01:00.000Z';
const BEFORE = Date.parse('2026-11-06T09:00:00.000Z');

/** A `Bash` call Claude made, run in the background. */
function bashCall(toolUseId: string, command: string, description = 'a shell', at = T0): string {
    return JSON.stringify({
        type: 'assistant',
        timestamp: at,
        message: {
            role: 'assistant',
            content: [
                {type: 'tool_use', id: toolUseId, name: 'Bash', input: {command, description, run_in_background: true}},
            ],
        },
    });
}

/** The CLI's answer to a background `Bash` call: the task's id. */
function launched(toolUseId: string, taskId: string, at = T0): string {
    return JSON.stringify({
        type: 'user',
        timestamp: at,
        message: {
            role: 'user',
            content: [{type: 'tool_result', tool_use_id: toolUseId, content: 'Command running in background'}],
        },
        toolUseResult: {stdout: '', stderr: '', backgroundTaskId: taskId},
    });
}

/** The CLI reporting a background task done, queued while Claude was mid-turn. */
function reported(taskId: string, at = T1): string {
    return JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        timestamp: at,
        content: `<task-notification>\n<task-id>${taskId}</task-id>\n<status>completed</status>\n</task-notification>`,
    });
}

function shell(command: string, id = 'b1', description = 'a shell'): string[] {
    return [bashCall('toolu_' + id, command, description), launched('toolu_' + id, id)];
}

test('gh pr checks --watch is a watch', () => {
    /* When */
    const watch = isWatch('gh pr checks 42 --watch');

    /* Then */
    assert.strictEqual(watch, true);
});

test('gh run watch is a watch', () => {
    /* When */
    const watch = isWatch('gh run watch 123456 --exit-status');

    /* Then */
    assert.strictEqual(watch, true);
});

test('a gh poll loop with sleep and plumbing is a watch', () => {
    /* When */
    const watch = isWatch(
        'while true; do s=$(gh pr view 42 --json state | jq -r .state); [ "$s" = MERGED ] && break; sleep 30; done',
    );

    /* Then */
    assert.strictEqual(watch, true);
});

test('gh without a wait is not a watch', () => {
    /* When */
    const watch = isWatch('gh pr view 42');

    /* Then */
    assert.strictEqual(watch, false);
});

test('a build before the watch makes the shell work', () => {
    /* When */
    const watch = isWatch('npm test && gh pr checks --watch');

    /* Then */
    assert.strictEqual(watch, false);
});

test('a shell without a command is work', () => {
    /* When */
    const watch = isWatch(undefined);

    /* Then */
    assert.strictEqual(watch, false);
});

test('a background shell not reported done is running, marked a watch by its command', () => {
    /* Given */
    const lines = shell('gh pr checks 42 --watch', 'b1', 'Watch CI');

    /* When */
    const tasks = runningBackgroundTasks(lines, BEFORE);

    /* Then */
    assert.deepStrictEqual(tasks, [{id: 'b1', description: 'Watch CI', watch: true}]);
});

test('a background shell reported done is not running', () => {
    /* Given */
    const lines = [...shell('npm run build'), reported('b1')];

    /* When */
    const tasks = runningBackgroundTasks(lines, BEFORE);

    /* Then */
    assert.deepStrictEqual(tasks, []);
});

test('a report delivered as a prompt counts too', () => {
    /* Given */
    const prompt = JSON.stringify({
        type: 'user',
        timestamp: T1,
        message: {role: 'user', content: '<task-notification>\n<task-id>b1</task-id>\n</task-notification>'},
    });
    const lines = [...shell('npm run build'), prompt];

    /* When */
    const tasks = runningBackgroundTasks(lines, BEFORE);

    /* Then */
    assert.deepStrictEqual(tasks, []);
});

test('a task Claude stopped is not running', () => {
    /* Given */
    const stop = JSON.stringify({
        type: 'assistant',
        timestamp: T1,
        message: {
            role: 'assistant',
            content: [{type: 'tool_use', id: 'toolu_s', name: 'TaskStop', input: {task_id: 'b1'}}],
        },
    });
    const lines = [...shell('npm run build'), stop];

    /* When */
    const tasks = runningBackgroundTasks(lines, BEFORE);

    /* Then */
    assert.deepStrictEqual(tasks, []);
});

test('a background agent is work', () => {
    /* Given */
    const agent = JSON.stringify({
        type: 'user',
        timestamp: T0,
        message: {role: 'user', content: [{type: 'tool_result', tool_use_id: 'toolu_a', content: 'launched'}]},
        toolUseResult: {status: 'async_launched', agentId: 'a1', description: 'Review the diff'},
    });

    /* When */
    const tasks = runningBackgroundTasks([agent], BEFORE);

    /* Then */
    assert.deepStrictEqual(tasks, [{id: 'a1', description: 'Review the diff', watch: false}]);
});

test('a task launched before the process started is not running', () => {
    /* Given */
    const lines = shell('npm run build');

    /* When */
    const tasks = runningBackgroundTasks(lines, Date.parse(T1));

    /* Then */
    assert.deepStrictEqual(tasks, []);
});

test('a cut-off first line and a subagent line are skipped', () => {
    /* Given */
    const sidechain = JSON.stringify({...JSON.parse(launched('toolu_x', 'bx')), isSidechain: true});
    const lines = ['"half a line', sidechain, ...shell('gh run watch 1')];

    /* When */
    const tasks = runningBackgroundTasks(lines, BEFORE);

    /* Then */
    assert.deepStrictEqual(
        tasks.map((task) => task.id),
        ['b1'],
    );
});

test('a turn with no background tasks holds nothing', () => {
    /* When */
    const holds = turnHolds([]);

    /* Then */
    assert.strictEqual(holds, 'none');
});

test('a turn with only watches holds watches', () => {
    /* When */
    const holds = turnHolds([
        {id: 'b1', description: 'CI', watch: true},
        {id: 'b2', description: 'run', watch: true},
    ]);

    /* Then */
    assert.strictEqual(holds, 'watches');
});

test('one work task among watches holds work', () => {
    /* When */
    const holds = turnHolds([
        {id: 'b1', description: 'CI', watch: true},
        {id: 'b2', description: 'build', watch: false},
    ]);

    /* Then */
    assert.strictEqual(holds, 'work');
});
