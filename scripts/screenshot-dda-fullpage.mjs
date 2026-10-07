import { chromium } from 'playwright';
const OUT = '/Users/tompryor/Documents/claude-outputs/where-it-ranks-screenshots';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto('http://localhost:3199/show/dog-day-afternoon', { waitUntil: 'networkidle' });
await page.screenshot({ path: `${OUT}/dda-full-page-desktop.png`, fullPage: true });
const card = page.locator('[data-testid="where-it-ranks"]');
const count = await card.count();
console.log('card count:', count);
if (count > 0) {
  const box = await card.boundingBox();
  console.log('card y:', box?.y, 'height:', box?.height);
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: `${OUT}/dda-card-zoom.png` });
}
await browser.close();
