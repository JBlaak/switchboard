/**
 * The sidebar's archive toast, against what main answers.
 *
 * The walk through the list the real index drew (tiers, folding, search,
 * archive, filters) stays in e2e/tests/sidebar.spec.ts as the one index smoke
 * test, with the screenshots; the list's own behaviour is in
 * session-list.spec.ts.
 */
import {test, expect} from '../support/session-list';
import {rowButton, sessionRow} from '../../e2e/support/app';
import {storedSession} from '../../e2e/support/session-list';
import {LABEL, S} from '../../e2e/fixtures/standard';

test('Undo on the toast brings an archived row back', async ({page, api}) => {
    /* Given */
    const charts = sessionRow(page, LABEL.chartsDarkMode);
    await charts.hover();
    await rowButton(charts, 'Archive').click();
    await expect(charts).toHaveCount(0);
    const toast = page.getByTestId('archive-undo');
    await expect(toast).toContainText(`Archived “${LABEL.chartsDarkMode}”`);

    /* When */
    await toast.getByRole('button', {name: /Undo/}).click();

    /* Then */
    await expect(toast).toHaveCount(0);
    await expect(charts).toBeVisible();
    await expect(charts).not.toHaveAttribute('data-leaving');
    expect(api.callsTo('archiveSession')).toEqual([
        [S.chartsDarkMode, true],
        [S.chartsDarkMode, false],
    ]);
    expect(await storedSession(page, S.chartsDarkMode)).toMatchObject({archived: 0});
});
