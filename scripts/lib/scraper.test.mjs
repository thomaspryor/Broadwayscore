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
  // BRO-5725: full-size (~29KB) Cloudflare managed challenge must not pass the <10KB gate
  assert.equal(s.isChallengeOrGarbage(`<html><head><title>Just a moment...</title></head><body>${'x'.repeat(28000)}</body></html>`), true);
  const big = (head, body = '') => `<html><head>${head}</head><body>${body}${'x'.repeat(28000)}</body></html>`;
  assert.equal(s.isChallengeOrGarbage(big('<title>Attention Required! | Cloudflare</title>')), true);
  assert.equal(s.isChallengeOrGarbage(big('<title>Just a moment…</title>')), true);
  assert.equal(s.isChallengeOrGarbage(big('', 'window._cf_chl_opt={};<script src="/cdn-cgi/challenge-platform/h/b/orchestrate"></script>')), true);
  assert.equal(s.isChallengeOrGarbage(`<html><head><title>Review: Just a moment</title></head><body>${'x'.repeat(28000)}</body></html>`), false);
});

test('Akamai "Access Denied" (dailymail.co.uk to a throttled IP) is garbage, not a Playwright success (BRO-716)', () => {
  const akamai = '<html><head> <title>Access Denied</title> </head><body> <h1>Access Denied</h1> You don\'t have permission to access "http://www.dailymail.co.uk/home/sitemaparchive/day_20260515.html" on this server.<p> Reference #18.ceb52e17.1792286261.589ab499 </p><p>https://errors.edgesuite.net/18.ceb52e17.1792286261.589ab499</p></body></html>';
  assert.equal(s.isChallengeOrGarbage(akamai), true);
  // An article that merely quotes the phrase, with no Access Denied title, survives.
  assert.equal(s.isChallengeOrGarbage('<title>Review: The Trial</title><p>"You don\'t have permission to access this room," he says.</p>'), false);
});

test('a large WAF "Access Denied" robot-block page is garbage, a review quoting the phrase is not (BRO-5133)', () => {
  const pad = 'x'.repeat(19000);
  const block = `<html><head><title>Access Denied</title></head><body>Your access to this page has been blocked. Your request appears similar to malicious requests sent by robots.${pad}</body></html>`;
  assert.equal(s.isChallengeOrGarbage(block), true);
  const article = `<html><head><title>A review</title></head><body>The bouncer says your request appears similar to malicious requests sent by robots.${pad}</body></html>`;
  assert.equal(s.isChallengeOrGarbage(article), false);
});

test('BRO-5874: a near-empty HTML shell is garbage so the chain moves on', () => {
  const shell = '<html><head><title>Bachtrack</title><meta name="description" content="x"></head><body><script>var a=1;</script></body></html>';
  assert.equal(s.isChallengeOrGarbage(shell), true);
  assert.equal(s.isNearEmptyHtmlShell(shell), true);
  // A short page with real prose, JSON and markdown are not judged by the shell rule.
  const prose = `<html><body><p>${'A real sentence of review text. '.repeat(10)}</p></body></html>`;
  assert.equal(s.isChallengeOrGarbage(prose), false);
  assert.equal(s.isChallengeOrGarbage('{"ok":true}'), false);
  assert.equal(s.isChallengeOrGarbage('# Heading\n\nshort markdown'), false);
  // A big page is never a shell, even with little text.
  assert.equal(s.isNearEmptyHtmlShell(`<html><body>${'<div></div>'.repeat(800)}</body></html>`), false);
});

test('BRO-5875: redirect wrappers and <pre> pages are not judged as empty shells', () => {
  assert.equal(s.isNearEmptyHtmlShell('<html><head><meta http-equiv="refresh" content="0;url=https://x.com/a"></head><body></body></html>'), false);
  assert.equal(s.isNearEmptyHtmlShell('<html><body><script>location.replace("https://x.com/a")</script></body></html>'), false);
  assert.equal(s.isNearEmptyHtmlShell('<html><body><pre>{"a":1}</pre></body></html>'), false);
});
