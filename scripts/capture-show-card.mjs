#!/usr/bin/env node
// Generic: capture a named card on the show page across curated shows
// at desktop + mobile, for before/after iteration.
//
// Usage: node scripts/capture-show-card.mjs --card=<key> --phase=<before|after>
// Cards keyed in CARD_TARGETS below. Output:
//   ~/Documents/claude-outputs/show-cards-batch-iter/<card>/<phase>/<slug>__<vp>.png

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const argv = process.argv.slice(2);
const argVal = (n) => argv.find((a) => a.startsWith(`${n}=`))?.split('=')[1];
const CARD = argVal('--card');
const PHASE = argVal('--phase') || 'before';
if (!CARD) { console.error('--card= required'); process.exit(2); }

// Each card target: an in-page heading regex used to locate the .card wrapper.
const CARD_TARGETS = {
  critic:  { headings: ['Critic Reviews','Critic Scorecard'], shows: ['hamilton','oh-mary','the-lost-boys','death-becomes-her','cats-1982'] },
  awards:  { headings: ['Awards','Award Score','Awards Scorecard'], shows: ['hamilton','maybe-happy-ending','oh-mary','the-lost-boys','wicked'] },
  theater: { headings: ['Theater','Theater Scorecard','Venue'], shows: ['hamilton','the-lion-king','oh-mary','the-lost-boys'] },
  boxoffice: { headings: ['Box Office'], shows: ['hamilton','wicked','the-lion-king','death-becomes-her','the-lost-boys'] },
  social:  { headings: ['Socials Scorecard','Social Pulse','Social'], shows: ['the-lost-boys','beaches','oh-mary','becky-shaw','aladdin'] },
  commercial: { headings: ['Commercial','Biz Buzz','Commercial Performance','Commercial Scorecard'], shows: ['hamilton','wicked','the-lion-king','maybe-happy-ending','death-becomes-her'] },
  showtimes:   { headings: ['Showtimes'], shows: ['hamilton','oh-mary','the-lost-boys','death-becomes-her','wicked'] },
  castupdates: { headings: ['Cast Updates'], shows: ['hamilton','wicked','the-lion-king','oh-mary'] },
  castsection: { headings: ['Original Broadway Cast','Original Cast','Original London Cast','Current Cast'], shows: ['hamilton','wicked','the-lion-king','oh-mary','the-lost-boys'] },
  seating:     { headings: ['Seating Scorecard','Where to Sit'], shows: ['hamilton','wicked','the-lion-king','oh-mary'] },
  video:       { headings: ['Video Reviews'], shows: ['the-lost-boys','oh-mary','maybe-happy-ending','hamilton'] },
  lottery:     { headings: ['Discount Tickets'], shows: ['hamilton','oh-mary','the-lost-boys','wicked'] },
  quickfacts:  { headings: ['Quick Facts'], shows: ['hamilton','oh-mary','the-lost-boys','wicked','death-becomes-her'] },
  whereitranks: { headings: ['Where It Ranks','Where it ranks'], shows: ['hamilton','oh-mary','the-lost-boys','wicked','death-becomes-her'] },
};

const target = CARD_TARGETS[CARD];
if (!target) { console.error(`Unknown card: ${CARD}. Known: ${Object.keys(CARD_TARGETS).join(', ')}`); process.exit(2); }

const OUT = join(homedir(), 'Documents/claude-outputs/show-cards-batch-iter', CARD, PHASE);
const BASE = 'http://localhost:3000';
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();
  for (const slug of target.shows) {
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 2,
      });
      const page = await ctx.newPage();
      try {
        await page.goto(`${BASE}/show/${slug}`, { waitUntil: 'networkidle', timeout: 60_000 });
        await page.waitForTimeout(500);
        // Auto-open any details panels so collapsible content is captured
        await page.evaluate(() => {
          document.querySelectorAll('details:not([open])').forEach((d) => d.setAttribute('open',''));
        });
        await page.waitForTimeout(150);

        const headings = target.headings;
        const cardBox = await page.evaluate((headings) => {
          const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
          const wantedSet = headings.map(norm);
          // Try all heading levels h1-h4 + section labels
          const candidates = Array.from(document.querySelectorAll('h1,h2,h3,h4,[role="heading"]'));
          const matched = candidates.find((el) =>
            wantedSet.some((w) => norm(el.textContent || '').startsWith(w))
          );
          if (!matched) return null;
          let el = matched.closest('.card') || matched.closest('section') || matched.parentElement;
          if (!el) return null;
          el.scrollIntoView({ block: 'center' });
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y + window.scrollY, width: r.width, height: r.height };
        }, headings);
        if (!cardBox) {
          console.log(`✗ ${slug} [${vp.name}] no matching card`);
        } else {
          await page.waitForTimeout(150);
          await page.screenshot({
            path: join(OUT, `${slug}__${vp.name}.png`),
            clip: { x: cardBox.x, y: cardBox.y, width: cardBox.width, height: cardBox.height },
            fullPage: true,
          });
          console.log(`✓ ${slug} [${vp.name}]`);
        }
      } catch (err) {
        console.error(`✗ ${slug} [${vp.name}] ${err.message}`);
      } finally {
        await ctx.close();
      }
    }
  }
  await browser.close();
  console.log(`Done → ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
