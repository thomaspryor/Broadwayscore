import { chromium } from 'playwright';
import { resolve } from 'path';
import { existsSync, mkdirSync } from 'fs';

const HTML = 'file://' + resolve('/tmp/tony-tables.html');
const OUT = '/Users/tompryor/Documents/claude-outputs/tony-week-tables';
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const tables = [
  ['t1', 'post1-best-musical-winners.png'],
  ['t2', 'post2-category-hit-rate.png'],
  ['t3', 'post2-best-revival-play-races.png'],
  ['t4', 'post3-bwsc-vs-gd-per-category.png'],
  ['t5', 'post3-five-biggest-gd-misses.png'],
  ['t6', 'post4-critics-audiences-voters.png'],
  ['t7', 'post5-top-best-play-losers.png'],
  ['t8', 'post6-critics-alignment.png'],
];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 2000 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.goto(HTML, { waitUntil: 'networkidle' });

for (const [id, file] of tables) {
  const el = page.locator('#' + id);
  await el.scrollIntoViewIfNeeded();
  const out = `${OUT}/${file}`;
  await el.screenshot({ path: out });
  console.log(out);
}
await browser.close();
