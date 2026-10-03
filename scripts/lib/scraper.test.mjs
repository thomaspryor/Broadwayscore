// BRO-2763: westendtheatre.com / britishtheatreguide.info / whatsonstage.com
// listing pages were fetched fine by SD/BD/SB but every provider's result was
// rejected by the url_mismatch guard (canonical differs from requested path on
// the SAME host), and Playwright's networkidle wait timed out on never-idle sites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
process.env.SCRAPER_SPEND_LEDGER_PATH = path.join(os.tmpdir(), `scraper-ledger-test-${process.pid}.jsonl`);
const s = require('./scraper.js');

const page = (canonical) => `<html><head><title>x</title><link rel="canonical" href="${canonical}" /></head><body>${'a'.repeat(600)}</body></html>`;

test('same-host index redirects verify (the three BRO-2763 URLs)', () => {
  const cases = [
    ['https://www.whatsonstage.com/reviews/', 'https://www.whatsonstage.com/news/'],
    ['https://www.westendtheatre.com/category/reviews/', 'https://www.westendtheatre.com/category/news/reviews/'],
    ['https://www.britishtheatreguide.info/reviews/index', 'https://www.britishtheatreguide.info/reviews?q=index'],
  ];
  for (const [req, canon] of cases) {
    const r = s.verifyFetchedUrl(page(canon), req);
    assert.equal(r.verified, true, req);
    assert.equal(r.reason, 'same_host_redirect');
  }
});

test('article URLs on the same hosts are still guarded', () => {
  const guarded = [
    ['https://www.whatsonstage.com/theatre/some-show-review_456.html', 'https://www.whatsonstage.com/theatre/other-show-review_123.html'],
    ['https://www.whatsonstage.com/reviews/some-article', 'https://www.whatsonstage.com/news/x'],
    ['https://www.britishtheatreguide.info/reviews/archduke-royal-court-the-25696', 'https://www.britishtheatreguide.info/reviews/other-show-99999'],
    ['https://www.britishtheatreguide.info/reviews/archduke-royal-court-the-25696', 'https://www.britishtheatreguide.info/'],
    ['https://www.westendtheatre.com/category/reviews/a/', 'https://www.westendtheatre.com/other/'],
    ['https://www.westendtheatre.com/category/reviews-foo/', 'https://www.westendtheatre.com/other/'],
  ];
  for (const [req, canon] of guarded) {
    const r = s.verifyFetchedUrl(page(canon), req);
    assert.equal(r.verified, false, req);
    assert.equal(r.reason, 'url_mismatch');
  }
});

test('unlisted hosts still reject same-host drift', () => {
  assert.equal(s.verifyFetchedUrl(page('https://example.com/b'), 'https://example.com/a').verified, false);
});

test('never-idle domains are registered for domcontentloaded', () => {
  assert.ok(s.NEVER_IDLE_DOMAINS.has('westendtheatre.com'));
  assert.ok(s.NEVER_IDLE_DOMAINS.has('britishtheatreguide.info'));
});

test('Cloudflare interstitial is still treated as garbage', () => {
  assert.equal(s.isChallengeOrGarbage('<title>Just a moment...</title>'), true);
});
