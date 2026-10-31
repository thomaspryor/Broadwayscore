#!/usr/bin/env node
// Capture the AudienceBuzz card only, on a curated set of shows, at desktop +
// mobile. Crops to the card itself by selecting #audience.
//
// Usage: node scripts/capture-audience-card.mjs [--phase=before|after]
// Output: ~/Documents/claude-outputs/audience-card-iter/{phase}/

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const argv = process.argv.slice(2);
const PHASE = (argv.find((a) => a.startsWith('--phase='))?.split('=')[1]) || 'before';
const OUT = join(homedir(), 'Documents/claude-outputs/audience-card-iter', PHASE);
const BASE = process.env.CATALOG_BASE_URL || 'http://localhost:3000';

const SHOWS = [
  { slug: 'hamilton', label: 'A+ · long-running' },
  { slug: 'oh-mary', label: 'A+ · comedy hit' },
  { slug: 'death-becomes-her', label: 'mid-tier audience' },
  { slug: 'the-great-gatsby', label: 'low tier' },
  { slug: 'wicked', label: 'A+ · 20-year run, many sources' },
  { slug: 'cats-1982', label: 'historical · limited sources' },
];

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();

  for (const s of SHOWS) {
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 2,
      });
      const page = await ctx.newPage();
      try {
        await page.goto(`${BASE}/show/${s.slug}`, { waitUntil: 'networkidle', timeout: 60_000 });
        await page.waitForTimeout(500);
        // Use page.evaluate to find the smallest element wrapping the
        // Audience heading (the AudienceBuzzCard root div). The pattern in
        // AudienceBuzzCard.tsx: <div class="card ..."><h2>Audience Grade</h2>...
        const cardBox = await page.evaluate(() => {
          const heading = Array.from(document.querySelectorAll('h2')).find((h) =>
            /audience\s*(grade|scorecard)/i.test(h.textContent || '')
          );
          if (!heading) return null;
          // Walk up to the nearest `.card` ancestor — that's the card wrapper.
          let el = heading.closest('.card') || heading.parentElement;
          if (!el) return null;
          el.scrollIntoView({ block: 'center' });
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y + window.scrollY, width: r.width, height: r.height };
        });
        if (!cardBox) {
          console.log(`✗ ${s.slug} [${vp.name}] no audience card found`);
        } else {
          await page.waitForTimeout(150);
          const file = join(OUT, `${s.slug}__${vp.name}.png`);
          await page.screenshot({
            path: file,
            clip: { x: cardBox.x, y: cardBox.y, width: cardBox.width, height: cardBox.height },
            fullPage: true,
          });
          console.log(`✓ ${s.slug} [${vp.name}] — ${s.label}`);
        }
      } catch (err) {
        console.error(`✗ ${s.slug} [${vp.name}] ${err.message}`);
      } finally {
        await ctx.close();
      }
    }
  }
  await browser.close();
  console.log(`Done → ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
