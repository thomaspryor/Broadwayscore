import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { buildBroadcastOpeningNightHtml, buildBroadcastSubjectLine, getScoreColor, siteNameForMarket, buildFromAddress, buildReplyToAddress, resolveNewsletterEdition } = require('./email-templates.js');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('resolveNewsletterEdition rejects unknown editions instead of degrading to Broadway', () => {
  assert.equal(resolveNewsletterEdition('west-end'), 'west-end');
  assert.equal(resolveNewsletterEdition('broadway'), 'broadway');
  assert.equal(resolveNewsletterEdition(undefined), 'broadway'); // cron default
  assert.equal(resolveNewsletterEdition(' west-end '), 'west-end'); // trims
  // 'off-west-end' passes isLondonMarket but is NOT a newsletter edition — it
  // once produced a WE sender on the Broadway audience with Broadway HTML.
  assert.throws(() => resolveNewsletterEdition('off-west-end'), /Unknown NEWSLETTER_EDITION/);
  assert.throws(() => resolveNewsletterEdition('westend'), /Unknown NEWSLETTER_EDITION/);
  assert.throws(() => resolveNewsletterEdition('West-End'), /Unknown NEWSLETTER_EDITION/);
});

test('sender brand follows the market — WE never sends as "Broadway Scorecard" (2026-07-12 incident)', () => {
  assert.equal(siteNameForMarket('west-end'), 'West End Scorecard');
  assert.equal(siteNameForMarket('broadway'), 'Broadway Scorecard');
  assert.equal(siteNameForMarket(undefined), 'Broadway Scorecard'); // unset edition = Broadway
  assert.equal(buildFromAddress('west-end'), 'West End Scorecard <updates@broadwayscorecard.com>');
  // Address must stay on the verified Resend domain for every market.
  assert.match(buildFromAddress('west-end'), /<updates@broadwayscorecard\.com>$/);
  assert.equal(buildFromAddress('broadway'), 'Broadway Scorecard <updates@broadwayscorecard.com>');
});

// Reply-To: `updates@` is a Resend-verified SENDER with no inbox behind it —
// the domain's MX is ImprovMX and `updates@` is not a forwarding alias, so a
// subscriber who hits Reply gets a bounce and the owner never sees it. Every
// audience-facing send must carry a Reply-To that actually receives.
test('reply-to address is an inbox that receives, never the send-only sender', () => {
  assert.equal(buildReplyToAddress(), 'hi@broadwayscorecard.com');
  assert.doesNotMatch(buildReplyToAddress(), /^(updates|noreply|alerts)@/);
});

test('every audience-facing sender sets reply_to on its Resend payload', () => {
  // Source-level guard: these scripts build their payloads inline, so the only
  // way to keep a future sender from silently shipping without Reply-To is to
  // assert on the files themselves.
  const senders = [
    ['scripts/newsletter/create-broadcast-draft.mjs', 1], // weekly round-up broadcast
    ['scripts/newsletter/send-test.mjs', 1],              // weekly round-up test send
    ['scripts/send-opening-night-broadcast.js', 2],       // opening-night broadcast + preview
    ['scripts/send-follow-notifications.js', 1],          // per-show follower alerts
  ];
  for (const [rel, minPayloads] of senders) {
    const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const replyCount = (src.match(/\breply_to:/g) || []).length;
    assert.ok(
      replyCount >= minPayloads,
      `${rel}: expected reply_to on >= ${minPayloads} Resend payload(s), found ${replyCount} — an audience-facing send would bounce replies`,
    );
  }
});

test('getScoreColor ROUNDS before tiering — matches the displayed score + the site', () => {
  // 64.69 displays as 65, so it must read "Worth Seeing", not "Mixed" (the 2026-06-30 bug).
  assert.equal(getScoreColor(64.69, 'west-end').label, 'Worth Seeing');
  assert.equal(getScoreColor(64.4, 'west-end').label, 'Mixed');        // displays 64
  assert.equal(getScoreColor(64.5, 'west-end').label, 'Worth Seeing'); // displays 65
  assert.equal(getScoreColor(60.03, 'west-end').label, 'Mixed');       // displays 60
});

test('getScoreColor Critical Gold threshold is market-aware (WE 85, Broadway 83)', () => {
  assert.equal(getScoreColor(83.4, 'west-end').label, 'Recommended');   // 83 < 85 WE gold
  assert.equal(getScoreColor(84.6, 'west-end').label, 'Critical Gold'); // rounds to 85
  assert.equal(getScoreColor(83, 'broadway').label, 'Critical Gold');   // 83 = BW gold
});

const mk = n => Array.from({ length: n }, (_, i) => ({
  showTitle: `Show ${i + 1}`, score: 70, reviewCount: 20, rave: 5, positive: 8, mixed: 5, negative: 2,
  showUrl: 'https://broadwayscorecard.com/show/x',
}));
const h1 = html => (html.match(/<h1[^>]*>([^<]+)<\/h1>/) || [])[1];

test('multi-show headline never claims "Tonight" (roundup may span days)', () => {
  for (const market of ['west-end', 'broadway']) {
    const html = buildBroadcastOpeningNightHtml(mk(6), null, market);
    assert.ok(!html.includes('Tonight'), `"${market}" email must not say Tonight`);
  }
});

test('multi-show headline is market-aware and mirrors the subject location', () => {
  assert.match(h1(buildBroadcastOpeningNightHtml(mk(6), null, 'west-end')), /^6 Shows Opened in the West End/);
  assert.match(h1(buildBroadcastOpeningNightHtml(mk(3), null, 'broadway')), /^3 Shows Opened on Broadway/);
});

test('single-show headline unchanged (title + score)', () => {
  const html = buildBroadcastOpeningNightHtml([{ showTitle: 'Sinatra', score: 64, reviewCount: 30, showUrl: 'https://x' }], null, 'west-end');
  assert.match(h1(html), /^Sinatra Critic Reviews Are In/);
});

test('subject line stays accurate and market-aware (no Tonight)', () => {
  assert.equal(buildBroadcastSubjectLine(mk(6), 'west-end'), '6 shows opened in the West End — the reviews are in');
  assert.ok(!buildBroadcastSubjectLine(mk(6), 'west-end').includes('Tonight'));
});
