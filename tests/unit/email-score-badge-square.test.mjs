// The opening-night email's score badge must be square (owner 2026-11-17, The
// Fantasticks email rendered 72x77). Cause: the link around the number had no
// font-size, so its line box used the default font, and baseline-aligning that
// strut with the 32px number added ~5px of height. Every box inside the badge must
// carry the number's font-size and an exact 72px line. A browser measurement runs
// when Chromium is available (cloud containers and the Mac); the static rule runs
// everywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const t = require('../../scripts/lib/email-templates.js');

const SHOW = { showTitle: 'Test Show', showUrl: 'https://broadwayscorecard.com/show/test-show', score: 79, reviewCount: 22, rave: 5, positive: 16, mixed: 1, negative: 0 };
const broadcast = (market) => t.buildBroadcastOpeningNightHtml([SHOW], 'a@b.com', market);

function badgeCells(html) {
  const out = [];
  const re = /<td width="72" height="72"[^>]*>([\s\S]*?)<\/td>/g;
  let m;
  while ((m = re.exec(html))) out.push(m[0]);
  return out;
}

for (const market of ['broadway', 'west-end']) {
  test(`badge boxes all carry the number's font-size and a 72px line (${market})`, () => {
    const cells = badgeCells(broadcast(market));
    assert.ok(cells.length >= 1, 'no score badge found');
    for (const cell of cells) {
      const tags = cell.match(/<(td|a|span)\b[^>]*style="[^"]*"/g) || [];
      for (const tag of tags) {
        assert.match(tag, /font-size:32px/, `missing font-size:32px: ${tag.slice(0, 80)}`);
        assert.match(tag, /line-height:72px/, `missing line-height:72px: ${tag.slice(0, 80)}`);
      }
    }
  });
}

const CHROMIUM = '/opt/pw-browsers/chromium';
test('badge renders exactly 72x72 in a browser', { skip: !existsSync(CHROMIUM) && !process.env.EMAIL_BADGE_BROWSER }, async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch(existsSync(CHROMIUM) ? { executablePath: CHROMIUM } : {});
  try {
    for (const width of [390, 700]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.setContent(broadcast('broadway'));
      const size = await page.evaluate(() => {
        const r = document.querySelector('td[width="72"]').getBoundingClientRect();
        return [Math.round(r.width), Math.round(r.height)];
      });
      assert.deepEqual(size, [72, 72], `badge at ${width}px viewport`);
    }
  } finally { await browser.close(); }
});
