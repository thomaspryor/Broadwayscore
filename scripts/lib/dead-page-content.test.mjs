import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  detectParkedDomain,
  chromeFingerprint,
  buildChromeFingerprintIndex,
  classifyDeadPage,
  CHROME_MIN_LENGTH,
} = require('./dead-page-content.js');

const pad = (s, n = CHROME_MIN_LENGTH + 50) => (s + ' ').repeat(Math.ceil(n / (s.length + 1))).slice(0, n);

// ── parked domains ─────────────────────────────────────────────────────────

test('detects the theaternewsonline parking page (20 files in the live corpus)', () => {
  const text = 'theaternewsonline.com Skip to main content Excellent 4.6 out of 5 Trustpilot '
    + 'The domain name theaternewsonline.com is for sale! Premium Verified Domain '
    + 'Get a price in less than 24 hours First Name * Last Name * Email *';
  const r = detectParkedDomain(text);
  assert.equal(r.detected, true);
  assert.match(r.match, /is for sale/i);
});

test('detects the other parking-page phrasings', () => {
  assert.equal(detectParkedDomain('This domain is for sale.').detected, true);
  assert.equal(detectParkedDomain('Buy this domain today').detected, true);
  assert.equal(detectParkedDomain('The domain name is parked and awaiting setup').detected, true);
});

// ── the false positives that matter: real theatre prose about "domain" ─────

test('theatre prose about the public domain is NOT a parked page', () => {
  const lines = [
    'The score fell into the public domain last year, which is why this revival can use it.',
    'Chekhov is in the public domain, so every company in town has a Cherry Orchard.',
    'She rules the stage as if it were her private domain.',
    'The production buys this domain of grief with an unbroken ninety minutes.',
  ];
  for (const l of lines) {
    assert.equal(detectParkedDomain(l).detected, false, `must not match: ${l}`);
  }
});

test('empty and non-string input is safe', () => {
  assert.equal(detectParkedDomain('').detected, false);
  assert.equal(detectParkedDomain(null).detected, false);
  assert.equal(detectParkedDomain(undefined).detected, false);
});

// ── cross-show chrome ──────────────────────────────────────────────────────

test('identical text under 3+ different shows is boilerplate', () => {
  const chrome = pad('Please note that your choices apply across all our subdomains. Once you give consent');
  const files = [
    { showId: 'show-a', file: 'x.json', text: chrome },
    { showId: 'show-b', file: 'y.json', text: chrome },
    { showId: 'show-c', file: 'z.json', text: chrome },
  ];
  const idx = buildChromeFingerprintIndex(files);
  assert.equal(idx.size, 1);
  assert.equal([...idx.values()][0].shows.length, 3);
});

test('TWO shows sharing text is NOT boilerplate — a transfer or a wire review', () => {
  // The same critic's review legitimately covers a show's out-of-town run and
  // its Broadway transfer, and wire copy (AP) is republished verbatim. Two is
  // normal; three is not.
  const shared = pad('In 1957, Four Voice Staffers Recalled Their Shock at Hearing FDR Had Died');
  const idx = buildChromeFingerprintIndex([
    { showId: 'tryout-2025', text: shared },
    { showId: 'broadway-2026', text: shared },
  ]);
  assert.equal(idx.size, 0);
});

test('the same show having several copies does not make it boilerplate', () => {
  const t = pad('A genuinely identical file duplicated three times under ONE show');
  const idx = buildChromeFingerprintIndex([
    { showId: 'only-show', file: 'a.json', text: t },
    { showId: 'only-show', file: 'b.json', text: t },
    { showId: 'only-show', file: 'c.json', text: t },
  ]);
  assert.equal(idx.size, 0, 'distinct SHOWS is the threshold, not distinct files');
});

test('short texts are never fingerprinted — they collide by chance', () => {
  assert.equal(chromeFingerprint('Too short to judge.'), null);
  const short = 'Rave. Go.';
  const idx = buildChromeFingerprintIndex([
    { showId: 'a', text: short }, { showId: 'b', text: short }, { showId: 'c', text: short },
  ]);
  assert.equal(idx.size, 0);
});

test('fingerprinting ignores whitespace differences', () => {
  const a = pad('The best of London straight to your inbox By entering your email address');
  const b = a.replace(/ /g, '\n  ');
  assert.equal(chromeFingerprint(a), chromeFingerprint(b));
});

test('genuinely different reviews are not grouped', () => {
  const idx = buildChromeFingerprintIndex([
    { showId: 'a', text: pad('A blistering revival that finds the rot under the varnish') },
    { showId: 'b', text: pad('A limp evening that never locates its own pulse anywhere') },
    { showId: 'c', text: pad('Three hours of unbroken delight and one unforgettable song') },
  ]);
  assert.equal(idx.size, 0);
});

// ── the combined predicate ─────────────────────────────────────────────────

test('classifyDeadPage reports which kind fired', () => {
  const parked = classifyDeadPage({ fullText: 'This domain is for sale, contact us.' });
  assert.equal(parked.dead, true);
  assert.equal(parked.kind, 'parked-domain');

  const chrome = pad('WSJ.com is available in the following editions and languages');
  const idx = buildChromeFingerprintIndex([
    { showId: 'a', text: chrome }, { showId: 'b', text: chrome }, { showId: 'c', text: chrome },
  ]);
  const hit = classifyDeadPage({ fullText: chrome }, idx);
  assert.equal(hit.dead, true);
  assert.equal(hit.kind, 'cross-show-chrome');
  assert.match(hit.evidence, /3 different shows/);
});

test('a real review is not dead, with or without an index', () => {
  const review = pad('Simon Stone relocates Chekhov to present-day Seoul and the transplant takes');
  const idx = buildChromeFingerprintIndex([{ showId: 'a', text: review }]);
  assert.equal(classifyDeadPage({ fullText: review }).dead, false);
  assert.equal(classifyDeadPage({ fullText: review }, idx).dead, false);
});

test('a file with no text is not claimed as dead', () => {
  assert.equal(classifyDeadPage({}).dead, false);
  assert.equal(classifyDeadPage({ fullText: '' }).dead, false);
  assert.equal(classifyDeadPage(null).dead, false);
});
