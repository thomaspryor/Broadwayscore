#!/usr/bin/env node
/**
 * Render the Profitability Scorecard link-preview PNGs (BRO-6149):
 * public/og/biz.html (template) -> public/og/biz/<slug>.png at 1200x630.
 * Cards come from scripts/lib/biz-og-cards.js; one per season is derived from
 * the commercial data, so rerun this after a new season appears (the page
 * falls back to the generic season card until then, never a 404).
 *
 * Usage: node scripts/generate-biz-og-images.js [--only=slug]
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { exitOnHelp } = require('./lib/cli-help');
const { TOPIC_CARDS, HOME_CARD, SEASON_FALLBACK_CARD, seasonCard, seasonsWithData } = require('./lib/biz-og-cards');

exitOnHelp(module);

const ROOT = path.join(__dirname, '..');
const TEMPLATE = path.join(ROOT, 'public', 'og', 'biz.html');
const OUT = path.join(ROOT, 'public', 'og', 'biz');

async function main() {
  const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
  const commercial = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'commercial.json'), 'utf8'));
  const shows = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
  const seasons = seasonsWithData(shows, commercial);
  const cards = [HOME_CARD, SEASON_FALLBACK_CARD, ...TOPIC_CARDS, ...seasons.map(seasonCard)].filter((c) => !only || c.slug === only);
  fs.mkdirSync(OUT, { recursive: true });
  let playwright;
  try { playwright = require('playwright'); } catch { playwright = require(path.join(require('child_process').execSync('npm root -g', { encoding: 'utf8' }).trim(), 'playwright')); }
  const { chromium } = playwright;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  for (const c of cards) {
    const url = new URL(pathToFileURL(TEMPLATE).href);
    url.searchParams.set('kicker', c.kicker || 'Profitability Scorecard');
    url.searchParams.set('title', c.title);
    url.searchParams.set('sub', c.sub || '');
    await page.goto(url.href);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(OUT, `${c.slug}.png`), clip: { x: 0, y: 0, width: 1200, height: 630 } });
    console.log(`wrote public/og/biz/${c.slug}.png`);
  }
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
