#!/usr/bin/env node
/**
 * Renders the Broadway Fantasy League marquee (BRO-5519) into the static files
 * that cannot use the React component: the link-preview card, the email header
 * and the tab icons. Source of truth is src/components/fantasy/marquee-art.ts;
 * re-run this after changing it and commit the outputs.
 *
 *   npx tsx scripts/generate-fantasy-brand-assets.mjs
 *
 * Writes public/images/fantasy/marquee-{wide,stacked,icon}.svg,
 * marquee-wide.png (email header, 2x), marquee-icon-{32,180}.png and
 * public/og/fantasy.png (1200x630). Needs Playwright's Chromium; the OG card
 * loads Big Shoulders Display and Inter from Google Fonts at render time.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { MARQUEE_COLORS as C, MARQUEE_STACKED, MARQUEE_WIDE, marqueeBulbs } from '../src/components/fantasy/marquee-art.ts';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'public/images/fantasy');
const STAR = 'M32 15l4.6 10 10.9 1.2-8.1 7.4 2.3 10.8L32 39 22.3 44.4l2.3-10.8-8.1-7.4L27.4 25z';

function markSvg(art, { bulbs = true } = {}) {
  const dots = bulbs
    ? marqueeBulbs(art).map(([x, y]) => `<circle cx="${x}" cy="${y}" r="${art.bulbR}" fill="${C.lit}"/>`).join('')
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${art.width} ${art.height}" role="img" aria-label="Broadway Fantasy League">`
    + `<rect x="${art.inset}" y="${art.inset}" width="${art.width - art.inset * 2}" height="${art.height - art.inset * 2}" rx="${art.radius}" fill="${C.sign}" stroke="${C.frame}" stroke-width="3"/>`
    + dots
    + `<path d="${art.broadway}" fill="${C.broadway}"/>`
    + art.lines.map((d) => `<path d="${d}" fill="${C.lit}"/>`).join('')
    + '</svg>';
}

// The tab icon is the one place the name cannot fit: a lit sign with a star.
function iconSvg({ bulbs }) {
  const art = { width: 64, height: 64, inset: 3, bulbGap: 14, bulbR: 2.6 };
  const dots = bulbs ? marqueeBulbs(art).map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2.6" fill="${C.lit}"/>`).join('') : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">`
    + `<rect x="3" y="3" width="58" height="58" rx="10" fill="${C.sign}" stroke="${C.frame}" stroke-width="${bulbs ? 3 : 5}"/>`
    + dots + `<path d="${STAR}" fill="${C.lit}"/></svg>`;
}

const wide = markSvg(MARQUEE_WIDE);
const files = {
  'marquee-wide.svg': wide,
  'marquee-stacked.svg': markSvg(MARQUEE_STACKED),
  // Browsers draw tab icons at 16-32px, where bulbs are noise.
  'marquee-icon.svg': iconSvg({ bulbs: false }),
};
for (const [name, svg] of Object.entries(files)) fs.writeFileSync(path.join(outDir, name), svg + '\n');

const exe = ['/opt/pw-browsers/chromium'].find((p) => fs.existsSync(p));
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
async function shot(html, width, height, file, scale = 1) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:transparent}</style></head><body>${html}</body></html>`, { waitUntil: 'networkidle' });
  await page.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width, height } });
  await page.close();
}

// Email header: transparent background, 2x for retina mail clients.
await shot(`<div style="width:640px;height:170px">${wide}</div>`, 640, 170, path.join(outDir, 'marquee-wide.png'), 2);
await shot(`<div style="width:32px;height:32px">${iconSvg({ bulbs: false })}</div>`, 32, 32, path.join(outDir, 'marquee-icon-32.png'));
await shot(`<div style="width:180px;height:180px;background:${C.sign}">${iconSvg({ bulbs: true })}</div>`, 180, 180, path.join(outDir, 'marquee-icon-180.png'));

// Link preview (Open Graph / Twitter card).
const og = `
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@900&family=Inter:wght@500;600&display=block">
<div style="width:1200px;height:630px;background:#0f0f14;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:0;font-family:Inter,sans-serif">
  <div style="width:700px">${wide}</div>
  <div style="font-family:'Big Shoulders Display',sans-serif;font-weight:900;font-size:66px;color:#f2ede4;margin-top:56px;letter-spacing:0.01em;text-transform:uppercase">Call the hits before opening night.</div>
  <div style="font-size:28px;font-weight:500;color:#a49d92;margin-top:14px">Pick once. Your shows score all season. Best team on Tony night wins.</div>
  <div style="font-size:24px;font-weight:600;color:${C.frame};margin-top:52px">broadwayscorecard.com/fantasy</div>
</div>`;
await shot(og, 1200, 630, path.join(root, 'public/og/fantasy.png'));
await browser.close();

for (const f of ['marquee-wide.svg', 'marquee-stacked.svg', 'marquee-icon.svg', 'marquee-wide.png', 'marquee-icon-32.png', 'marquee-icon-180.png']) {
  console.log(f, fs.statSync(path.join(outDir, f)).size, 'bytes');
}
console.log('og/fantasy.png', fs.statSync(path.join(root, 'public/og/fantasy.png')).size, 'bytes');
