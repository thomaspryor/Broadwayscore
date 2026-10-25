import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { ingestFailureReason, INGEST_REASON_MAX } = require('./ingest-failure-reason');
const { describeUnresolvedProvisionalOutlet } = require('./aggregator-domains');

const HOSTS = ['thestage.co.uk', 'timeout.com', 'uktw.co.uk', 'whatsonlive.co.uk', 'yourlocalguardian.co.uk', 'aol.co.uk'];
const KINDS = [
  (h) => `Paywall detected on https://www.${h}/review/some-long-article-slug: subscriber-only content, extraction returned 0 chars after fallback chain Bright Data -> ScrapingBee -> Playwright`,
  (h) => `Bot-block (HTTP 403 Cloudflare challenge) fetching https://www.${h}/reviews/another-long-article-slug via every provider; ScrapingBee credits exhausted`,
  (h) => `Fetch error ETIMEDOUT while requesting https://www.${h}/stage/reviews/yet-another-long-article-slug-2026`,
];

test('failure reason is kept in full for every outlet and failure kind', () => {
  for (const h of HOSTS) for (const kind of KINDS) {
    const msg = kind(h);
    assert.ok(msg.length > 100, 'fixture must exceed the old 100-char cap');
    const reason = ingestFailureReason(new Error(`Command failed: node ingest.js\n${msg}`));
    assert.equal(reason, msg);
  }
});

test('registry status for unresolved provisional outlets is not cut off', () => {
  for (const h of HOSTS) {
    const status = describeUnresolvedProvisionalOutlet(h);
    assert.equal(ingestFailureReason(new Error(status)), status);
  }
});

test('domain-collision noise lines do not eat the reason', () => {
  const noise = '⚠️  Domain collision on timeout.com\n'.repeat(5);
  const real = 'Paywall detected: subscriber-only content '.repeat(4).trim();
  assert.equal(ingestFailureReason(new Error(`Command failed: x\n${noise}${real}`)), real);
});

test('very long output is capped at INGEST_REASON_MAX', () => {
  assert.equal(ingestFailureReason(new Error('x'.repeat(5000))).length, INGEST_REASON_MAX);
});

test('audit-show-review-gap uses the helper, not a 100-char execErrorDetail cap', () => {
  const src = fs.readFileSync(new URL('../audit-show-review-gap.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /execErrorDetail\(/);
  assert.equal((src.match(/ingestFailureReason\(e\)/g) || []).length, 2);
});

test('no audit script caps an ingest child failure at 100 chars', () => {
  const dir = new URL('../', import.meta.url);
  for (const f of fs.readdirSync(dir).filter((n) => /^audit-.*\.js$/.test(n))) {
    const src = fs.readFileSync(new URL(f, dir), 'utf8');
    assert.doesNotMatch(src, /execErrorDetail\(e, *100\)/, `${f} truncates ingest failures to 100 chars`);
  }
});

test('parent timeout keeps the child stderr, not only "spawnSync ETIMEDOUT"', async () => {
  const { execFileSync } = await import('node:child_process');
  let err;
  try {
    execFileSync('node', ['-e', 'console.error("Paywall detected on thestage.co.uk: subscriber-only"); setTimeout(()=>{}, 20000)'], { stdio: 'pipe', timeout: 1500, killSignal: 'SIGKILL' });
  } catch (e) { err = e; }
  const reason = ingestFailureReason(err);
  assert.match(reason, /ETIMEDOUT/);
  assert.match(reason, /Paywall detected on thestage\.co\.uk/);
});
