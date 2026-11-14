import { chromium } from 'playwright';

const url = 'http://localhost:3001/tony-awards/predictions/2025-2026';
const widths = [390, 1440];
const sections = [
  { id: 'best-revival-play', label: 'Best Revival of a Play (Death of a Salesman = 6 picks)' },
  { id: 'best-play', label: 'Best Play (mixed pick counts)' },
  { id: 'best-musical', label: 'Best Musical' },
];

const browser = await chromium.launch();
for (const w of widths) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'networkidle' });
  for (const s of sections) {
    const el = page.locator(`#${s.id}`);
    if (await el.count() === 0) { console.log(`miss ${s.id} @ ${w}`); continue; }
    await el.scrollIntoViewIfNeeded();
    const out = `/tmp/press-picks-${w}-${s.id}.png`;
    await el.screenshot({ path: out });
    console.log(out);
  }
  await ctx.close();
}
await browser.close();
