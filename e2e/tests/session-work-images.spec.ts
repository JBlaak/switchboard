/**
 * The image card in the Session work diff (#115), wired into the real app:
 * both sides fetched over `sessionWorkImage` and decoded, the metadata line,
 * the keys on the card `n` landed on, and an added image's single side.
 *
 * Which mode a key picks, how the view refits and what persists are decided
 * by the session-work slice, unit tested in test/session-work-image-card.test.ts;
 * this proves the wiring. The images are built in code (fixtures/png.ts) and
 * served by the stub in place of git (fixtures/session-work.ts).
 */
import { test, expect } from '../support/test';
import { openSession } from '../support/app';
import { LABEL, S } from '../fixtures/standard';
import { ICON_AFTER, LOGO_AFTER, LOGO_BEFORE, imageWorkStub } from '../fixtures/session-work';
import { formatBytes } from '../../src/renderer/ui/session-work/image-compare/image-meta';
import type { Locator, Page } from '@playwright/test';

test.use({ stubs: { sessionWork: imageWorkStub() } });

function workPage(page: Page) {
  return page.getByRole('region', { name: /^Session work for / });
}

function fileCard(page: Page, path: string) {
  return workPage(page).getByTestId('session-work-diff').getByRole('region', { name: path, exact: true });
}

/** The size an `<img>` decoded to: 0×0 until it has. */
function decodedSize(img: Locator) {
  return img.evaluate((el: HTMLImageElement) => `${el.naturalWidth}×${el.naturalHeight}`);
}

/** Where the card's first stage draws its content: the view, as the stage applies it. */
function stageTransform(card: Locator) {
  return card.locator('.sw-stage-content').first().evaluate(el => (el as HTMLElement).style.transform);
}

test('an image card loads both sides; n lands on it, 2 picks swipe and 0 fits it again; an added image shows one side', async ({ page, home }) => {
  /* Given */
  await openSession(page, home, LABEL.loginFix, S.loginFix);
  await page.keyboard.press('Meta+g');
  await expect(workPage(page)).toBeVisible();
  const logo = fileCard(page, 'assets/logo.png');
  const icon = fileCard(page, 'assets/icon.png');

  /* Then */
  await expect(logo.getByRole('figure', { name: 'Before' }).locator('img')).toBeVisible();
  await expect.poll(() => decodedSize(logo.getByRole('img', { name: 'Before' }))).toBe('1200×600');
  await expect.poll(() => decodedSize(logo.getByRole('img', { name: 'After' }))).toBe('1600×600');
  await expect(logo.getByTestId('image-meta'))
    .toHaveText(`1200×600 → 1600×600 · ${formatBytes(LOGO_BEFORE.length)} → ${formatBytes(LOGO_AFTER.length)} · PNG`);
  await expect(logo.getByRole('button', { name: 'Side-by-side' })).toHaveAttribute('aria-pressed', 'true');

  /* When */
  await page.keyboard.press('n');
  await page.keyboard.press('2');

  /* Then */
  await expect(logo).toHaveClass(/\bis-focused\b/);
  await expect(logo.getByRole('button', { name: 'Swipe' })).toHaveAttribute('aria-pressed', 'true');
  // Fitted to the card, which is narrower than either image.
  const fitted = await stageTransform(logo);
  expect(fitted).toMatch(/scale\(0\.\d+\)/);

  /* When */
  await logo.locator('.sw-stage').first().dblclick();

  /* Then */
  await expect.poll(() => stageTransform(logo)).toContain('scale(1)');

  /* When */
  await page.keyboard.press('0');

  /* Then */
  await expect.poll(() => stageTransform(logo)).toBe(fitted);

  /* When */
  await page.keyboard.press('n');

  /* Then */
  await expect(icon).toHaveClass(/\bis-focused\b/);
  await expect(icon.locator('img')).toHaveCount(1);
  await expect.poll(() => decodedSize(icon.getByRole('img', { name: 'After' }))).toBe('64×64');
  await expect(icon.getByRole('group', { name: /^Compare mode/ }).getByRole('button')).toHaveText(['Side-by-side']);
  await expect(icon.getByTestId('image-meta')).toHaveText(`64×64 · ${formatBytes(ICON_AFTER.length)} · PNG`);
});
