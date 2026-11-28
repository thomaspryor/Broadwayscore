// Class guard (BRO-7530 /what-else): subscriber emails built in email-templates.js
// must not be wider than a small phone. The weekly newsletter has its own gate
// (scripts/newsletter/overflow-check.mjs); this covers the opening-night emails.
// Found by it: the broadcast's "Follow" row joined links with no space, so it was
// one unbreakable 315px string and pushed the email to 347px on a 320px phone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const T = require('./email-templates.js');

const WIDTHS = [320, 360, 390];
const oc = { score: 77, reviewCount: 33, newReviewCount: 2, tier: 'Recommended', breakdown: { positive: 24, mixed: 7, negative: 2 } };
const show = (id, title, score) => ({ showTitle: title, score, reviewCount: 33, newReviewCount: 0, breakdown: { positive: 24, mixed: 7, negative: 2 }, showUrl: `https://broadwayscorecard.com/show/${id}`, showId: id, imageUrl: 'https://example.invalid/poster.jpg' });

const welcome = require('./welcome-email.js');

const EMAILS = {
  'welcome email': () => welcome.buildWelcomeEmailHtml({ displayName: 'Alexandra-Maria Fitzgerald-Montgomery', email: 'a@b.com' }),
  'opening-night single (broadway)': () => T.buildOpeningNightHtml('Cloud 9 With A Rather Long Revival Title', oc, [], 'https://broadwayscorecard.com/show/cloud-9', 'cloud-9', 'a@b.com', null, 'broadway'),
  'opening-night single (west end)': () => T.buildOpeningNightHtml('Cloud 9 With A Rather Long Revival Title', oc, [], 'https://westendscorecard.com/show/cloud-9', 'cloud-9', 'a@b.com', null, 'west-end'),
  'broadcast (broadway)': () => T.buildBroadcastOpeningNightHtml([show('a', 'Cloud 9 With A Rather Long Revival Title', 77), show('b', 'Dogstar', 64)], 'a@b.com', 'broadway'),
  'broadcast (west end)': () => T.buildBroadcastOpeningNightHtml([show('a', 'Cloud 9 With A Rather Long Revival Title', 77), show('b', 'Dogstar', 64)], 'a@b.com', 'west-end'),
};

// NOTE: the Chromium test below skips where no browser is installed (the scripts/lib
// unit shard has none), so this static check is the part that always runs in CI.
test('social row can wrap (links are separated by breakable spaces)', () => {
  const html = T.buildSocialRowHtml('broadway');
  assert.match(html, /<\/a>&nbsp;<span[^>]*>&middot;<\/span> <a /, 'separator needs a breakable space after it or the row cannot wrap');
});

test('subscriber emails do not overflow 320/360/390px phones', async (t) => {
  let chromium, launchExtras;
  try { ({ chromium } = require('playwright')); ({ launchExtras } = require('./playwright-exe.js')); } catch { return t.skip('playwright not installed'); }
  let browser;
  try { browser = await chromium.launch(launchExtras(chromium)); } catch { return t.skip('no chromium'); }
  try {
    const bad = [];
    for (const [name, build] of Object.entries(EMAILS)) {
      for (const w of WIDTHS) {
        const page = await browser.newPage({ viewport: { width: w, height: 900 } });
        await page.setContent(build());
        const sw = await page.evaluate(() => document.documentElement.scrollWidth);
        if (sw > w + 2) bad.push(`${name} at ${w}px is ${sw}px wide`);
        await page.close();
      }
    }
    assert.deepEqual(bad, []);
  } finally { await browser.close(); }
});
