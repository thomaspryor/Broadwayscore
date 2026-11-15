// Class guard for the owner's 2026-11-15 report (small iPhone: squished info
// column, cards 250-346px tall) and the 2026-11-02 one before it. The old
// overflow gate tested a single 375px width; this pins the multi-width gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { WIDTHS, LIMITS, evaluateLayout, measureLayout } from './mobile-layout-check.mjs';
const require = createRequire(import.meta.url);
const { showCardHtml, POSTER_W, POSTER_H, SCORE_COL_W } = require('../lib/newsletter-show-card.js');

// Metrics measured from the real West End weekly of Nov 9-15 2026 at 320px.
const OLD_320 = { docWidth: 355, cards: [{ title: 'hamlet-hail-to-the-thief-off-west-end', height: 346, infoWidth: 89 }], pills: [{ text: 'OFF WEST END', height: 49 }] };
const NEW_320 = { docWidth: 320, cards: [{ title: 'hamlet-hail-to-the-thief-off-west-end', height: 254, infoWidth: 117 }], pills: [{ text: 'OFF WEST END', height: 19 }] };

test('the layout that shipped on 2026-11-15 fails the gate on every complaint', () => {
  const p = evaluateLayout(320, OLD_320).join('\n');
  assert.match(p, /overflows the screen/);
  assert.match(p, /info column is only 89px/);
  assert.match(p, /card is 346px tall/);
  assert.match(p, /pill "OFF WEST END" wrapped/);
});

test('the compact layout passes', () => {
  assert.deepEqual(evaluateLayout(320, NEW_320), []);
});

test('the gate covers the small phones, not just 375', () => {
  for (const w of [320, 360, 375, 390, 430]) assert.ok(WIDTHS.includes(w), `${w}px`);
  assert.ok(LIMITS.minInfoWidth >= 100 && LIMITS.maxCardHeight < 346, 'must still catch the 346px squished card');
});

test('the side columns leave a readable info column at 320px', () => {
  // outer gutters 10+10, card borders ~2, info padding 16: what is left for text
  const room = 320 - 20 - 2 - (POSTER_W + 12) - (SCORE_COL_W + 10) - 16;
  assert.ok(room >= 100, `only ${room}px left for title/pills/date at 320px`);
  assert.equal(POSTER_H, POSTER_W * 1.5);
});

test('showCardHtml stamps the marker the gate selects on', () => {
  const html = showCardHtml({ posterHtml: '', infoHtml: '', scoreColHtml: '<td></td>' });
  assert.match(html, /<table[^>]*data-show-card=/);
});

// Real layout in Chromium when it is available (CI and the cloud image have it).
test('a real show card keeps its info column wide and short at every phone width', async (t) => {
  let chromium, launchExtras;
  try { ({ chromium } = require('playwright')); ({ launchExtras } = require('../lib/playwright-exe.js')); } catch { return t.skip('playwright not installed'); }
  let browser;
  try { browser = await chromium.launch(launchExtras(chromium)); } catch { return t.skip('no chromium'); }
  try {
    const card = showCardHtml({
      posterHtml: `<div style="width:${POSTER_W}px;height:${POSTER_H}px;background:#444"></div>`,
      infoHtml: `<div style="font-size:16px;font-weight:700;line-height:1.25;">Hamlet Hail to the Thief</div>
        <div><span class="mp" style="display:inline-block;padding:2px 8px;font-size:10px;line-height:1.5;white-space:nowrap">OFF WEST END</span><span class="gp" style="display:inline-block;padding:2px 8px;font-size:10px;line-height:1.5;white-space:nowrap">PLAY</span></div>
        <div style="font-size:13px">Opened Thu Nov 12</div><div style="font-size:13px">Barbican Centre</div>`,
      scoreColHtml: `<td width="${SCORE_COL_W}" style="padding:12px 10px 12px 0;text-align:center;"><div style="width:56px;height:56px;background:#2c5"></div><div style="font-size:10px">26 reviews</div></td>`,
    });
    for (const w of WIDTHS) {
      const page = await browser.newPage({ viewport: { width: w, height: 800 } });
      // A 3-cell dark group box (the "Biggest Movers" shape) must NOT be judged as a show card.
      const mover = `<table bgcolor="#1a1a24" width="100%"><tr><td width="48">x</td><td>Midnight</td><td width="96">y</td></tr></table>`;
      await page.setContent(`<body style="margin:0"><table role="presentation" width="100%"><tr><td style="padding:24px 10px">${card}${mover}</td></tr></table></body>`);
      const m = await page.evaluate(measureLayout);
      assert.equal(m.cards.length, 1, `${w}px: card found`);
      assert.deepEqual(evaluateLayout(w, m), [], `${w}px`);
      await page.close();
    }
  } finally { await browser.close(); }
});
