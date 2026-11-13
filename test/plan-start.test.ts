import {test} from 'node:test';
import assert from 'node:assert/strict';

import {issueKeyString} from '../src/domain/plan/model';
import {
    issueBranchName,
    issueSessionPrompt,
    looseIssueSessionPrompt,
    MAP_LAUNCHERS,
    mapLauncherPrompt,
    wayfinderTicketPrompt,
} from '../src/domain/plan/start';
import {issueFromBranch} from '../src/domain/session-work/issues';

const REPO = 'JBlaak/switchboard';

test('a branch is named after the issue number and the first words of its title', () => {
    /* Given */
    const issue = {repository: REPO, number: 114, title: 'Zoom & pan: the stage, with a mini-map and more'};

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
        const branch = issueBranchName({repository: REPO, number: 122, title});

        /* Then */
        assert.deepEqual(issueFromBranch(branch, REPO), {repository: REPO, number: 122}, branch);
    }
});

test('accents are dropped and an empty slug leaves just the number', () => {
    /* When */
    const accented = issueBranchName({repository: REPO, number: 7, title: 'Café crème'});
    const empty = issueBranchName({repository: REPO, number: 8, title: '—'});

    /* Then */
    assert.equal(accented, '7-cafe-creme');
    assert.equal(empty, '8');
});

test('the session prompt names the issue and the epic', () => {
    /* Given */
    const issue = {repository: REPO, number: 114};
    const plan = {repository: REPO, number: 112};

    /* When */
    const prompt = issueSessionPrompt(issue, plan);

    /* Then */
    assert.equal(
        prompt,
        'Work on #114, part of #112. Read the epic and the issue first. Open a PR titled with a short summary of what you implemented, with "Closes #114" in its description.',
    );
});

test("a stacked session is asked to branch off the blocker's PR and target it", () => {
    /* Given */
    const issue = {repository: REPO, number: 114};
    const plan = {repository: REPO, number: 112};

    /* When */
    const prompt = issueSessionPrompt(issue, plan, 118);

    /* Then */
    assert.equal(
        prompt,
        'Work on #114, part of #112. Read the epic and the issue first. Open a PR titled with a short summary of what you implemented, with "Closes #114" in its description. ' +
            "Branch off PR #118's branch and open your PR against it.",
    );
});

test('an epic in another repository is named in full', () => {
    /* When */
    const prompt = issueSessionPrompt({repository: REPO, number: 3}, {repository: 'JBlaak/James', number: 22});

    /* Then */
    assert.ok(prompt.startsWith('Work on #3, part of JBlaak/James#22.'));
});

test('an issue key reads as owner/repo#n', () => {
    /* When */
    const text = issueKeyString({repository: REPO, number: 122});

    /* Then */
    assert.equal(text, 'JBlaak/switchboard#122');
});

test('a wayfinder ticket starts /wayfinder with the map and the ticket by bare number', () => {
    /* Given */
    const map = {repository: REPO, number: 2241};
    const ticket = {repository: REPO, number: 2250};

    /* When */
    const prompt = wayfinderTicketPrompt(ticket, map);

    /* Then */
    assert.equal(prompt, '/wayfinder 2241 2250');
});

test('a wayfinder ticket in another repository goes by its URL', () => {
    /* Given */
    const map = {repository: REPO, number: 2241};
    const ticket = {repository: 'MoveLab-Studio/Other', number: 7};

    /* When */
    const prompt = wayfinderTicketPrompt(ticket, map);

    /* Then */
    assert.equal(prompt, '/wayfinder 2241 https://github.com/MoveLab-Studio/Other/issues/7');
});

test("a map's launchers start the next ticket and reconcile the map, in that order", () => {
    /* Given */
    const map = {repository: REPO, number: 2241};

    /* When */
    const prompts = MAP_LAUNCHERS.map((launcher) => mapLauncherPrompt(launcher, map));

    /* Then */
    assert.deepEqual(prompts, ['/wayfinder 2241', '/reconciling-the-map 2241']);
});

// ── A loose issue, without a plan (#415) ──

const TICKET = {
    title: 'Export on the coach page',
    body: 'The export button does nothing.',
    author: 'pieter',
    comments: [
        {author: 'pieter', body: 'Also maybe the numbers were off?'},
        {author: 'marieke', body: 'Chrome on Windows, the athletes list.'},
    ],
    notes: 'It is the CSV export (ExportDialog). Ignore the numbers, that is #455.',
};

test('a loose issue is started without an epic, with your notes above the ticket and its thread', () => {
    /* Given */
    const issue = {repository: REPO, number: 482};

    /* When */
    const prompt = looseIssueSessionPrompt(issue, TICKET);

    /* Then */
    assert.equal(
        prompt,
        [
            'Work on #482, a loose issue in no plan. Read the issue below first. Open a PR titled with a short summary of what you implemented, with "Closes #482" in its description.',
            '',
            'My notes on it:\n<notes>\nIt is the CSV export (ExportDialog). Ignore the numbers, that is #455.\n</notes>',
            '',
            'The issue:\n<issue number="482" author="pieter">\n# Export on the coach page\n\nThe export button does nothing.\n</issue>',
            '',
            'Its newest comments, oldest first:\n<comment author="pieter">\nAlso maybe the numbers were off?\n</comment>\n<comment author="marieke">\nChrome on Windows, the athletes list.\n</comment>',
        ].join('\n'),
    );
    assert.doesNotMatch(prompt, /epic/);
});

test('a loose issue without notes or comments has just the ticket', () => {
    /* Given */
    const issue = {repository: REPO, number: 7};

    /* When */
    const prompt = looseIssueSessionPrompt(issue, {...TICKET, notes: '  ', comments: [], author: null});

    /* Then */
    assert.doesNotMatch(prompt, /<notes>|<comment/);
    assert.match(prompt, /<issue number="7" author="ghost">/);
});

test('continuing a loose issue on its branch reads the work so far first', () => {
    /* Given */
    const issue = {repository: REPO, number: 482};

    /* When */
    const prompt = looseIssueSessionPrompt(issue, TICKET, true);

    /* Then */
    assert.match(
        prompt,
        /^Continue work on #482, a loose issue in no plan: this branch already has earlier work on it\./,
    );
    assert.match(prompt, /"Closes #482" in its description, unless one is open already\./);
    assert.match(prompt, /<notes>/);
});

test("a loose issue gets the same branch as a plan's issue, which names it back", () => {
    /* Given */
    const issue = {repository: REPO, number: 482, title: TICKET.title};

    /* When */
    const branch = issueBranchName(issue);

    /* Then */
    assert.equal(branch, '482-export-on-the-coach-page');
    assert.deepEqual(issueFromBranch(branch, REPO), {repository: REPO, number: 482});
});
