// BRO-7171 Stage 4: shared subscriber-browser adapters (all six recover-*-browser.js outlets).
// Run: node --test scripts/lib/browser-outlet-adapters.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const A = require('./browser-outlet-adapters.js');

/** Minimal Playwright page double. */
function fakePage({ status = 200, evalResult = { text: 'x'.repeat(2000), title: 'T' }, html = '<html></html>', title = 'T' } = {}) {
  const calls = { waitForSelector: 0 };
  return {
    calls,
    goto: async () => ({ status: () => status }),
    waitForTimeout: async () => {},
    waitForSelector: async () => { calls.waitForSelector++; },
    evaluate: async () => evalResult,
    content: async () => html,
    title: async () => title,
  };
}

test('every recover-*-browser.js outlet has an adapter, keyed by its persistent profile name', () => {
  assert.deepEqual(Object.keys(A.ADAPTERS).sort(), ['newyorker', 'nyt', 'thestage', 'thetimes', 'wapo', 'wsj']);
  for (const id of ['thestage', 'nytimes', 'newyorker', 'washpost', 'wsj', 'times-uk', 'sunday-times']) {
    assert.ok(A.adapterFor(id), `no adapter for ${id}`);
  }
  assert.equal(A.adapterFor('telegraph'), null);
  for (const a of Object.values(A.ADAPTERS)) {
    assert.ok(a.testUrl && a.cookieDomain && a.minAuthChars > 0 && a.labels.fetchMethod);
  }
});

test('30% rule per adapter: a nightly:false adapter is planned only when the run names its outlet', () => {
  assert.equal(A.ADAPTERS.nyt.nightly, false, 'NYT measured 4/20 live (20%)');
  assert.equal(A.ADAPTERS.wapo.nightly, false, 'WaPo measured 0/40 live');
  assert.equal(A.ADAPTERS.thetimes.nightly, false, 'Times measured 0/20 live');
  assert.equal(A.ADAPTERS.wsj.nightly, false, 'WSJ measured 1/20 live');
  assert.equal(A.ADAPTERS.newyorker.nightly, false, 'New Yorker measured 0/20 live');
  assert.equal(A.adapterUsable('nytimes'), false);
  assert.equal(A.adapterUsable('nytimes', { explicitOutlets: new Set(['nytimes']) }), true);
  assert.equal(A.adapterUsable('nytimes', { explicitOutlets: new Set(['thestage']) }), false);
  assert.equal(A.adapterUsable('thestage'), true, 'The Stage measured 18/20');
  assert.equal(A.adapterUsable('telegraph'), false);
});

test('the driver plans BROWSER_SESSION through adapterUsable, not bare adapterFor', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../gap-recovery-driver.js', import.meta.url), 'utf8');
  assert.match(src, /hasAdapter:\s*adapterUsable\(review\.outletId,\s*\{\s*explicitOutlets:\s*OPTS\.outlets\s*\}\)/);
});

test('a 404/410 is reported as notFound (dead url), before any body read', async () => {
  for (const name of Object.keys(A.ADAPTERS)) {
    const page = fakePage({ status: 404 });
    const r = await A.ADAPTERS[name].extract(page, 'https://example.com/a');
    assert.equal(r.notFound, true, name);
    assert.equal(r.status, 404);
    assert.equal(r.text, undefined);
  }
});

test('DOM adapters return text + html; WSJ waits for its client-rendered <article>', async () => {
  const page = fakePage();
  const r = await A.ADAPTERS.wsj.extract(page, 'https://www.wsj.com/a?gaa_x=1');
  assert.equal(r.len, 2000);
  assert.equal(page.calls.waitForSelector, 1);
  const nytPage = fakePage();
  await A.ADAPTERS.nyt.extract(nytPage, 'https://www.nytimes.com/a');
  assert.equal(nytPage.calls.waitForSelector, 0);
  const bot = await A.ADAPTERS.wsj.extract(fakePage({ evalResult: { bot: true } }), 'https://www.wsj.com/a');
  assert.equal(bot.error, 'DataDome challenge detected');
  const empty = await A.ADAPTERS.wapo.extract(fakePage({ evalResult: { text: '', title: 'x' } }), 'https://www.washingtonpost.com/a');
  assert.match(empty.error, /No article body/);
});

// BRO-7171 follow-up: The Stage's registration wall (markup copied from a
// logged-out page, 2026-11-10) is an access wall, not "no body" / "too short".
const STAGE_WALL_HTML = '<html><body><div class="aos-ArticleTitle">X review</div>'
  + '<p dir="ltr" style="text-align: center;">Join over 100,000 theatremakers who rely on The Stage for trusted news, reviews, and insight.</p>'
  + '<p dir="ltr" style="text-align: center;"><strong>🔓 Sign in below or <a href="https://www.thestage.co.uk/registration?utm_source=Reggate"><span style="color: #00929e;">create a free account</span> </a>to read 5 free articles.</strong></p>'
  + '</body></html>';

test('The Stage registration wall is reported as authWall, not a missing body', async () => {
  const r = await A.ADAPTERS.thestage.extract(fakePage({ html: STAGE_WALL_HTML }), 'https://www.thestage.co.uk/reviews/x');
  assert.equal(r.authWall, true);
  assert.match(r.error, /access wall/);
  const plain = await A.ADAPTERS.thestage.extract(fakePage({ html: '<html><body><p>nothing</p></body></html>' }), 'https://www.thestage.co.uk/reviews/x');
  assert.equal(plain.authWall, undefined);
  assert.match(plain.error, /No article body/);
});

test('resolveBrowserMiss: lost session stops the run; wall and bot check are never evidence', async () => {
  const live = async () => ({ text: 'x'.repeat(900), len: 900 });
  const dead = async () => ({ error: 'access wall (sign-in/registration) in place of the body', authWall: true });
  const short = async () => ({ text: 'x'.repeat(100), len: 100 });
  const o = (probe, refusalCode = null) => ({ probe, minAuthChars: 500, refusalCode });
  // 404 is evidence without probing.
  let probed = false;
  assert.equal((await A.resolveBrowserMiss({ error: 'HTTP 404 not found', notFound: true }, o(async () => { probed = true; return {}; }))).action, 'evidence');
  assert.equal(probed, false);
  assert.equal((await A.resolveBrowserMiss({ error: 'Bot-check challenge detected' }, o(live))).action, 'skip');
  // Wall: session dead -> stop; session live (e.g. metered) -> skip, never stamped.
  assert.equal((await A.resolveBrowserMiss({ error: 'wall', authWall: true }, o(dead))).action, 'stop');
  assert.equal((await A.resolveBrowserMiss({ error: 'wall', authWall: true }, o(live))).action, 'skip');
  // No body: evidence only while the probe still passes its floor.
  assert.equal((await A.resolveBrowserMiss({ error: 'No article body' }, o(live))).action, 'evidence');
  assert.equal((await A.resolveBrowserMiss({ error: 'No article body' }, o(short))).action, 'stop');
  assert.equal((await A.resolveBrowserMiss({ error: 'No article body' }, o(async () => { throw new Error('closed'); }))).action, 'stop');
  // Extracted but refused too short: probe decides; other refusals never probe.
  assert.equal((await A.resolveBrowserMiss({ text: 'short' }, o(dead, 'too_short'))).action, 'stop');
  assert.equal((await A.resolveBrowserMiss({ text: 'short' }, o(live, 'too_short'))).action, 'evidence');
  probed = false;
  assert.equal((await A.resolveBrowserMiss({ text: 'y'.repeat(4000) }, o(async () => { probed = true; return {}; }, 'show_not_mentioned'))).action, 'evidence');
  assert.equal(probed, false);
});

test('a Stage wall page that still yields a short teaser is an access wall too', async () => {
  const teaser = '<div class="aos-Article-IntroText"><p>' + 'Teaser sentence about the production that the page shows above the wall. '.repeat(4) + '</p></div>';
  const html = STAGE_WALL_HTML.replace('<body>', '<body>' + teaser);
  const r = await A.ADAPTERS.thestage.extract(fakePage({ html }), 'https://www.thestage.co.uk/reviews/x');
  assert.equal(r.authWall, true);
});
