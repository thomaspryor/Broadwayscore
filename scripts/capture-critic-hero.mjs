#!/usr/bin/env node
// Quick capture of the critic hero (top of show page) to verify the
// HeroRankLine format change works there too.

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const OUT = join(homedir(), 'Documents/claude-outputs/audience-card-iter/critic-hero-check');
const BASE = 'http://localhost:3000';
const SLUGS = ['hamilton', 'oh-mary', 'the-great-gatsby', 'the-lost-boys', 'joe-turners-come-and-gone'];
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();
  for (const slug of SLUGS) {
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 2 });
      const page = await ctx.newPage();
      try {
        await page.goto(`${BASE}/show/${slug}`, { waitUntil: 'networkidle', timeout: 60_000 });
        await page.waitForTimeout(500);
        // Capture the first ~700px of the page (just the hero section)
        await page.screenshot({
          path: join(OUT, `${slug}__${vp.name}.png`),
          clip: { x: 0, y: 0, width: vp.width, height: vp.name === 'desktop' ? 700 : 1000 },
        });
        console.log(`✓ ${slug} [${vp.name}]`);
      } catch (err) {
        console.error(`✗ ${slug} [${vp.name}] ${err.message}`);
      } finally {
        await ctx.close();
      }
    }
  }
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
