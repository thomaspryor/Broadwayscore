import { chromium } from 'playwright';
const OUT = '/Users/tompryor/Documents/claude-outputs/where-it-ranks-screenshots';
const browser = await chromium.launch();

// Desktop hero
const ctxD = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const pageD = await ctxD.newPage();
await pageD.goto('https://demo.broadwayscorecard.com/show/dog-day-afternoon', { waitUntil: 'networkidle' });
const scoreSection = pageD.locator('[data-testid="show-score-section"]').first();
if (await scoreSection.count() > 0) {
  await scoreSection.scrollIntoViewIfNeeded();
  await scoreSection.screenshot({ path: `${OUT}/demo-dda-hero-desktop.png` });
  console.log('✓ demo-dda-hero-desktop.png');
}
const card = pageD.locator('[data-testid="where-it-ranks"]').first();
if (await card.count() > 0) {
  const box = await card.boundingBox();
  console.log('card y on demo:', box?.y);
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: `${OUT}/demo-dda-card-desktop.png` });
  console.log('✓ demo-dda-card-desktop.png');
}
await browser.close();
