import { test, expect } from '@playwright/test';
import { assertTextInsideBoxes, assertNoHorizontalOverflow } from './helpers/layout-assertions';

/**
 * Redesigned show hero, phone score cards (BRO-4525). With a critic score and
 * an audience grade, two cards sit side by side and each had ~50px of text
 * column next to its badge, so the longest tier label ("Recommended") ran up
 * to 36px past the card border on a 360px phone. Schmigadoon is a Recommended
 * show with an audience grade, the worst case for both labels.
 *
 * Skips while the redesign is off on the target (it was demo-only before the
 * soft launch); runs against prod in test.yml once it ships there.
 */
const SHOW = '/show/schmigadoon';

for (const width of [320, 360, 390, 640]) {
  test.describe(`hero score cards at ${width}px`, () => {
    test.use({ viewport: { width, height: 844 } });

    test('labels and counts stay inside both cards', async ({ page }) => {
      await page.goto(SHOW, { waitUntil: 'domcontentloaded' });
      // Wait for either hero before deciding which layout this deployment runs.
      const hero = page.getByTestId('show-hero-redesign');
      const legacyHero = page.getByTestId('show-header-card');
      await expect(hero.or(legacyHero).first()).toBeVisible();
      test.skip(await legacyHero.isVisible(), 'show page redesign is not enabled on this deployment');

      const cards = hero.locator('a[href="#critic-reviews"], a[href="#audience"]').filter({ visible: true });
      await expect(cards.first()).toBeVisible();
      expect(await cards.count(), 'expected the critic and audience cards side by side').toBe(2);
      await expect(cards.first()).toContainText('critic review');
      await page.evaluate(() => document.fonts.ready);

      await assertTextInsideBoxes(cards);
      await assertNoHorizontalOverflow(page);
    });
  });
}
