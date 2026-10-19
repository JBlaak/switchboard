/**
 * The image card in the Session work diff (#115), wired into the real app:
 * both sides fetched over `sessionWorkImage` and decoded, the metadata line,
 * the keys on the card `n` landed on, an added image's single side, and a
 * right-click copying an image.
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
import { clipboardImages } from '../support/main-process';
import { formatBytes } from '../../src/renderer/ui/session-work/image-compare/image-meta';
import { fitView } from '../../src/renderer/ui/session-work/image-compare/viewport';
import type { Size } from '../../src/renderer/ui/session-work/image-compare/types';
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

/** The logo card's content box: the larger of its two images on each axis. */
const LOGO_CONTENT = { width: 1600, height: 600 };

/** The transform the card's first stage would have if fitted to its current size. */
async function fittedTransform(card: Locator, content: Size) {
  const frame = await card.locator('.sw-stage').first().evaluate(el => ({ width: el.clientWidth, height: el.clientHeight }));
  const { x, y, scale } = fitView(frame, content);
  return `translate(${x}px, ${y}px) scale(${scale})`;
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
  // Fitted to the card, which is narrower than either image. Swipe's stage is
  // wider than side-by-side's, so wait for the refit before reading it.
  await expect.poll(() => stageTransform(logo)).toMatch(/scale\(0\.\d+\)/);

  /* When */
  // Off-centre: swipe's divider handle sits in the middle.
  await logo.locator('.sw-stage').first().dblclick({ position: { x: 20, y: 20 } });

  /* Then */
  await expect.poll(() => stageTransform(logo)).toContain('scale(1)');

  /* When */
  await page.keyboard.press('0');

  /* Then */
  // Fitted to the stage as it is now: swipe's taller card can bring in a
  // scrollbar after the first fit, which narrows the stage.
  await expect.poll(() => stageTransform(logo)).toBe(await fittedTransform(logo, LOGO_CONTENT));

  /* When */
  await page.keyboard.press('n');

  /* Then */
  await expect(icon).toHaveClass(/\bis-focused\b/);
  await expect(icon.locator('img')).toHaveCount(1);
  await expect.poll(() => decodedSize(icon.getByRole('img', { name: 'After' }))).toBe('64×64');
  await expect(icon.getByRole('group', { name: /^Compare mode/ }).getByRole('button')).toHaveText(['Side-by-side']);
  await expect(icon.getByTestId('image-meta')).toHaveText(`64×64 · ${formatBytes(ICON_AFTER.length)} · PNG`);
});

/** A PNG's size, read off its IHDR chunk. */
function pngSize(base64: string): string {
  const bytes = Buffer.from(base64, 'base64');
  return `${bytes.readUInt32BE(16)}×${bytes.readUInt32BE(20)}`;
}

test('a right-click on an image copies that side as a PNG, and a toast says so for a moment; in blink, the side showing', async ({ page, app, home }) => {
  /* Given */
  await openSession(page, home, LABEL.loginFix, S.loginFix);
  await page.keyboard.press('Meta+g');
  const logo = fileCard(page, 'assets/logo.png');
  await expect.poll(() => decodedSize(logo.getByRole('img', { name: 'After' }))).toBe('1600×600');

  /* When */
  await logo.getByRole('figure', { name: 'Before' }).locator('.sw-stage').click({ button: 'right' });
  await logo.getByRole('figure', { name: 'After' }).locator('.sw-stage').click({ button: 'right' });

  /* Then */
  await expect.poll(async () => (await clipboardImages(app)).map(pngSize)).toEqual(['1200×600', '1600×600']);
  await expect(logo.getByRole('status')).toHaveText('Copied to clipboard');
  await expect(logo.getByRole('status')).toBeHidden();

  /* When */
  await logo.getByRole('button', { name: 'Blink' }).click();
  await logo.locator('.sw-stage').click({ button: 'right' });

  /* Then */
  await expect(logo.locator('.sw-blink-label')).toHaveText('Before');
  await expect.poll(async () => (await clipboardImages(app)).map(pngSize)).toEqual(['1200×600', '1600×600', '1200×600']);
});
