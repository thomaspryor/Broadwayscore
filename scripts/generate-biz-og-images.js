#!/usr/bin/env node
/**
 * Render the Money Scorecard link-preview PNGs (BRO-6149):
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
const { getSeasonForDate } = require('./lib/broadway-seasons');
const { TOPIC_CARDS, HOME_CARD, SEASON_FALLBACK_CARD, seasonCard } = require('./lib/biz-og-cards');

exitOnHelp(module);

const ROOT = path.join(__dirname, '..');
const TEMPLATE = path.join(ROOT, 'public', 'og', 'biz.html');
const OUT = path.join(ROOT, 'public', 'og', 'biz');

// Seasons of every show with a commercial entry. Covers every season the pages
// list via getSeasonsWithCommercialData() (that one also filters untracked records), so a
// season page always has its card; the odd extra file is harmless.
function seasonsWithData() {
  const commercial = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'commercial.json'), 'utf8'));
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
  const shows = Array.isArray(raw) ? raw : raw.shows;
  const out = new Set();
  for (const s of shows) {
    if (!s.openingDate || !commercial.shows[s.slug]) continue;
    out.add(getSeasonForDate(s.openingDate));
  }
  return [...out].sort();
}

async function main() {
  const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
  const seasons = seasonsWithData();
  const cards = [HOME_CARD, SEASON_FALLBACK_CARD, ...TOPIC_CARDS, ...seasons.map(seasonCard)].filter((c) => !only || c.slug === only);
  fs.mkdirSync(OUT, { recursive: true });
  let playwright;
  try { playwright = require('playwright'); } catch { playwright = require(path.join(require('child_process').execSync('npm root -g', { encoding: 'utf8' }).trim(), 'playwright')); }
  const { chromium } = playwright;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  for (const c of cards) {
    const url = new URL(pathToFileURL(TEMPLATE).href);
    url.searchParams.set('kicker', c.kicker || 'Money Scorecard');
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
