#!/usr/bin/env node
// Header overflow probe (BRO-4575). Loads each path at each viewport width and
// fails if the site header's <nav> scrolls horizontally or any visible header
// control (search, Sign in / My Shows, hamburger) sits outside the viewport.
//
// Usage:
//   node scripts/check-header-overflow.mjs --url=https://broadwayscorecard.com
//   node scripts/check-header-overflow.mjs --url=http://localhost:3000 --paths=/,/my-shows?mock=1
// Exit 0 = no overflow anywhere, 1 = overflow found, 2 = probe error.

import { existsSync } from 'fs';
import { chromium } from 'playwright';

const WIDTHS = [360, 414, 640, 768, 900, 1024, 1280, 1440];

function parseArgs(argv) {
  const args = { url: null, paths: ['/'], widths: WIDTHS };
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (!m) continue;
    if (m[1] === 'url') args.url = m[2].replace(/\/$/, '');
    else if (m[1] === 'paths') args.paths = m[2].split(',').filter(Boolean);
    else if (m[1] === 'widths') args.widths = m[2].split(',').map(Number).filter(Boolean);
  }
  return args;
}

// Runs in the page. Returns { scrollWidth, clientWidth, offenders[] }.
function probe() {
  const nav = document.querySelector('header.fixed.top-0 nav');
  if (!nav) return { error: 'header nav not found' };
  const vw = document.documentElement.clientWidth;
  const offenders = [];
  for (const el of nav.querySelectorAll('a, button, input')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue; // display:none / hidden
    if (r.left < -1 || r.right > vw + 1) {
      const label = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || el.tagName)
        .trim().replace(/\s+/g, ' ').slice(0, 40);
      offenders.push(`${el.tagName.toLowerCase()} "${label}" right=${Math.round(r.right)} vw=${vw}`);
    }
  }
  return { scrollWidth: nav.scrollWidth, clientWidth: nav.clientWidth, offenders };
}

// Same fallback as scripts/visual-qa.mjs: cloud sandboxes only ship the
// preinstalled Chromium, not the headless-shell build Playwright asks for.
const PREINSTALLED_CHROMIUM = process.env.PW_CHROMIUM_EXECUTABLE || '/opt/pw-browsers/chromium';
async function launchChromium() {
  try {
    return await chromium.launch();
  } catch (e) {
    if (!/Executable doesn't exist/.test(String(e?.message)) || !existsSync(PREINSTALLED_CHROMIUM)) throw e;
    return chromium.launch({ executablePath: PREINSTALLED_CHROMIUM });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url) {
    console.error('ERROR: --url is required');
    process.exit(2);
  }
  const browser = await launchChromium();
  let failures = 0;
  try {
    for (const path of args.paths) {
      for (const width of args.widths) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        await page.goto(args.url + path, { waitUntil: 'networkidle', timeout: 60000 });
        const res = await page.evaluate(probe);
        await page.close();
        if (res.error) {
          console.log(`FAIL ${path} @${width}: ${res.error}`);
          failures++;
          continue;
        }
        const overflow = res.scrollWidth > res.clientWidth;
        const ok = !overflow && res.offenders.length === 0;
        if (!ok) failures++;
        console.log(`${ok ? 'ok  ' : 'FAIL'} ${path} @${width}: nav scrollWidth=${res.scrollWidth} clientWidth=${res.clientWidth}` +
          (res.offenders.length ? ` offscreen: ${res.offenders.join('; ')}` : ''));
      }
    }
  } finally {
    await browser.close();
  }
  console.log(failures ? `\n${failures} viewport(s) overflow` : '\nNo header overflow at any viewport');
  process.exit(failures ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(2);
});
