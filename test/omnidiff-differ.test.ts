import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {OmnidiffDiffer} from '../src/infrastructure/omnidiff/omnidiff-differ';
import {locateOmnidiff, omnidiffPaths} from '../src/infrastructure/omnidiff/locate-omnidiff';
import type {Logger} from '../src/application/ports/logger';
import {silentLog} from './support/fakes';

/** The real OmniDiff, where a checkout has fetched it (or `OMNIDIFF_BIN` names one); the test that needs it skips without it. */
const REAL_OMNIDIFF =
    process.env.OMNIDIFF_BIN ?? path.join(__dirname, '..', 'vendor', 'omnidiff', process.arch, 'omnidiff');

const JSON_OUT = JSON.stringify({
    before: {path: 'b', language: 'TypeScript', hunks: []},
    after: {
        path: 'a',
        language: 'TypeScript',
        hunks: [{operation: 'insert', range: {start_row: 0, start_column: 4, end_row: 0, end_column: 7}}],
    },
    large_residual: false,
});

/** A directory of its own for one test, removed when the process ends. */
function scratch(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnidiff-test-'));
    process.on('exit', () => fs.rmSync(dir, {recursive: true, force: true}));
    return dir;
}

/** A stand-in `omnidiff`: a shell script that records how it was run, then runs `body`. */
function fakeOmnidiff(dir: string, body: string): string {
    const script = path.join(dir, 'omnidiff');
    fs.writeFileSync(
        script,
        [
            '#!/bin/sh',
            `printf '%s\\n' "$@" > '${dir}/args'`,
            `env > '${dir}/env'`,
            `cp "$4" '${dir}/before-seen'; cp "$5" '${dir}/after-seen'`,
            body,
            '',
        ].join('\n'),
        {mode: 0o755},
    );
    return script;
}

function recordingLog(): Logger & {lines: string[]} {
    const lines: string[] = [];
    const record =
        (level: string) =>
        (...args: unknown[]) =>
            lines.push(level + ' ' + args.join(' '));
    return {lines, debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error')};
}

test("OmniDiff's JSON comes back as marks, from both texts written under the file's own name", async () => {
    /* Given */
    const dir = scratch();
    const tempDir = scratch();
    const differ = new OmnidiffDiffer({binary: fakeOmnidiff(dir, `echo '${JSON_OUT}'`), log: silentLog, tempDir});

    /* When */
    const refinement = await differ.refine('src/cart.ts', 'old\n', 'let xyz;\n');

    /* Then */
    assert.deepEqual(refinement, {summary: null, before: {}, after: {1: [{start: 4, end: 7, kind: 'insert'}]}});
    const args = fs.readFileSync(path.join(dir, 'args'), 'utf8').trim().split('\n');
    assert.deepEqual(args.slice(0, 3), ['--mode', 'json', '--minimal']);
    assert.match(args[3], /\/before\/cart\.ts$/);
    assert.match(args[4], /\/after\/cart\.ts$/);
    assert.equal(fs.readFileSync(path.join(dir, 'before-seen'), 'utf8'), 'old\n');
    assert.equal(fs.readFileSync(path.join(dir, 'after-seen'), 'utf8'), 'let xyz;\n');
});

test("OmniDiff runs with its config, HOME and colours kept away from the user's own", async () => {
    /* Given */
    const dir = scratch();
    const tempDir = scratch();
    const differ = new OmnidiffDiffer({binary: fakeOmnidiff(dir, `echo '${JSON_OUT}'`), log: silentLog, tempDir});

    /* When */
    await differ.refine('a.ts', 'a\n', 'b\n');

    /* Then */
    const env = Object.fromEntries(
        fs
            .readFileSync(path.join(dir, 'env'), 'utf8')
            .trim()
            .split('\n')
            .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
    assert.equal(env.NO_COLOR, '1');
    for (const name of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) {
        assert.ok(env[name].startsWith(fs.realpathSync(tempDir)) || env[name].startsWith(tempDir), name);
    }
});

test('the temporary files are gone after a run, whether it worked or not', async () => {
    /* Given */
    const tempDir = scratch();
    const worked = new OmnidiffDiffer({binary: fakeOmnidiff(scratch(), `echo '${JSON_OUT}'`), log: silentLog, tempDir});
    const failed = new OmnidiffDiffer({binary: fakeOmnidiff(scratch(), 'exit 2'), log: silentLog, tempDir});

    /* When */
    await worked.refine('a.ts', 'a\n', 'b\n');
    await failed.refine('a.ts', 'a\n', 'b\n');

    /* Then */
    assert.deepEqual(fs.readdirSync(tempDir), []);
});

test('an OmniDiff that exits 2 has no refinement, and is logged below an error', async () => {
    /* Given */
    const log = recordingLog();
    const differ = new OmnidiffDiffer({
        binary: fakeOmnidiff(scratch(), 'echo "cannot parse" >&2; exit 2'),
        log,
        tempDir: scratch(),
    });

    /* When */
    const refinement = await differ.refine('a.ts', 'a\n', 'b\n');

    /* Then */
    assert.equal(refinement, null);
    assert.ok(log.lines.length > 0);
    assert.ok(log.lines.every((line) => line.startsWith('debug')));
});

test('output that is not JSON, or not JSON OmniDiff writes, has no refinement', async () => {
    /* Given */
    const tempDir = scratch();
    const notJson = new OmnidiffDiffer({binary: fakeOmnidiff(scratch(), 'echo hello'), log: silentLog, tempDir});
    const otherJson = new OmnidiffDiffer({
        binary: fakeOmnidiff(scratch(), `echo '{"binary":true,"before":{"hunks":[]},"after":{"hunks":[]}}'`),
        log: silentLog,
        tempDir,
    });

    /* When */
    const answers = await Promise.all([notJson.refine('a.ts', 'a', 'b'), otherJson.refine('a.ts', 'a', 'b')]);

    /* Then */
    assert.deepEqual(answers, [null, null]);
});

test('an OmniDiff that hangs is killed at the timeout, with no refinement', async () => {
    /* Given */
    const log = recordingLog();
    const tempDir = scratch();
    const differ = new OmnidiffDiffer({
        binary: fakeOmnidiff(scratch(), `sleep 5; echo '${JSON_OUT}'`),
        log,
        tempDir,
        timeoutMs: 200,
    });
    const started = Date.now();

    /* When */
    const refinement = await differ.refine('a.ts', 'a\n', 'b\n');

    /* Then */
    assert.equal(refinement, null);
    assert.ok(Date.now() - started < 3000, 'did not wait for it');
    assert.ok(log.lines.some((line) => line.startsWith('warn') && line.includes('timed out')));
    assert.deepEqual(fs.readdirSync(tempDir), []);
});

test('output past the cap has no refinement', async () => {
    /* Given */
    const differ = new OmnidiffDiffer({
        binary: fakeOmnidiff(scratch(), `echo '${JSON_OUT}'`),
        log: silentLog,
        tempDir: scratch(),
        maxOutputBytes: 16,
    });

    /* When */
    const refinement = await differ.refine('a.ts', 'a\n', 'b\n');

    /* Then */
    assert.equal(refinement, null);
});

test('a binary that cannot be run has no refinement', async () => {
    /* Given */
    const differ = new OmnidiffDiffer({binary: '/nonexistent/omnidiff', log: silentLog, tempDir: scratch()});

    /* When */
    const refinement = await differ.refine('a.ts', 'a\n', 'b\n');

    /* Then */
    assert.equal(refinement, null);
});

test('no more OmniDiffs run at once than allowed; the rest wait their turn', async () => {
    /* Given */
    const dir = scratch();
    const runs = path.join(dir, 'runs');
    const body = [`echo start >> '${runs}'`, 'sleep 0.2', `echo end >> '${runs}'`, `echo '${JSON_OUT}'`].join('\n');
    const differ = new OmnidiffDiffer({
        binary: fakeOmnidiff(dir, body),
        log: silentLog,
        tempDir: scratch(),
        maxConcurrent: 2,
    });

    /* When */
    const answers = await Promise.all([1, 2, 3, 4, 5].map((n) => differ.refine(`f${n}.ts`, 'a\n', 'b\n')));

    /* Then */
    assert.ok(answers.every((answer) => answer !== null));
    let running = 0;
    let most = 0;
    for (const event of fs.readFileSync(runs, 'utf8').trim().split('\n')) {
        running += event === 'start' ? 1 : -1;
        most = Math.max(most, running);
    }
    assert.equal(most, 2);
});

test(
    'the real OmniDiff finds the `* item.quantity` added to a line',
    {skip: !fs.existsSync(REAL_OMNIDIFF)},
    async () => {
        /* Given */
        const before = [
            'export function total(items: Item[]): number {',
            '    let sum = 0;',
            '    for (const item of items) {',
            '        sum += item.price;',
            '    }',
            '    return sum;',
            '}',
            '',
        ].join('\n');
        const after = before.replace('item.price;', 'item.price * item.quantity;');
        const tempDir = scratch();
        const differ = new OmnidiffDiffer({binary: REAL_OMNIDIFF, log: silentLog, tempDir});

        /* When */
        const refinement = await differ.refine('src/cart.ts', before, after);

        /* Then */
        const line = after.split('\n')[3];
        const marks = refinement?.after[4] ?? [];
        assert.ok(
            marks.some((mark) => line.slice(mark.start, mark.end).includes('* item.quantity')),
            JSON.stringify(refinement),
        );
        assert.deepEqual(fs.readdirSync(tempDir), []);
    },
);

test('the binary is in the resources when packaged, and under vendor/<arch> in a checkout', () => {
    /* When */
    const packaged = omnidiffPaths({packaged: true, resourcesPath: '/App/Resources', appPath: '/x', arch: 'arm64'});
    const checkout = omnidiffPaths({packaged: false, resourcesPath: '/x', appPath: '/code/sb', arch: 'arm64'});

    /* Then */
    assert.deepEqual(packaged, ['/App/Resources/omnidiff/omnidiff']);
    assert.equal(checkout[0], '/code/sb/vendor/omnidiff/arm64/omnidiff');
});

test('locateOmnidiff finds the checkout binary when the app was started on its app/ build folder', () => {
    /* Given */
    const checkout = scratch();
    const appPath = path.join(checkout, 'app');
    fs.mkdirSync(appPath);
    const binary = path.join(checkout, 'vendor', 'omnidiff', 'arm64', 'omnidiff');
    fs.mkdirSync(path.dirname(binary), {recursive: true});
    fs.writeFileSync(binary, '#!/bin/sh\n', {mode: 0o755});

    /* When */
    const found = locateOmnidiff({packaged: false, resourcesPath: '/x', appPath, arch: 'arm64'});

    /* Then */
    assert.equal(found, binary);
});

test('locateOmnidiff finds an executable file, and nothing else', () => {
    /* Given */
    const appPath = scratch();
    const where = {packaged: false, resourcesPath: '/x', appPath, arch: 'arm64'};
    const binary = path.join(appPath, 'vendor', 'omnidiff', 'arm64', 'omnidiff');

    /* When */
    const missing = locateOmnidiff(where);
    fs.mkdirSync(binary, {recursive: true});
    const directory = locateOmnidiff(where);
    fs.rmdirSync(binary);
    fs.writeFileSync(binary, '#!/bin/sh\n', {mode: 0o644});
    const notExecutable = locateOmnidiff(where);
    fs.chmodSync(binary, 0o755);
    const found = locateOmnidiff(where);

    /* Then */
    assert.equal(missing, null);
    assert.equal(directory, null);
    assert.equal(notExecutable, null);
    assert.equal(found, binary);
});
