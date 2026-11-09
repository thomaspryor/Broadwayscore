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
