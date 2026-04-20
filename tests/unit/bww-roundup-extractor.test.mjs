/**
 * BWW Review Roundup extractor — regression tests against real FA HTML.
 *
 * Fallen Angels opened 2026-04-19. The roundup used BWW's new thumb format
 * (`uptrans2.png`) and had unescaped inner quotes in JSON-LD headlines
 * (`"Cote Notices - "Fallen Angels" on Broadway..."`). Both bugs silently
 * dropped reviews and thumbs from the extractor. See:
 *   memory/project_opening_night_debt.md (FA entry)
 *   scripts/gather-reviews.js:sanitizeBwwJsonLd + thumb regex
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const ROOT = join(import.meta.dirname, '..', '..');
const { extractBWWRoundupReviews, sanitizeBwwJsonLd } = require(join(ROOT, 'scripts/gather-reviews.js'));

// Synthetic fixture: same JSON-LD structure as the real BWW roundup (including
// the unescaped inner-quote bug in Cote Notices, new uptrans2.png/middletrans2.png
// thumb format, and NYSR multi-critic collision) but with articleBody stripped
// to single char so no copyrighted review text ships in the repo. See
// tests/fixtures/opening-night/ (gitignored) for the original live HTML.
const FIXTURE = readFileSync(
  join(ROOT, 'tests/fixtures/bww-roundup/fallen-angels-2026-synthetic.html'),
  'utf8'
);
const FA_URL =
  'https://www.broadwayworld.com/article/Review-Roundup-FALLEN-ANGELS-Starring-Rose-Byrne-Kelli-OHara-Arrives-on-Broadway-20260419';

test('sanitizeBwwJsonLd escapes unescaped inner quotes inside string values', () => {
  const broken = '{"headline":"A - "B" - C","url":"https://x"}';
  const fixed = sanitizeBwwJsonLd(broken);
  const parsed = JSON.parse(fixed);
  assert.strictEqual(parsed.headline, 'A - "B" - C');
  assert.strictEqual(parsed.url, 'https://x');
});

test('sanitizeBwwJsonLd preserves valid JSON unchanged', () => {
  const valid = '{"a":"b","c":["d","e"],"f":{"g":1}}';
  assert.deepStrictEqual(JSON.parse(sanitizeBwwJsonLd(valid)), JSON.parse(valid));
});

test('FA BWW roundup: extracts >=16 reviews (was 14 before sanitizer fix)', () => {
  const reviews = extractBWWRoundupReviews(
    FIXTURE,
    'fallen-angels-2026',
    FA_URL,
    'Fallen Angels'
  );
  assert.ok(
    reviews.length >= 16,
    `Expected >=16 reviews, got ${reviews.length}. Sanitizer or JSON-LD parse likely regressed.`
  );
});

test('FA BWW roundup: every review has a bwwThumb (Up/Meh/Down)', () => {
  const reviews = extractBWWRoundupReviews(
    FIXTURE,
    'fallen-angels-2026',
    FA_URL,
    'Fallen Angels'
  );
  const missing = reviews.filter(r => !['Up', 'Meh', 'Down'].includes(r.bwwThumb));
  assert.strictEqual(
    missing.length,
    0,
    `${missing.length} reviews missing thumb. Thumb regex likely regressed. Offenders: ${missing
      .map(r => `${r.outletId}/${r.criticName}`)
      .join(', ')}`
  );
});

test('FA BWW roundup: NYSR multi-critic entries have distinct URLs (Bernardo vs Sommers)', () => {
  const reviews = extractBWWRoundupReviews(
    FIXTURE,
    'fallen-angels-2026',
    FA_URL,
    'Fallen Angels'
  );
  const nysrs = reviews.filter(r => r.outletId === 'nysr');
  assert.strictEqual(nysrs.length, 2, `Expected 2 NYSR reviews, got ${nysrs.length}`);
  const urls = nysrs.map(r => r.url).filter(Boolean);
  assert.strictEqual(
    new Set(urls).size,
    urls.length,
    `NYSR URL collision detected: ${urls.join(' | ')} — multi-critic URL queue broken.`
  );
});

test('FA BWW roundup: 1 Minute Critic, Cititour, TheWrap are all extracted', () => {
  const reviews = extractBWWRoundupReviews(
    FIXTURE,
    'fallen-angels-2026',
    FA_URL,
    'Fallen Angels'
  );
  const outletIds = reviews.map(r => r.outletId);
  for (const id of ['one-minute-critic', 'cititour', 'thewrap']) {
    assert.ok(
      outletIds.includes(id),
      `Missing outlet ${id} — JSON-LD Method 1 likely failed to parse (pre-sanitizer behavior).`
    );
  }
});
