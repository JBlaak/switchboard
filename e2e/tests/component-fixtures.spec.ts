/**
 * The contract behind the component suite's fixtures.
 *
 * component/fixtures/*.json hold what the real app answers for an e2e fixture
 * home (its project list, say), with the home's temporary path replaced by
 * FIXTURE_HOME. Component tests answer the renderer with them, so this test
 * keeps them true: it asks the real main process again and compares.
 *
 * After a change to the fixture or to what main answers, rewrite them with
 * `SB_UPDATE_COMPONENT_FIXTURES=1 npm run test:e2e -- component-fixtures`.
 */
import fs from 'node:fs';
import path from 'node:path';
import {test, expect} from '../support/test';
import {FIXTURE_HOME, captured, type CapturedFixture} from '../../component/fixtures/captured';
import type {Page} from '@playwright/test';
import {encodeProjectPath, type FixtureHome} from '../support/fixture-home';

const UPDATE = process.env.SB_UPDATE_COMPONENT_FIXTURES === '1';

/** What the renderer gets for the standard fixture, with the home made stable. */
async function capture(page: Page, home: FixtureHome): Promise<CapturedFixture> {
    const answers = await page.evaluate(async () => ({
        projects: await window.api.getProjects(false),
        projectsWithArchived: await window.api.getProjects(true),
    }));
    // The transcript folder names encode the path too.
    const json = JSON.stringify(answers)
        .split(home.home)
        .join(FIXTURE_HOME)
        .split(encodeProjectPath(home.home))
        .join(encodeProjectPath(FIXTURE_HOME));
    return JSON.parse(json) as CapturedFixture;
}

test('the standard fixture, as the renderer gets it', async ({page, home}) => {
    /* When */
    const answers = await capture(page, home);

    /* Then */
    if (UPDATE) {
        fs.writeFileSync(
            path.join(__dirname, '../../component/fixtures/standard.json'),
            JSON.stringify(answers, null, 4) + '\n',
        );
        return;
    }
    expect(answers).toEqual(captured('standard'));
});
