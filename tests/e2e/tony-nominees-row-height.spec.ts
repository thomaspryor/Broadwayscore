import { test, expect } from '@playwright/test';

/**
 * Row height regression guard for /tony-awards/nominees on mobile.
 *
 * Why this exists: this page has 3 row types (MajorNomineeRow, PerformerRow,
 * CraftRow) and the spacing has regressed 5+ times. Each prior regression
 * traced back to global CSS rules (e.g. `a { min-height: 44px }`) that
 * inflated stacked block links inside the row, blowing the row out to 100px+.
 *
 * This test catches ANY future cause of row inflation by measuring actual
 * rendered heights in a real browser at 390px width. It doesn't care how the
 * regression happens — only that rows stay compact.
 *
 * Thresholds are set ~20% above the current measured heights so genuine
 * layout changes don't fail spuriously, but a 44px-style inflation (which
 * adds ~40-50px per row) is impossible to miss.
 */

const MAX_HEIGHTS = {
  major: 110,     // observed ~95px (large thumbnail + title row)
  performer: 90,  // observed 82px (19 picks → 4 chip rows; grows with consensus nominees)
  craft: 90,      // observed 64-76px (small thumbnail + title + credit + optional chip)
};

test.describe('Tony nominees row heights @mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test.beforeEach(async ({ page }) => {
    await page.goto('/tony-awards/nominees', { waitUntil: 'networkidle' });
  });

  // Season note: the page derives its season from getTonySeasonWindow(), which rolls
  // to the upcoming season the day after each ceremony (~late April). Early in a
  // season only the categories with announced nominees render — e.g. in the 2026-2027
  // window (verified 2026-06) only "Best Revival of a Play" had a nominee, so Best
  // Musical / performer / craft sections were absent. Each test below SKIPS when its
  // specific category section isn't present (nothing to measure) and re-arms once
  // that category's nominees are announced. A missing section is therefore not a
  // failure here — this guard only polices ROW HEIGHT when rows actually render.

  test('Best Musical (MajorNomineeRow) rows stay compact', async ({ page }) => {
    // MajorNomineeRow renders as an <a href="/show/..."> inside the Best Musical
    // section. Page restructure 2026-05-23 wrapped the section in
    // overflow-x-auto + min-width containers, so the xpath following-sibling::div[1]
    // approach no longer finds the table. Use querySelector on the section
    // ancestor instead — same pattern as the performer/craft tests below.
    const heights = await page.evaluate(() => {
      const sections = Array.from(document.querySelectorAll('section'));
      const bestMusical = sections.find((s) =>
        s.querySelector('h2')?.textContent?.trim() === 'Best Musical'
      );
      if (!bestMusical) return null;
      const rows = Array.from(bestMusical.querySelectorAll('a[href^="/show/"]'));
      return rows.map((r) => Math.round((r as HTMLElement).getBoundingClientRect().height));
    });

    test.skip(heights === null, 'Best Musical section not present this season — nothing to measure');
    expect(heights!.length, 'expected ≥1 Best Musical nominee row').toBeGreaterThan(0);
    for (const h of heights!) {
      expect(h, `MajorNomineeRow height ${h}px exceeds ${MAX_HEIGHTS.major}px limit`).toBeLessThanOrEqual(MAX_HEIGHTS.major);
    }
  });

  test('Performer category rows (PerformerRow) stay compact', async ({ page }) => {
    // PerformerRow renders inside categories like "Best Actor in a Musical".
    // Use an evaluate to count all rows in any performer section and measure heights.
    const heights = await page.evaluate(() => {
      const sections = Array.from(document.querySelectorAll('section'));
      const performerSection = sections.find((s) =>
        s.querySelector('h2')?.textContent?.trim() === 'Best Actor in a Musical'
      );
      if (!performerSection) return null;
      // PerformerRow is a <div> with flex items-center, no wrapping Link.
      // It's the first div child inside the row container divs after the header row.
      const rows = Array.from(performerSection.querySelectorAll('div > div.flex.items-center.gap-2\\.5'));
      return rows.map((r) => Math.round((r as HTMLElement).getBoundingClientRect().height));
    });

    test.skip(heights === null, 'Best Actor in a Musical section not present this season — nothing to measure');
    expect(heights!.length, 'expected ≥1 performer row').toBeGreaterThan(0);
    for (const h of heights!) {
      expect(h, `PerformerRow height ${h}px exceeds ${MAX_HEIGHTS.performer}px limit`).toBeLessThanOrEqual(MAX_HEIGHTS.performer);
    }
  });

  test('Craft category rows (CraftRow) stay compact', async ({ page }) => {
    // CraftRow renders inside categories like "Best Original Score" / "Best Book of a Musical".
    const heights = await page.evaluate(() => {
      const sections = Array.from(document.querySelectorAll('section'));
      const craftSection = sections.find((s) =>
        s.querySelector('h2')?.textContent?.trim() === 'Best Original Score'
      );
      if (!craftSection) return null;
      // CraftRow is a <div> with `flex items-center gap-3 p-2.5 sm:p-3 rounded-lg`.
      const rows = Array.from(craftSection.querySelectorAll('div > div.flex.items-center.gap-3.p-2\\.5'));
      return rows.map((r) => Math.round((r as HTMLElement).getBoundingClientRect().height));
    });

    test.skip(heights === null, 'Best Original Score section not present this season — nothing to measure');
    expect(heights!.length, 'expected ≥1 craft row').toBeGreaterThan(0);
    for (const h of heights!) {
      expect(h, `CraftRow height ${h}px exceeds ${MAX_HEIGHTS.craft}px limit`).toBeLessThanOrEqual(MAX_HEIGHTS.craft);
    }
  });
});
