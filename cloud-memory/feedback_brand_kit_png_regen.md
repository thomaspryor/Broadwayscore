---
name: Brand-kit static PNGs need separate regen on label changes
description: When renaming tier labels site-wide, public/brand-kit/score-badges/*.png are pre-baked binary assets that won't update from a tsc/build. Regenerate them via Playwright against the deployed /brand#builder, then rebuild broadway-scorecard-brand-kit.zip.
type: feedback
originSessionId: 69a7ffbf-3747-4a1d-91f6-c1bf0e363aec
archived: true
---
When a tier label rename touches `src/config/score-buckets.ts` and propagates through every component, the static PNG badges in `public/brand-kit/score-badges/` (e.g. `stay-away-45-dark.png`, `critical-gold-87-transparent.png`) do NOT update automatically. They were generated once and committed as binaries — there's no script in the repo that regenerates them.

**Why:** The /brand page has an interactive `BadgeBuilder` component (`src/app/brand/BrandPageClient.tsx`) that renders fresh badges client-side via `drawBadgeCanvas`, but the pre-baked PNGs in the kit directory are independent files. The brand page tiles reference the static PNGs by filename, so the UI tile says "Critical Miss" but the image still shows "STAY AWAY" until you regenerate.

**How to apply:** After ANY tier label rename, run a Playwright script against the deployed `/brand#builder`:

```js
import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [variant, transparent] of [['dark', false], ['transparent', true]]) {
  await page.goto('https://broadwayscorecard.com/brand#builder', { waitUntil: 'networkidle' });
  await page.fill('input[type="number"]', '45'); // pick a score in the renamed tier
  await page.click(`button:has-text("${transparent ? 'Transparent' : 'Dark'}")`);
  const dl = page.waitForEvent('download');
  await page.click('button:has-text("Download PNG")');
  await (await dl).saveAs(`public/brand-kit/score-badges/<old-slug>-45-${variant}.png`);
}
```

Run from the main repo root (worktrees lack `node_modules/playwright`). After saving, rebuild the zip:
```bash
cd public/brand-kit && rm broadway-scorecard-brand-kit.zip && \
  zip -qr broadway-scorecard-brand-kit.zip score-badges grade-badges logos references social README.md palette.svg
```

Keep the old slug in the filename if you preserved the `id` (which you should — id literals appear in URL slugs and TS types, only the display label should change). For Stay Away → Critical Miss (2026-04-23): the badge files are still named `stay-away-45-*.png` but visually render "CRITICAL MISS".

**Verify**: `shasum public/brand-kit/score-badges/stay-away-45-dark.png` should match the deployed asset's `curl | shasum`.
