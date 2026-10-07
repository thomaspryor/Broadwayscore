import { chromium } from 'playwright';
const OUT = '/Users/tompryor/Documents/claude-outputs/where-it-ranks-screenshots';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto('https://demo.broadwayscorecard.com/show/dog-day-afternoon', { waitUntil: 'networkidle' });

// Find every section heading/card on the page
const headings = await page.locator('h2, [class*="card"] >> nth=0').allInnerTexts().catch(() => []);
console.log('Top-level texts:', headings.slice(0, 30));

// Look for Commercial Scorecard / BizBuzz
const biz = page.locator('text=/Recoupment|Capitalization|Commercial Scorecard|Commercial Performance/').first();
if (await biz.count() > 0) {
  await biz.scrollIntoViewIfNeeded();
  const box = await biz.boundingBox();
  console.log('Commercial found at y:', box?.y);
  // Screenshot the section
  await page.screenshot({
    path: `${OUT}/demo-dda-commercial-region.png`,
    clip: { x: 0, y: Math.max(0, (box?.y ?? 0) - 100), width: 1440, height: 800 },
  });
  console.log('✓ saved');
} else {
  console.log('Commercial NOT FOUND on page');
}
await browser.close();
