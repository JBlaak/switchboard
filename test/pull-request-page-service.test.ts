import {test} from 'node:test';
import assert from 'node:assert/strict';

import {PullRequestPageService} from '../src/application/services/pull-request-page-service';
import {WorkPageRouter, type WorkPageBackend} from '../src/application/services/work-page-router';
import {ReviewService} from '../src/application/services/review-service';
import {GITHUB_REFRESH_MS} from '../src/application/services/session-work-service';
import {PEEK_ITEM_ID, pullRequestPageId} from '../src/domain/session-work/pull-request-link';
import {linkTarget} from '../src/infrastructure/electron/support/link-target';
import type {GitHubAvailability, PullRequestStatus, SessionWorkSnapshot} from '../src/domain/session-work/model';
import type {Timers} from '../src/application/ports/clock';
import type {StructuralDiffer} from '../src/application/ports/structural-differ';
import {REFINE_MAX_BYTES} from '../src/application/services/diff-refinements';
import {silentLog} from './support/fakes';

const REPO = 'o/app';
const URL = `https://github.com/${REPO}/pull/12`;
const PAGE = pullRequestPageId({repository: REPO, number: 12});
const ITEM = 'pr:' + URL;

const DIFF = [
    'diff --git a/a.txt b/a.txt',
    'index 1111111..2222222 100644',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1 +1 @@',
    '-one',
    '+two',
    '',
].join('\n');

function prStatus(extra: Partial<PullRequestStatus> = {}): PullRequestStatus {
    return {
        number: 12,
        url: URL,
        repository: REPO,
        title: 'Rename things',
        state: 'open',
        headSha: 'head-1',
        baseRef: 'main',
        nodeId: 'PR_12',
        closes: [],
        ...extra,
    };
}

/** Intervals fired by hand, with the ones still running on show. */
function manualTimers() {
    let seq = 0;
    const intervals = new Map<number, {fn: () => void; ms: number}>();
    const timers: Timers & {intervals: typeof intervals; fire(): void} = {
        intervals,
        setTimeout: () => ++seq,
        clearTimeout: () => {},
        setInterval(fn, ms) {
            intervals.set(++seq, {fn, ms});
            return seq;
        },
        clearInterval(handle) {
            if (handle != null) intervals.delete(handle as number);
        },
        fire() {
            for (const {fn} of [...intervals.values()]) fn();
        },
    };
    return timers;
}

function setup({
    gh = 'ok' as GitHubAvailability,
    prs = [prStatus()] as PullRequestStatus[] | null,
    diff = DIFF as string | null,
    /** Files on GitHub, by `commit:path`. */
    files = new Map<string, string | Uint8Array>(),
    mergeBase = 'merge-base-1' as string | null,
} = {}) {
    const world = {gh, prs, diff, files, mergeBase, statusCalls: 0, diffCalls: 0};
    /** Every file read from GitHub as `commit:path`, and every merge-base asked for as `base...head`. */
    const fileReads: string[] = [];
    const mergeBaseAsks: string[] = [];
    /** Every file handed to the differ, with both of its texts. */
    const refined: Array<{path: string; before: string; after: string}> = [];
    const differ: StructuralDiffer = {
        async refine(path, before, after) {
            refined.push({path, before, after});
            return {summary: null, before: {}, after: {1: [{start: 0, end: after.length, kind: 'update'}]}};
        },
    };
    const pushed: SessionWorkSnapshot[] = [];
    const timers = manualTimers();
    const service = new PullRequestPageService({
        github: {
            async available() {
                return world.gh;
            },
            async pullRequests(repo, numbers) {
                world.statusCalls++;
                assert.equal(repo, REPO);
                assert.deepEqual(numbers, [12]);
                return world.prs;
            },
            async pullRequestDiff(repo, number) {
                world.diffCalls++;
                assert.equal(repo, REPO);
                assert.equal(number, 12);
                return world.diff;
            },
            async fileAt(repo, sha, path) {
                assert.equal(repo, REPO);
                fileReads.push(sha + ':' + path);
                const file = world.files.get(sha + ':' + path);
                return file === undefined ? null : typeof file === 'string' ? new TextEncoder().encode(file) : file;
            },
            async mergeBase(repo, base, head) {
                assert.equal(repo, REPO);
                mergeBaseAsks.push(base + '...' + head);
                return world.mergeBase;
            },
        },
        renderer: {sessionWorkSnapshot: (snapshot) => pushed.push(snapshot)},
        differ,
        clock: {now: () => Date.UTC(2026, 10, 10, 12, 0, 0)},
        timers,
        log: silentLog,
    });
    return {service, world, pushed, timers, fileReads, mergeBaseAsks, refined};
}

// ── The peek ──

test('the peek answers the PR status and its parsed diff from GitHub', async () => {
    /* Given */
    const {service} = setup();

    /* When */
    const peek = await service.peek({repository: REPO, number: 12});

    /* Then */
    assert.equal(peek.error, undefined);
    assert.equal(peek.url, URL);
    assert.deepEqual(peek.ref, {repository: REPO, number: 12});
    assert.equal(peek.pr?.title, 'Rename things');
    assert.deepEqual(
        peek.files.map((file) => [file.path, file.additions, file.deletions]),
        [['a.txt', 1, 1]],
    );
});

test('the peek says gh is missing instead of rejecting', async () => {
    /* Given */
    const {service, world} = setup({gh: 'missing'});

    /* When */
    const peek = await service.peek({repository: REPO, number: 12});

    /* Then */
    assert.match(peek.error ?? '', /gh is not installed/);
    assert.equal(peek.pr, null);
    assert.deepEqual(peek.files, []);
    assert.equal(world.statusCalls + world.diffCalls, 0);
});

test('the peek says gh is signed out', async () => {
    /* Given */
    const {service} = setup({gh: 'unauthenticated'});

    /* When */
    const peek = await service.peek({repository: REPO, number: 12});

    /* Then */
    assert.match(peek.error ?? '', /not signed in/);
});

test('the peek of a PR GitHub does not know says so', async () => {
    /* Given */
    const {service} = setup({prs: [], diff: null});

    /* When */
    const peek = await service.peek({repository: REPO, number: 12});

    /* Then */
    assert.match(peek.error ?? '', /does not know this PR/);
    assert.equal(peek.pr, null);
});

test('the peek turns a failing gh into an error rather than a rejection', async () => {
    /* Given */
    const {service} = setup();
    (service as unknown as {deps: {github: {available(): Promise<never>}}}).deps.github.available = async () => {
        throw new Error('gh crashed');
    };

    /* When */
    const peek = await service.peek({repository: REPO, number: 12});

    /* Then */
    assert.equal(peek.error, 'gh crashed');
});

test('the peek refuses a ref that is not a pull request', async () => {
    /* Given */
    const {service, world} = setup();

    /* When */
    const peek = await service.peek({repository: '../etc', number: -1});

    /* Then */
    assert.match(peek.error ?? '', /not a pull request/);
    assert.equal(world.statusCalls + world.diffCalls, 0);
});

// ── The PR's own page ──

test('opening a PR page answers a snapshot of the one PR, handing nothing to Claude', async () => {
    /* Given */
    const {service, pushed} = setup();

    /* When */
    const snapshot = await service.open(PAGE);

    /* Then */
    assert.ok(snapshot);
    assert.equal(snapshot.sessionId, PAGE);
    assert.equal(snapshot.repository, REPO);
    assert.equal(snapshot.gh, 'ok');
    assert.deepEqual(snapshot.footprint, {worktrees: 0, branches: 0});
    assert.equal(snapshot.items.length, 1);
    const [item] = snapshot.items;
    assert.equal(item.id, ITEM);
    assert.equal(item.kind, 'pr');
    if (item.kind !== 'pr') return;
    assert.equal(item.pr.title, 'Rename things');
    assert.equal(item.location, null);
    assert.deepEqual(item.diff, {kind: 'pull-request', repository: REPO, number: 12});
    assert.equal(item.otherRepository, true);
    assert.deepEqual(pushed, [snapshot]);
});

test('a PR page gh cannot answer for still opens, with the PR as its link says and the reason', async () => {
    /* Given */
    const {service} = setup({gh: 'missing'});

    /* When */
    const snapshot = await service.open(PAGE);

    /* Then */
    assert.ok(snapshot);
    assert.equal(snapshot.gh, 'missing');
    const [item] = snapshot.items;
    assert.equal(item.kind, 'pr');
    if (item.kind !== 'pr') return;
    assert.deepEqual(item.pr, {number: 12, url: URL, repository: REPO, closes: []});
    assert.match(item.error ?? '', /gh is not installed/);
});

test('a page id that is not a PR does not open', async () => {
    /* Given */
    const {service} = setup();

    /* When */
    const snapshot = await service.open('session-1');

    /* Then */
    assert.equal(snapshot, null);
    assert.equal(service.canOpen('session-1'), false);
    assert.equal(service.canOpen(PAGE), true);
});

test("the PR page's diff is GitHub's, fetched once per head commit", async () => {
    /* Given */
    const {service, world} = setup();
    await service.open(PAGE);

    /* When */
    const first = await service.diff(PAGE, ITEM);
    const second = await service.diff(PAGE, ITEM);

    /* Then */
    assert.equal(first.source, 'github');
    assert.deepEqual(
        first.files.map((file) => file.path),
        ['a.txt'],
    );
    assert.deepEqual(second, first);
    assert.equal(world.diffCalls, 1);
});

test('a diff GitHub would not send shows on the item', async () => {
    /* Given */
    const {service, pushed} = setup({diff: null});
    await service.open(PAGE);

    /* When */
    const diff = await service.diff(PAGE, ITEM);

    /* Then */
    assert.equal(diff.source, null);
    assert.equal(diff.error, 'GitHub did not send the diff');
    assert.equal(pushed.at(-1)?.items[0].error, 'GitHub did not send the diff');
});

test('the PR page polls GitHub while open, and pushes what changed', async () => {
    /* Given */
    const {service, world, pushed, timers} = setup();
    await service.open(PAGE);
    assert.deepEqual(
        [...timers.intervals.values()].map((interval) => interval.ms),
        [GITHUB_REFRESH_MS],
    );
    world.prs = [prStatus({state: 'merged'})];

    /* When */
    timers.fire();
    await service.refreshGitHub(PAGE);

    /* Then */
    const last = pushed.at(-1)?.items[0];
    assert.equal(last?.kind === 'pr' && last.pr.state, 'merged');
});

test('closing the PR page stops the poll and forgets the page', async () => {
    /* Given */
    const {service, timers} = setup();
    await service.open(PAGE);

    /* When */
    service.close(PAGE);

    /* Then */
    assert.equal(timers.intervals.size, 0);
    assert.equal(service.openPageId, null);
    assert.equal(service.item(PAGE, ITEM), null);
    assert.deepEqual(await service.diff(PAGE, ITEM), {files: [], source: null});
});

test('closeAll stops the poll too', async () => {
    /* Given */
    const {service, timers} = setup();
    await service.open(PAGE);

    /* When */
    service.closeAll();

    /* Then */
    assert.equal(timers.intervals.size, 0);
});

test('opening another PR page closes the first', async () => {
    /* Given */
    const {service, timers} = setup({prs: [prStatus(), prStatus({number: 13, url: URL.replace('12', '13')})]});
    await service.open(PAGE);
    const other = pullRequestPageId({repository: REPO, number: 13});
    (service as unknown as {deps: {github: {pullRequests: unknown}}}).deps.github.pullRequests = async () => [];

    /* When */
    await service.open(other);

    /* Then */
    assert.equal(service.openPageId, other);
    assert.equal(timers.intervals.size, 1);
});

test("the PR page's context has its repository and gh's answer", async () => {
    /* Given */
    const {service} = setup();
    await service.open(PAGE);

    /* When */
    const context = service.context(PAGE);

    /* Then */
    assert.deepEqual(context, {repository: REPO, gh: 'ok'});
});

// ── OmniDiff refinements ──

const REFINE_DIFF = [
    'diff --git a/a.txt b/a.txt',
    'index 1111111..2222222 100644',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1 +1 @@',
    '-one',
    '+two',
    'diff --git a/src/old.ts b/src/new.ts',
    'similarity index 90%',
    'rename from src/old.ts',
    'rename to src/new.ts',
    'index 3333333..4444444 100644',
    '--- a/src/old.ts',
    '+++ b/src/new.ts',
    '@@ -1 +1 @@',
    '-let a = 1;',
    '+const a = 1;',
    'diff --git a/src/added.ts b/src/added.ts',
    'new file mode 100644',
    'index 0000000..5555555',
    '--- /dev/null',
    '+++ b/src/added.ts',
    '@@ -0,0 +1 @@',
    '+export {};',
    '',
].join('\n');

/** An open PR page whose diff has been served, with both sides of its files on GitHub. */
async function refinePage(files: Array<[string, string | Uint8Array]> = []) {
    const harness = setup({
        diff: REFINE_DIFF,
        files: new Map<string, string | Uint8Array>([
            ['merge-base-1:a.txt', 'one\n'],
            ['head-1:a.txt', 'two\n'],
            ['merge-base-1:src/old.ts', 'let a = 1;\n'],
            ['head-1:src/new.ts', 'const a = 1;\n'],
            ['head-1:src/added.ts', 'export {};\n'],
            ...files,
        ]),
    });
    await harness.service.open(PAGE);
    await harness.service.diff(PAGE, ITEM);
    return harness;
}

test("a PR page's file is refined from GitHub at the merge-base and the PR's head commit", async () => {
    /* Given */
    const {service, fileReads, mergeBaseAsks, refined} = await refinePage();

    /* When */
    const refinement = await service.refinement(PAGE, ITEM, 'a.txt');

    /* Then */
    assert.deepEqual(refinement?.after[1], [{start: 0, end: 'two\n'.length, kind: 'update'}]);
    assert.deepEqual(mergeBaseAsks, ['main...head-1']);
    assert.deepEqual(fileReads, ['merge-base-1:a.txt', 'head-1:a.txt']);
    assert.deepEqual(refined, [{path: 'a.txt', before: 'one\n', after: 'two\n'}]);
});

test("a renamed file on a PR page is read at its old path on the merge-base's side", async () => {
    /* Given */
    const {service, fileReads, refined} = await refinePage();

    /* When */
    await service.refinement(PAGE, ITEM, 'src/new.ts');

    /* Then */
    assert.deepEqual(fileReads, ['merge-base-1:src/old.ts', 'head-1:src/new.ts']);
    assert.deepEqual(refined, [{path: 'src/new.ts', before: 'let a = 1;\n', after: 'const a = 1;\n'}]);
});

test('the merge-base is asked for once per served diff, not once per file', async () => {
    /* Given */
    const {service, mergeBaseAsks} = await refinePage();

    /* When */
    await service.refinement(PAGE, ITEM, 'a.txt');
    await service.refinement(PAGE, ITEM, 'src/new.ts');

    /* Then */
    assert.deepEqual(mergeBaseAsks, ['main...head-1']);
});

test('a PR page refuses anything but a refinable file in the diff it last served, and never asks GitHub', async () => {
    /* Given */
    const {service, fileReads, mergeBaseAsks, refined} = await refinePage([['merge-base-1:secret.ts', 'x']]);

    /* When */
    const refused = await Promise.all([
        service.refinement(PAGE, ITEM, 'secret.ts'),
        service.refinement(PAGE, ITEM, 'src/old.ts'),
        service.refinement(PAGE, ITEM, 'src/added.ts'),
        service.refinement(PAGE, 'pr:other', 'a.txt'),
        service.refinement(pullRequestPageId({repository: REPO, number: 13}), ITEM, 'a.txt'),
    ]);

    /* Then */
    assert.deepEqual(refused, [null, null, null, null, null]);
    assert.deepEqual(fileReads, []);
    assert.deepEqual(mergeBaseAsks, []);
    assert.deepEqual(refined, []);
});

test('a PR page whose diff has not been asked for refines nothing', async () => {
    /* Given */
    const {service, fileReads, mergeBaseAsks} = setup({diff: REFINE_DIFF});
    await service.open(PAGE);

    /* When */
    const refinement = await service.refinement(PAGE, ITEM, 'a.txt');

    /* Then */
    assert.equal(refinement, null);
    assert.deepEqual(fileReads, []);
    assert.deepEqual(mergeBaseAsks, []);
});

test('a side from GitHub over 1 MB, with a NUL in it, or not UTF-8 is not refined', async () => {
    /* Given */
    // Latin-1 é: a byte UTF-8 has no character for.
    const sides = ['x'.repeat(REFINE_MAX_BYTES + 1), 'a\0b', new Uint8Array([0x63, 0x61, 0x66, 0xe9])];
    const harnesses = await Promise.all(sides.map((after) => refinePage([['head-1:a.txt', after]])));

    /* When */
    const answers = await Promise.all(harnesses.map(({service}) => service.refinement(PAGE, ITEM, 'a.txt')));

    /* Then */
    assert.deepEqual(answers, [null, null, null]);
    assert.deepEqual(
        harnesses.flatMap(({refined}) => refined),
        [],
    );
});

test('a refinement from GitHub is kept: asking again makes no gh call', async () => {
    /* Given */
    const {service, fileReads, mergeBaseAsks, refined} = await refinePage();
    await service.refinement(PAGE, ITEM, 'a.txt');
    const calls = fileReads.length + mergeBaseAsks.length;

    /* When */
    const again = await service.refinement(PAGE, ITEM, 'a.txt');

    /* Then */
    assert.ok(again);
    assert.equal(fileReads.length + mergeBaseAsks.length, calls);
    assert.equal(refined.length, 1);
});

test('a refinement GitHub could not give is asked for again, merge-base and files both', async () => {
    /* Given */
    const {service, world, fileReads, mergeBaseAsks} = await refinePage();
    world.mergeBase = null;
    const first = await service.refinement(PAGE, ITEM, 'a.txt');
    world.mergeBase = 'merge-base-1';
    world.files.delete('head-1:a.txt');
    const second = await service.refinement(PAGE, ITEM, 'a.txt');
    world.files.set('head-1:a.txt', 'two\n');

    /* When */
    const third = await service.refinement(PAGE, ITEM, 'a.txt');

    /* Then */
    assert.equal(first, null);
    assert.equal(second, null);
    assert.ok(third);
    assert.deepEqual(mergeBaseAsks, ['main...head-1', 'main...head-1']);
    assert.deepEqual(fileReads, ['merge-base-1:a.txt', 'head-1:a.txt', 'merge-base-1:a.txt', 'head-1:a.txt']);
});

test('a PR whose base branch GitHub did not name is not refined', async () => {
    /* Given */
    const {service, mergeBaseAsks, fileReads} = setup({diff: REFINE_DIFF, prs: [prStatus({baseRef: undefined})]});
    await service.open(PAGE);
    await service.diff(PAGE, ITEM);

    /* When */
    const refinement = await service.refinement(PAGE, ITEM, 'a.txt');

    /* Then */
    assert.equal(refinement, null);
    assert.deepEqual(mergeBaseAsks, []);
    assert.deepEqual(fileReads, []);
});

// ── The router ──

/** A peek of the PR whose diff has both sides of its files on GitHub; no page is open. */
async function refinePeek() {
    const harness = setup({
        diff: REFINE_DIFF,
        files: new Map<string, string | Uint8Array>([
            ['merge-base-1:a.txt', 'one\n'],
            ['head-1:a.txt', 'two\n'],
        ]),
    });
    await harness.service.peek({repository: REPO, number: 12});
    return harness;
}

test("the peek's file is refined from GitHub at the merge-base and the PR's head commit, with no page open", async () => {
    /* Given */
    const {service, fileReads, mergeBaseAsks, refined} = await refinePeek();

    /* When */
    const refinement = await service.refinement(PAGE, PEEK_ITEM_ID, 'a.txt');

    /* Then */
    assert.deepEqual(refinement?.after[1], [{start: 0, end: 'two\n'.length, kind: 'update'}]);
    assert.deepEqual(mergeBaseAsks, ['main...head-1']);
    assert.deepEqual(fileReads, ['merge-base-1:a.txt', 'head-1:a.txt']);
    assert.deepEqual(refined, [{path: 'a.txt', before: 'one\n', after: 'two\n'}]);
});

test('the peek refuses a file not in the diff it last showed, another PR, or no peek at all, and never asks GitHub', async () => {
    /* Given */
    const {service, fileReads, mergeBaseAsks} = await refinePeek();
    const unpeeked = setup({diff: REFINE_DIFF});

    /* When */
    const refused = await Promise.all([
        service.refinement(PAGE, PEEK_ITEM_ID, 'secret.ts'),
        service.refinement(PAGE, PEEK_ITEM_ID, 'src/added.ts'),
        service.refinement(pullRequestPageId({repository: REPO, number: 13}), PEEK_ITEM_ID, 'a.txt'),
        unpeeked.service.refinement(PAGE, PEEK_ITEM_ID, 'a.txt'),
    ]);

    /* Then */
    assert.deepEqual(refused, [null, null, null, null]);
    assert.deepEqual(fileReads, []);
    assert.deepEqual(mergeBaseAsks, []);
    assert.deepEqual(unpeeked.fileReads, []);
});

function recordingBackend(name: string, calls: string[]): WorkPageBackend {
    return {
        async open(pageId) {
            calls.push(`${name}.open ${pageId}`);
            return null;
        },
        canOpen: (pageId) => {
            calls.push(`${name}.canOpen ${pageId}`);
            return true;
        },
        close: (pageId) => calls.push(`${name}.close ${pageId}`),
        closeAll: () => calls.push(`${name}.closeAll`),
        async diff(pageId) {
            calls.push(`${name}.diff ${pageId}`);
            return {files: [], source: null};
        },
        async image(pageId) {
            calls.push(`${name}.image ${pageId}`);
            return null;
        },
        async refinement(pageId) {
            calls.push(`${name}.refinement ${pageId}`);
            return null;
        },
        item: (pageId) => {
            calls.push(`${name}.item ${pageId}`);
            return null;
        },
        context: (pageId) => {
            calls.push(`${name}.context ${pageId}`);
            return null;
        },
        async refreshGitHub(pageId) {
            calls.push(`${name}.refreshGitHub ${pageId}`);
        },
    };
}

test('the router sends PR page ids to the PR pages and the rest to the sessions', async () => {
    /* Given */
    const calls: string[] = [];
    const router = new WorkPageRouter(recordingBackend('sessions', calls), recordingBackend('prs', calls));

    /* When */
    await router.canOpen('s1');
    await router.diff(PAGE, ITEM);
    await router.image('s1', 'x', 'a.png', 'after');
    await router.refinement(PAGE, ITEM, 'a.txt');
    await router.refinement('s1', 'x', 'a.txt');
    router.item(PAGE, ITEM);
    router.context('s1');
    await router.refreshGitHub(PAGE);
    router.close('s1');

    /* Then */
    assert.deepEqual(calls, [
        'sessions.canOpen s1',
        `prs.diff ${PAGE}`,
        'sessions.image s1',
        `prs.refinement ${PAGE}`,
        'sessions.refinement s1',
        `prs.item ${PAGE}`,
        'sessions.context s1',
        `prs.refreshGitHub ${PAGE}`,
        'sessions.close s1',
    ]);
});

test('opening either kind of page closes the other kind', async () => {
    /* Given */
    const calls: string[] = [];
    const router = new WorkPageRouter(recordingBackend('sessions', calls), recordingBackend('prs', calls));

    /* When */
    await router.open(PAGE);
    await router.open('s1');

    /* Then */
    assert.deepEqual(calls, ['sessions.closeAll', `prs.open ${PAGE}`, 'prs.closeAll', 'sessions.open s1']);
});

// ── Your review on a PR page ──

test('your review on a PR page can be submitted', async () => {
    /* Given */
    const {service} = setup({
        prs: [prStatus({pendingReviewId: 'PRR_1', pendingReview: [{path: 'a.txt', line: 1, body: 'Hm'} as never]})],
    });
    const router = new WorkPageRouter(recordingBackend('sessions', []), service);
    await router.open(PAGE);
    const submitted: string[] = [];
    const review = new ReviewService({
        github: {
            startPendingReview: async () => ({ok: true, reviewId: 'PRR_2'}),
            addPendingComment: async () => ({ok: true, threadId: 'T'}),
            deletePendingReview: async () => ({ok: true}),
            submitPendingReview: async (reviewId) => {
                submitted.push(reviewId);
                return {ok: true};
            },
        },
        page: router,
        log: silentLog,
    });

    /* When */
    const plain = await review.review({sessionId: PAGE, itemId: ITEM, mode: 'submit'});

    /* Then */
    assert.deepEqual(plain, {ok: true});
    assert.deepEqual(submitted, ['PRR_1']);
});

// ── Stray links in the main window ──

test('the main window keeps PR links for its own viewer; other links go to the browser', () => {
    /* Given */
    const files = URL + '/files';

    /* When */
    const routed = [
        linkTarget(files, true),
        linkTarget('https://github.com/o/app/issues/3', true),
        linkTarget('file:///etc/passwd', true),
    ];

    /* Then */
    assert.deepEqual(routed, ['pull-request', 'browser', null]);
});

test('a window that does not show PRs itself sends their links to the browser', () => {
    /* Given */
    const url = URL;

    /* When */
    const target = linkTarget(url, false);

    /* Then */
    assert.equal(target, 'browser');
});
