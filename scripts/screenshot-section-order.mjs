import { chromium } from 'playwright';
const OUT = '/Users/tompryor/Documents/claude-outputs/where-it-ranks-screenshots';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 4000 } });
const page = await ctx.newPage();
await page.goto('http://localhost:3199/show/dog-day-afternoon', { waitUntil: 'networkidle' });
await page.screenshot({ path: `${OUT}/dda-section-order.png`, clip: { x: 0, y: 2000, width: 1440, height: 2000 } });
console.log('captured section order');
await browser.close();
