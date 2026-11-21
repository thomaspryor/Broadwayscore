#!/usr/bin/env node
/**
 * Opera Scorecard brand assets (BRO-6770): wordmarks, square profile picture, banners.
 * Same look as the broadway/west-end kit (dark #0f0f14, white first word, gradient "Scorecard"),
 * in opera red. Run: node scripts/generate-opera-brand-kit.js  (needs playwright + chromium).
 * Output: public/brand-kit/logos/opera-*.png, public/brand-kit/social/opera-*.png
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const OUT = path.join(__dirname, '..', 'public', 'brand-kit');
const RED = ['#f0627a', '#c4213f']; // opera red gradient (README: Opera red)
const FONT = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const BG = '#0f0f14';

const word = (fg, size) => `<span style="font-size:${size}px;font-weight:800;letter-spacing:-0.045em;color:${fg}">Opera<span style="background:linear-gradient(90deg,${RED[0]},${RED[1]});-webkit-background-clip:text;color:transparent">Scorecard</span><sup style="font-size:${size * 0.2}px;color:#9ca3af;letter-spacing:0;vertical-align:top;position:relative;top:${size * 0.12}px;margin-left:${size * 0.03}px">TM</sup></span>`;
const page = (w, h, bg, body) => `<html><body style="margin:0;width:${w}px;height:${h}px;background:${bg};font-family:${FONT};display:flex;align-items:center;justify-content:center;flex-direction:column;overflow:hidden">${body}</body></html>`;
const banner = (w, h) => page(w, h, `radial-gradient(ellipse at 50% 0%,#1c1c28,${BG} 70%)`,
  `${word('#fff', Math.round(h * 0.22))}<div style="margin-top:${h * 0.06}px;font-size:${h * 0.058}px;color:#a1a1b0">Every major opera production, every critic, one score.</div><div style="margin-top:${h * 0.05}px;font-size:${h * 0.04}px;font-weight:700;letter-spacing:.06em;color:${RED[0]}">OPERASCORECARD.COM</div>`);

const jobs = [
  ['logos/opera-wordmark-dark.png', 1200, 258, page(1200, 258, BG, word('#fff', 130)), false],
  ['logos/opera-wordmark-light.png', 1200, 258, page(1200, 258, '#ffffff', word('#0f0f14', 130).replace(RED[0], '#d63a58')), false],
  ['logos/opera-wordmark-transparent.png', 1200, 258, page(1200, 258, 'transparent', word('#fff', 130)), true],
  ['social/opera-profile-1080x1080.png', 1080, 1080, page(1080, 1080, `radial-gradient(circle at 50% 30%,#22222f,${BG} 75%)`,
    `<div style="font-size:560px;font-weight:800;letter-spacing:-0.03em;line-height:1;color:#fff">O<span style="display:inline-block;padding:0 0.06em 0 0.02em;background:linear-gradient(135deg,${RED[0]},${RED[1]});-webkit-background-clip:text;color:transparent">S</span></div>`), false],
  ['social/opera-twitter-header-1500x500.png', 1500, 500, banner(1500, 500), false],
  ['social/opera-bluesky-banner-1500x500.png', 1500, 500, banner(1500, 500), false],
  ['social/opera-facebook-cover-1640x624.png', 1640, 624, banner(1640, 624), false],
];

(async () => {
  const browser = await chromium.launch();
  for (const [file, w, h, html, transparent] of jobs) {
    const pg = await browser.newPage({ viewport: { width: w, height: h } });
    await pg.setContent(html);
    const out = path.join(OUT, file);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await pg.screenshot({ path: out, omitBackground: transparent });
    await pg.close();
    console.log(`wrote ${path.relative(process.cwd(), out)} ${w}x${h}`);
  }
  await browser.close();
})();
