/**
 * Writing a schedule file from the page's settings: what a new file holds,
 * that the frontmatter parser reads back exactly what was written, and that
 * a save keeps the keys, `cli:` entries and comments it does not edit.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {scheduleFileName, scheduleFileText, scheduleSlug} from '../src/domain/schedule/file-writer';
import {parseFrontmatter} from '../src/domain/schedule/support/frontmatter';
import {parseSchedule} from '../src/domain/schedule/schedule';
import type {ScheduleSettings} from '../src/domain/schedule/manager';

const SETTINGS: ScheduleSettings = {
    name: 'Nightly dependency check',
    slug: 'nightly-dependency-check',
    projectPath: '/Users/me/code/app',
    cron: '20 3 * * *',
    enabled: true,
    prompt: 'Check the dependencies.\n\nEnd with a short report.',
    model: 'sonnet',
    permissionMode: 'acceptEdits',
    allowedTools: 'Read,Grep,Bash(npm outdated:*)',
    limitMinutes: 30,
    weekCap: 80,
    missed: 'run-once',
    worktree: true,
};

const LOCATION = {
    file: 'schedule-nightly-dependency-check.md',
    filePath: '/Users/me/code/app/.claude/commands/schedule-nightly-dependency-check.md',
    projectPath: '/Users/me/code/app',
    folder: '-Users-me-code-app',
};

test('a new file holds every setting in the frontmatter and the prompt as its body', () => {
    /* When */
    const text = scheduleFileText(SETTINGS);

    /* Then */
    assert.equal(
        text,
        [
            '---',
            'name: Nightly dependency check',
            'slug: nightly-dependency-check',
            'cron: 20 3 * * *',
            'enabled: true',
            'missed: run-once',
            'limit-minutes: 30',
            'week-cap: 80',
            'worktree: true',
            'cli:',
            '  model: sonnet',
            '  permission-mode: acceptEdits',
            '  allowed-tools: Read,Grep,Bash(npm outdated:*)',
            '---',
            '',
            'Check the dependencies.',
            '',
            'End with a short report.',
            '',
        ].join('\n'),
    );
});

test('the frontmatter parser reads back what was written', () => {
    /* Given */
    const text = scheduleFileText(SETTINGS);

    /* When */
    const {meta, body} = parseFrontmatter(text);
    const schedule = parseSchedule(text, LOCATION);

    /* Then */
    assert.deepEqual(meta, {
        name: 'Nightly dependency check',
        slug: 'nightly-dependency-check',
        cron: '20 3 * * *',
        enabled: 'true',
        missed: 'run-once',
        'limit-minutes': '30',
        'week-cap': '80',
        worktree: 'true',
        cli: {model: 'sonnet', 'permission-mode': 'acceptEdits', 'allowed-tools': 'Read,Grep,Bash(npm outdated:*)'},
    });
    assert.equal(body, SETTINGS.prompt);
    assert.equal(schedule?.slug, 'nightly-dependency-check');
    assert.equal(schedule?.cron, '20 3 * * *');
});

test('a setting without a value is left out rather than written empty', () => {
    /* When */
    const text = scheduleFileText({...SETTINGS, model: null, limitMinutes: null, weekCap: null});

    /* Then */
    const {meta} = parseFrontmatter(text);
    assert.equal('limit-minutes' in meta, false);
    assert.equal('week-cap' in meta, false);
    assert.deepEqual(meta.cli, {'permission-mode': 'acceptEdits', 'allowed-tools': 'Read,Grep,Bash(npm outdated:*)'});
});

test('a name over several lines is written as one', () => {
    /* When */
    const text = scheduleFileText({...SETTINGS, name: 'Nightly\ncheck '});

    /* Then */
    assert.equal(parseFrontmatter(text).meta.name, 'Nightly check');
});

test('a save keeps the keys, cli entries and comments the page does not edit', () => {
    /* Given: as the slash command writes one */
    const existing = [
        '---',
        'name: Old name',
        'cron: 0 9 * * 1-5',
        'enabled: true',
        'slug: nightly-dependency-check',
        'owner: me',
        'cli:',
        '  permission-mode: plan',
        '  allowed-tools: Read',
        '  # only include these if the user specified them:',
        '  max-budget-usd: 2',
        '  add-dirs: /tmp/shared',
        '---',
        '',
        'Old prompt',
        '',
    ].join('\n');

    /* When */
    const text = scheduleFileText(SETTINGS, existing);

    /* Then */
    assert.equal(
        text,
        [
            '---',
            'name: Nightly dependency check',
            'cron: 20 3 * * *',
            'enabled: true',
            'slug: nightly-dependency-check',
            'owner: me',
            'missed: run-once',
            'limit-minutes: 30',
            'week-cap: 80',
            'worktree: true',
            'cli:',
            '  permission-mode: acceptEdits',
            '  allowed-tools: Read,Grep,Bash(npm outdated:*)',
            '  # only include these if the user specified them:',
            '  max-budget-usd: 2',
            '  add-dirs: /tmp/shared',
            '  model: sonnet',
            '---',
            '',
            'Check the dependencies.',
            '',
            'End with a short report.',
            '',
        ].join('\n'),
    );
});

test('a save over a file with blocks before its keys reads back whole', () => {
    /* Given */
    const existing = [
        '---',
        'cli:',
        '    model: opus',
        '    max-budget-usd: 2',
        'extra:',
        '    keep: yes',
        'name: Old',
        '---',
        'Old prompt',
    ].join('\n');

    /* When */
    const {meta, body} = parseFrontmatter(scheduleFileText({...SETTINGS, model: null}, existing));

    /* Then */
    assert.deepEqual(meta.cli, {
        'max-budget-usd': '2',
        'permission-mode': 'acceptEdits',
        'allowed-tools': 'Read,Grep,Bash(npm outdated:*)',
    });
    assert.deepEqual(meta.extra, {keep: 'yes'});
    assert.equal(meta.name, 'Nightly dependency check');
    assert.equal(meta.cron, '20 3 * * *');
    assert.equal(meta['week-cap'], '80');
    assert.equal(body, SETTINGS.prompt);
});

test('a file without a cli block gets one at the end of its frontmatter', () => {
    /* Given */
    const existing = '---\nname: Old\ncron: 0 3 * * *\n---\nOld prompt\n';

    /* When */
    const {meta} = parseFrontmatter(scheduleFileText(SETTINGS, existing));

    /* Then */
    assert.deepEqual(meta.cli, {
        model: 'sonnet',
        'permission-mode': 'acceptEdits',
        'allowed-tools': 'Read,Grep,Bash(npm outdated:*)',
    });
});

test('turning a schedule off changes only its enabled line', () => {
    /* Given */
    const existing = scheduleFileText(SETTINGS);

    /* When */
    const text = scheduleFileText({...SETTINGS, enabled: false}, existing);

    /* Then */
    assert.equal(text, existing.replace('enabled: true', 'enabled: false'));
});

test('a slug is the name in lower-case words joined by hyphens', () => {
    /* Then */
    assert.equal(scheduleSlug('Nightly dependency check'), 'nightly-dependency-check');
    assert.equal(scheduleSlug('  Café: tidy the CHANGELOG!  '), 'cafe-tidy-the-changelog');
    assert.equal(scheduleSlug('***'), '');
    assert.equal(scheduleFileName('nightly-check'), 'schedule-nightly-check.md');
});
