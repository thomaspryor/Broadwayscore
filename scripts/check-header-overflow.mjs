#!/usr/bin/env node
// Header overflow probe (BRO-4575). Loads each path at each viewport width and
// fails if the site header's <nav> scrolls horizontally or any visible header
// control (search, Sign in / My Shows, hamburger) sits outside the viewport.
//
// Usage:
//   node scripts/check-header-overflow.mjs --url=https://broadwayscorecard.com
//   node scripts/check-header-overflow.mjs --url=http://localhost:3000 --paths=/,/my-shows?mock=1
//   --require-account   fail if the Sign in / My Shows control is missing at >=640px
//                       (use when userAccounts is on, so a flag-off build can't pass trivially)
//   --simulate-signed-in  swap the Sign in pill for HeaderUserIcon's signed-in
//                       "My Shows" + avatar markup before measuring (the probe has no session)
// Exit 0 = no overflow anywhere, 1 = overflow found, 2 = probe error.

import { existsSync } from 'fs';
import { chromium } from 'playwright';
import { probe } from './lib/header-overflow-probe.mjs';

const WIDTHS = [360, 414, 640, 768, 900, 1024, 1280, 1440];

function parseArgs(argv) {
  const args = { url: null, paths: ['/'], widths: WIDTHS, requireAccount: false, simulateSignedIn: false };
  for (const a of argv) {
    if (a === '--require-account') { args.requireAccount = true; continue; }
    if (a === '--simulate-signed-in') { args.simulateSignedIn = true; args.requireAccount = true; continue; }
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (!m) continue;
    if (m[1] === 'url') args.url = m[2].replace(/\/$/, '');
    else if (m[1] === 'paths') args.paths = m[2].split(',').filter(Boolean).map(p => (p.startsWith('/') ? p : '/' + p));
    else if (m[1] === 'widths') args.widths = m[2].split(',').map(Number);
  }
  // A typo must not shrink coverage into a false green.
  if (!args.paths.length || !args.widths.length || args.widths.some(w => !Number.isInteger(w) || w <= 0)) {
    console.error(`ERROR: bad --paths/--widths (paths=${args.paths.join(',')} widths=${args.widths.join(',')})`);
    process.exit(2);
  }
  return args;
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
        const res = await page.evaluate(probe, { simulateSignedIn: args.simulateSignedIn });
        await page.close();
        if (res.error) {
          console.log(`FAIL ${path} @${width}: ${res.error}`);
          failures++;
          continue;
        }
        const overflow = res.scrollWidth > res.clientWidth;
        const accountMissing = args.requireAccount && width >= 640 && !res.accountVisible;
        if (accountMissing) res.offenders.push('Sign in / My Shows control missing');
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
