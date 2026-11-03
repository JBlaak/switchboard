/**
 * Project hand-off on the project page (#276 stage 2): when Hand off to…
 * shows and what it opens, the dialog's lines, sizes and existing-copy note,
 * the run's and Bring back's states, what Remove copy lists, and the links
 * between a local project and its copies.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    bringBackView,
    capped,
    carriedLines,
    copyLinks,
    dirtyView,
    existingNote,
    fileSize,
    handOffOpens,
    originLine,
    runView,
    showsHandOff,
} from '../src/renderer/ui/project-page/handoff-view';
import type {HandoffHost, HandoffPreview} from '../src/application/services/project-handoff';

const LOCAL = '/Users/me/code/app';
const COPY = 'ssh://dev@buildbox/home/dev/projects/app';
const HOST: HandoffHost = {key: 'dev@buildbox:22', label: 'dev@buildbox'};
const OTHER: HandoffHost = {key: 'me@gpu:22', label: 'me@gpu'};
const PREVIEW: HandoffPreview = {branch: 'main', unpushed: 0, uncommitted: 0, candidates: [], existing: {}};

// ── Hand off to… ──

test('a local project with a VM host offers Hand off to…', () => {
    /* When */
    const shown = showsHandOff(LOCAL, [HOST]);

    /* Then */
    assert.equal(shown, true);
});

test('a local project with no VM host, or before the hosts are known, does not', () => {
    /* When */
    const none = showsHandOff(LOCAL, []);
    const unknown = showsHandOff(LOCAL, null);

    /* Then */
    assert.equal(none, false);
    assert.equal(unknown, false);
});

test('a remote or VM project never offers it', () => {
    /* When */
    const shown = showsHandOff(COPY, [HOST]);

    /* Then */
    assert.equal(shown, false);
});

test('with one host the button opens the dialog; with several, a picker', () => {
    /* When */
    const one = handOffOpens([HOST]);
    const several = handOffOpens([HOST, OTHER]);

    /* Then */
    assert.deepEqual(one, {kind: 'dialog', host: HOST});
    assert.deepEqual(several, {kind: 'picker', hosts: [HOST, OTHER]});
});

// ── The dialog ──

test('the dialog says what goes over: the branch, the commits and the changes', () => {
    /* When */
    const lines = carriedLines({...PREVIEW, branch: 'feature/x', unpushed: 3, uncommitted: 1});

    /* Then */
    assert.deepEqual(lines, [
        {text: 'Branch ', code: 'feature/x'},
        {text: '3 commits not on origin'},
        {text: '1 uncommitted change'},
    ]);
});

test('with nothing unpushed or uncommitted it says so', () => {
    /* When */
    const lines = carriedLines(PREVIEW);

    /* Then */
    assert.deepEqual(lines, [{text: 'Branch ', code: 'main'}, {text: 'Nothing unpushed or uncommitted'}]);
});

test('a copy already on the host is updated, and the dialog says so', () => {
    /* Given */
    const preview = {...PREVIEW, existing: {[HOST.key]: COPY}};

    /* When */
    const onHost = existingNote(preview, HOST);
    const elsewhere = existingNote(preview, OTHER);

    /* Then */
    assert.equal(onHost, 'Updates the copy on dev@buildbox');
    assert.equal(elsewhere, null);
});

test('file sizes are short', () => {
    /* When */
    const sizes = [fileSize(312), fileSize(4200), fileSize(52_000), fileSize(2_400_000)];

    /* Then */
    assert.deepEqual(sizes, ['312 B', '4.1 KB', '51 KB', '2.3 MB']);
});

// ── The run ──

test('before it runs the button says Hand off', () => {
    /* When */
    const view = runView({phase: 'idle'});

    /* Then */
    assert.deepEqual(view, {label: 'Hand off', disabled: false, lines: [], error: null, done: null, copyPath: null});
});

test('while it runs the button waits and the lines show', () => {
    /* When */
    const view = runView({phase: 'running', hostKey: HOST.key, lines: ['Cloning']});

    /* Then */
    assert.equal(view.label, 'Handing off…');
    assert.equal(view.disabled, true);
    assert.deepEqual(view.lines, ['Cloning']);
});

test('on success it says Handed off and opens the copy', () => {
    /* When */
    const view = runView({phase: 'done', hostKey: HOST.key, lines: [], copyPath: COPY, reused: false});

    /* Then */
    assert.equal(view.done, 'Handed off');
    assert.equal(view.label, 'Open the copy');
    assert.equal(view.copyPath, COPY);
});

test('on an error it shows the message and Retry', () => {
    /* When */
    const view = runView({phase: 'failed', hostKey: HOST.key, lines: ['Cloning'], error: 'No access to origin'});

    /* Then */
    assert.equal(view.label, 'Retry');
    assert.equal(view.error, 'No access to origin');
    assert.equal(view.copyPath, null);
});

// ── Bring back ──

test('Bring back waits while it runs, then names the branch', () => {
    /* When */
    const running = bringBackView({phase: 'running', lines: ['Pushing']});
    const done = bringBackView({phase: 'done', lines: [], worktree: '/w', branch: 'feature/x'});

    /* Then */
    assert.deepEqual([running.label, running.disabled], ['Bringing back…', true]);
    assert.equal(done.branch, 'feature/x');
});

test('Bring back that fails shows its message', () => {
    /* When */
    const view = bringBackView({phase: 'failed', lines: [], error: 'The push was rejected'});

    /* Then */
    assert.equal(view.error, 'The push was rejected');
    assert.equal(view.label, 'Retry');
});

// ── Remove copy ──

test('the work a copy has is listed, subjects and paths', () => {
    /* When */
    const view = dirtyView({
        branch: 'feature/x',
        unpushed: [{oid: 'a1', subject: 'Fix the parser'}],
        uncommitted: ['src/a.ts', 'src/b.ts'],
    });

    /* Then */
    assert.equal(view.commitsTitle, '1 commit not on origin');
    assert.deepEqual(view.commits, {shown: ['Fix the parser'], more: null});
    assert.equal(view.pathsTitle, '2 uncommitted changes');
    assert.deepEqual(view.paths, {shown: ['src/a.ts', 'src/b.ts'], more: null});
});

test('a long list is capped with "and N more"', () => {
    /* Given */
    const paths = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

    /* When */
    const list = capped(paths);

    /* Then */
    assert.deepEqual(list, {shown: ['a', 'b', 'c', 'd', 'e'], more: 'and 2 more'});
});

test('with only uncommitted changes there is no commits heading', () => {
    /* When */
    const view = dirtyView({branch: null, unpushed: [], uncommitted: ['x']});

    /* Then */
    assert.equal(view.commitsTitle, null);
});

// ── Links ──

test('the On VMs section links each copy with its host', () => {
    /* When */
    const links = copyLinks([{copyPath: COPY, hostKey: HOST.key, hostLabel: HOST.label}]);

    /* Then */
    assert.deepEqual(links, [{copyPath: COPY, title: 'dev@buildbox/app', host: 'dev@buildbox'}]);
});

test('a copy’s header names the local project it was copied from', () => {
    /* When */
    const line = originLine(LOCAL);

    /* Then */
    assert.equal(line, 'Copy of code/app');
});
