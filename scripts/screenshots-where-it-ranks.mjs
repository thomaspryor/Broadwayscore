import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT_DIR = '/Users/tompryor/Documents/claude-outputs/where-it-ranks-screenshots';
mkdirSync(OUT_DIR, { recursive: true });

const SHOWS = [
  { slug: 'cats-the-jellicle-ball', label: 'cats-jellicle-ball' },
  { slug: 'death-of-a-salesman', label: 'death-of-a-salesman' },
  { slug: 'ragtime', label: 'ragtime' },
];
const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 1500 },
  { name: 'desktop', width: 1440, height: 1500 },
];

const browser = await chromium.launch();
for (const show of SHOWS) {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await ctx.newPage();
    const url = `http://localhost:3199/show/${show.slug}`;
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    } catch (e) {
      console.log(`fail: ${show.slug} ${vp.name} — ${e.message}`);
      await ctx.close();
      continue;
    }
    // Top-of-page screenshot (hero rank line)
    const heroFile = `${OUT_DIR}/${show.label}-${vp.name}-hero.png`;
    await page.screenshot({ path: heroFile, fullPage: false });
    console.log(`✓ ${heroFile}`);

    // Scroll to where-it-ranks card and screenshot it
    const card = page.locator('[data-testid="where-it-ranks"]');
    if (await card.count() > 0) {
      await card.scrollIntoViewIfNeeded();
      const cardFile = `${OUT_DIR}/${show.label}-${vp.name}-card.png`;
      await card.screenshot({ path: cardFile });
      console.log(`✓ ${cardFile}`);
    } else {
      console.log(`  (no card on ${show.slug} ${vp.name})`);
    }
    await ctx.close();
  }
}
await browser.close();
console.log('done');
