/**
 * Asking Patch to start a session from the empty screen (#135).
 *
 * This walks the wired app: the text crosses IPC, main sends it to the fake
 * `claude -p` the box warmed on focus, and the confident answer starts a
 * session. The box against what main answers (an unsure answer's choices,
 * cancelling, a failed call, ⌘Enter with and without a quick folder, Patch
 * answering a simple question) is in component/tests/ask-patch.spec.ts; the
 * routing rules and the box's state are unit tested (test/ask-route*.test.ts,
 * test/ask-slice.test.ts, test/ask-keys.test.ts).
 */
import {test, expect} from '../support/test';
import {fakeRoute, launchedKeys, waitForNewLaunch} from '../support/fake-cli';
import {P} from '../fixtures/standard';
import type {Page} from '@playwright/test';

const box = (page: Page) => page.getByTestId('ask-box');

test('a confident answer starts the session in that project on the rewritten prompt', async ({page, home}) => {
    /* Given */
    const route = fakeRoute(home);
    const acmeApi = home.projectPath(P.acmeApi);
    route.answer({
        projectPath: acmeApi,
        confident: true,
        candidates: [acmeApi],
        prompt: ' Fix the login redirect loop. \n',
    });
    const before = launchedKeys(home);

    /* When */
    await expect(box(page)).toBeFocused();
    await box(page).fill('lets fix the login loop in acme-api');
    await box(page).press('Enter');

    /* Then */
    const claude = await waitForNewLaunch(home, 'claude', before);
    const launch = await claude.launched();
    expect(launch.cwd).toBe(acmeApi);
    expect(launch.argv.at(-1)).toBe('Fix the login redirect loop.');
    await expect(box(page)).toHaveValue('');

    // The box warmed a process when it got focus, and the request went through it.
    const [call] = route.calls();
    expect(call.warm).toBe(true);
    expect(call.argv).toEqual(expect.arrayContaining(['-p', '--model', 'haiku', '--input-format', 'stream-json']));
    // The box's call may answer a simple question itself.
    expect(call.argv.join(' ')).toContain('decide whether to answer the request yourself');
    const prompt = call.prompt;
    expect(prompt).toContain(`path: ${acmeApi}`);
    expect(prompt).toContain(`path: ${home.projectPath(P.webDashboard)}`);
    expect(prompt).not.toContain('.claude/worktrees');
    expect(prompt).toContain('lets fix the login loop in acme-api');
});
