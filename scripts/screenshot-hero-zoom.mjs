import { chromium } from 'playwright';

const OUT = '/Users/tompryor/Documents/claude-outputs/where-it-ranks-screenshots';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto('http://localhost:3199/show/death-of-a-salesman', { waitUntil: 'networkidle' });
// Target the score section
const scoreSection = page.locator('[data-testid="show-score-section"]');
if (await scoreSection.count() > 0) {
  await scoreSection.scrollIntoViewIfNeeded();
  await scoreSection.screenshot({ path: `${OUT}/dos-score-section-desktop.png` });
  console.log('captured score section');
} else {
  console.log('no test id found, taking top-half screenshot');
  await page.screenshot({ path: `${OUT}/dos-top-desktop.png`, clip: { x: 0, y: 0, width: 1440, height: 700 } });
}
await browser.close();
