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
  assert.deepEqual(Object.keys(A.ADAPTERS).sort(), ['newyorker', 'nyt', 'telegraph', 'thestage', 'thetimes', 'wapo', 'wsj']);
  for (const id of ['thestage', 'nytimes', 'newyorker', 'washpost', 'wsj', 'times-uk', 'sunday-times', 'telegraph', 'sunday-telegraph']) {
    assert.ok(A.adapterFor(id), `no adapter for ${id}`);
  }
  assert.equal(A.adapterFor('guardian'), null);
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
  // Telegraph: unmeasured and the session ends with the month, so nightly off;
  // a run that names --outlet=telegraph plans it (BRO-7171).
  assert.equal(A.ADAPTERS.telegraph.nightly, false);
  assert.equal(A.adapterUsable('telegraph'), false);
  assert.equal(A.adapterUsable('telegraph', { explicitOutlets: new Set(['telegraph']) }), true);
  assert.equal(A.adapterUsable('guardian', { explicitOutlets: new Set(['guardian']) }), false);
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

// BRO-7171: Telegraph fixtures (markup shapes from live pages, placeholder prose).
const fs = require('fs');
const path = require('path');
const fx = (n) => fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '__fixtures__', 'telegraph', n), 'utf8');

test('extractTelegraphBody joins every article-body-text block and drops furniture between and after', () => {
  const t = A.extractTelegraphBody(fx('logged-in.html'));
  for (let i = 1; i <= 5; i++) assert.match(t, new RegExp(`Fixture paragraph ${['one', 'two', 'three', 'four', 'five'][i - 1]}\\.`));
  assert.match(t, /linked phrase/);
  assert.match(t, /until Jun 20$/, 'ends at the listing line, before the Recommended teaser');
  assert.doesNotMatch(t, /Fixture caption|Credit|Recommended|best plays and musicals|Join the conversation|Published/);
  assert.doesNotMatch(t, /^Share$/m, 'page-furniture strips the share token');
  assert.equal(t.split('\n\n').length, 6, 'paragraph breaks kept');
  assert.equal(A.extractTelegraphBody('<html><body><p>no body</p></body></html>'), null);
});

test('Telegraph adapter: subscriber page -> text; walled page -> authWall; Akamai page -> bot check', async () => {
  const ok = await A.ADAPTERS.telegraph.extract(fakePage({ html: fx('logged-in.html') }), 'https://www.telegraph.co.uk/theatre/what-to-see/x/');
  assert.equal(ok.error, undefined);
  assert.ok(ok.len > 1000 && ok.text.startsWith('Fixture paragraph one'));

  const walled = await A.ADAPTERS.telegraph.extract(fakePage({ html: fx('walled.html') }), 'https://www.telegraph.co.uk/theatre/what-to-see/x/');
  assert.equal(walled.authWall, true);
  assert.equal(walled.text, undefined, 'the teaser is never handed on as a body');
  // The blurred column is a wall even when the teaser runs long.
  const longTeaser = fx('walled.html').replace('Fixture teaser.', 'Fixture teaser. ' + 'More teaser words here. '.repeat(80));
  assert.equal((await A.ADAPTERS.telegraph.extract(fakePage({ html: longTeaser }), 'https://www.telegraph.co.uk/x/')).authWall, true);

  const bot = await A.ADAPTERS.telegraph.extract(fakePage({ html: fx('bot-block.html') }), 'https://www.telegraph.co.uk/x/');
  assert.match(bot.error, /Bot-check/);
  assert.equal(bot.authWall, undefined);

  // The lost-session policy: a walled row with a walled probe stops the run;
  // a bot check is skipped. Neither is evidence about the review.
  const probeWalled = async () => A.ADAPTERS.telegraph.extract(fakePage({ html: fx('walled.html') }), A.ADAPTERS.telegraph.testUrl);
  assert.equal((await A.resolveBrowserMiss(walled, { probe: probeWalled, minAuthChars: A.ADAPTERS.telegraph.minAuthChars })).action, 'stop');
  assert.equal((await A.resolveBrowserMiss(bot, { probe: probeWalled, minAuthChars: A.ADAPTERS.telegraph.minAuthChars })).action, 'skip');
});

test('renew-cookies: telegraph is manual-only and local-only, with a browser-only probe on the adapter testUrl', () => {
  const { RENEW_OUTLETS } = require('./cookie-renew.js');
  const { COOKIE_PROBES, classifyWalledProbe } = require('./cookie-probes.js');
  const cfg = RENEW_OUTLETS.telegraph;
  assert.equal(cfg.manualOnly, true);
  assert.equal(cfg.localOnly, true);
  assert.equal(cfg.selectors, undefined, 'no automatic credential flow');
  assert.match(cfg.loginUrl, /^https:\/\/secure\.telegraph\.co\.uk\/customer\/secure\/login\//);
  const p = COOKIE_PROBES.telegraph;
  assert.equal(p.url, A.ADAPTERS.telegraph.testUrl);
  assert.equal(p.browserOnly, true);
  const cls = (html) => classifyWalledProbe({ withCookies: { html, body: p.extractBody(html) || '' }, minBody: p.minBody, wallMarker: p.wallMarker, gateMarker: p.gateMarker });
  assert.equal(cls(fx('logged-in.html')), 'logged-in');
  assert.equal(cls(fx('walled.html')), 'logged-out');
  assert.equal(cls(fx('bot-block.html')), 'error', 'a bot page is never read as logged out');
});

test('a Stage wall page that still yields a short teaser is an access wall too', async () => {
  const teaser = '<div class="aos-Article-IntroText"><p>' + 'Teaser sentence about the production that the page shows above the wall. '.repeat(4) + '</p></div>';
  const html = STAGE_WALL_HTML.replace('<body>', '<body>' + teaser);
  const r = await A.ADAPTERS.thestage.extract(fakePage({ html }), 'https://www.thestage.co.uk/reviews/x');
  assert.equal(r.authWall, true);
});
