import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { dedupeByReviewKey } = require('./final-key-dedup.js');
const { getReviewKey } = require('./review-list-key.js');

const row = { showId: 's', outletId: 'off-off-online', criticName: 'Marc Miller', url: 'https://x.test/a', publishDate: '2026-10-06' };

test('collapses byte-identical rows (BRO-4809 shape)', () => {
  const { reviews, removed } = dedupeByReviewKey([row, { ...row }]);
  assert.equal(reviews.length, 1);
  assert.equal(removed, 1);
});

test('keeps distinct critics, URLs and shows', () => {
  const input = [row, { ...row, criticName: 'Other' }, { ...row, url: 'https://x.test/b' }, { ...row, showId: 't' }];
  assert.equal(dedupeByReviewKey(input).removed, 0);
});

test('prefers a manual/human copy over a pipeline copy, regardless of order', () => {
  const manual = { ...row, manualEntry: true };
  assert.equal(dedupeByReviewKey([row, manual]).reviews[0].manualEntry, true);
  assert.equal(dedupeByReviewKey([manual, row]).reviews[0].manualEntry, true);
});

test('output has no per-show getReviewKey collisions', () => {
  const { reviews } = dedupeByReviewKey([row, { ...row }, { ...row, criticName: null }, { ...row, criticName: null }]);
  const keys = reviews.map((r) => `${r.showId}|${getReviewKey(r)}`);
  assert.equal(new Set(keys).size, keys.length);
});

// ── BRO-8228: final same-URL pass, the producer twin of validate-data.js's gate ──
const { dedupeBySameUrl, loadSameUrlBaseline } = require('./final-key-dedup.js');
const { sameUrlDuplicateKey } = require('./review-url-collision.js');
const fs = require('fs');
const path = require('path');

// The gate's own test: non-baselined same-URL keys in one show.
function gateViolations(reviews, baseline = new Set()) {
  const seen = new Set();
  const bad = [];
  for (const r of reviews) {
    const k = sameUrlDuplicateKey(r.showId, r.url);
    if (k === null) continue;
    if (seen.has(k) && !baseline.has(k)) bad.push(k);
    seen.add(k);
  }
  return bad;
}

const vulture = 'https://www.vulture.com/2022/10/theater-review-wendell-pierce-death-salesman-broadway.html';
// The three cases that turned "Run data validation" red (BRO-7482, BRO-7775, BRO-8225/8359).
const realCases = [
  [ // 2026-11-26: two named critics, same outlet ("multi-critic" allowance in the rebuild loop)
    { showId: 'death-of-a-salesman-2022', outletId: 'vulture', criticName: 'Greg Evans', url: vulture, contentTier: 'excerpt' },
    { showId: 'death-of-a-salesman-2022', outletId: 'vulture', criticName: 'Rob Weinert-Kendt', url: vulture, contentTier: 'complete' },
  ],
  [ // 2026-11-18
    { showId: 'body-language-regional-2026', outletId: 'broadwayworld', criticName: 'David Friscic', url: 'https://www.broadwayworld.com/washington-dc/article/Review-BODY-LANGUAGE-at-The-Writers-Center-20260928', contentTier: 'complete' },
    { showId: 'body-language-regional-2026', outletId: 'broadwayworld', criticName: 'Richard Sasanow', url: 'https://www.broadwayworld.com/washington-dc/article/Review-BODY-LANGUAGE-at-The-Writers-Center-20260928', contentTier: 'complete' },
  ],
  [ // 2026-11-14: cross-outlet, no bylines
    { showId: 'oliver-west-end-2024', outletId: 'the-sun', criticName: '', url: 'https://www.thetimes.com/culture/theatre-dance/article/oliver-review-consider-yourself-at-home-in-this-warm-revival-tq5v8x8vx', contentTier: 'complete' },
    { showId: 'oliver-west-end-2024', outletId: 'sunday-times', criticName: '', url: 'https://www.thetimes.com/culture/theatre-dance/article/oliver-review-consider-yourself-at-home-in-this-warm-revival-tq5v8x8vx/', contentTier: 'complete' },
  ],
];

test('BRO-8228: every real failing shape trips the gate before, and passes it after', () => {
  for (const pair of realCases) {
    assert.equal(gateViolations(pair).length, 1, `fixture must reproduce the gate failure: ${pair[0].showId}`);
    const { reviews, dropped } = dedupeBySameUrl(pair);
    assert.equal(reviews.length, 1);
    assert.equal(dropped.length, 1);
    assert.deepEqual(gateViolations(reviews), []);
  }
});

test('BRO-8228: keeps the richer row (complete over excerpt), regardless of order', () => {
  const [excerpt, complete] = realCases[0];
  assert.equal(dedupeBySameUrl([excerpt, complete]).reviews[0].criticName, 'Rob Weinert-Kendt');
  assert.equal(dedupeBySameUrl([complete, excerpt]).reviews[0].criticName, 'Rob Weinert-Kendt');
});

test('BRO-8228: manual row beats pipeline row; named critic beats unknown; else first wins', () => {
  const a = { showId: 's', outletId: 'o', criticName: 'A', url: 'https://x.test/a', contentTier: 'complete' };
  const manual = { ...a, criticName: 'M', contentTier: 'excerpt', manualEntry: true };
  assert.equal(dedupeBySameUrl([a, manual]).reviews[0].criticName, 'M');
  const unknown = { ...a, criticName: 'Unknown' };
  assert.equal(dedupeBySameUrl([unknown, a]).reviews[0].criticName, 'A');
  const b = { ...a, criticName: 'B' };
  assert.equal(dedupeBySameUrl([b, a]).reviews[0].criticName, 'B');
});

test('BRO-8228: baselined pairs, other shows, other URLs and url-less rows pass untouched, order kept', () => {
  const p = { showId: 's', outletId: 'o', criticName: 'A', url: 'https://x.test/a' };
  const input = [
    p, { ...p, criticName: 'B' }, // baselined below
    { ...p, showId: 't' }, { ...p, url: 'https://x.test/b' },
    { ...p, url: null, criticName: 'C' }, { ...p, url: null, criticName: 'D' },
  ];
  const baseline = new Set([sameUrlDuplicateKey('s', 'https://x.test/a')]);
  const { reviews, dropped } = dedupeBySameUrl(input, baseline);
  assert.equal(dropped.length, 0);
  assert.deepEqual(reviews, input);
});

test('BRO-8228: the shared baseline loader reads the real baseline file', () => {
  const set = loadSameUrlBaseline();
  assert.ok(set instanceof Set);
  assert.ok(set.size > 0, 'same-url-duplicate-baseline.json should list the known pre-existing pairs');
  assert.equal(loadSameUrlBaseline('/nonexistent/bro-8228.json').size, 0);
});

test('BRO-8228: rebuild runs the same-URL pass AFTER the manual-entry merge, and the gate uses the shared baseline', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'rebuild-all-reviews.js'), 'utf8');
  const merge = src.indexOf('mergeManualEntries(allReviews');
  const pass = src.indexOf('dedupeBySameUrl(allReviews');
  const write = src.indexOf('const output = {\n  _meta:');
  assert.ok(merge > 0 && pass > merge && write > pass, 'dedupeBySameUrl must run after mergeManualEntries and before output is built');
  const vd = fs.readFileSync(path.join(import.meta.dirname, '..', 'validate-data.js'), 'utf8');
  assert.match(vd, /urlDupeBaseline = loadSameUrlBaseline\(\)/);
});

test('BRO-8228 review: rebuilt human-review rows (scoreSource only) beat a richer automated twin', () => {
  const auto = { showId: 's', outletId: 'o', criticName: 'A', url: 'https://x.test/a', contentTier: 'complete', scoreSource: 'llm-ensemble' };
  const human = { ...auto, criticName: 'H', contentTier: 'excerpt', scoreSource: 'human-review' };
  assert.equal(dedupeBySameUrl([auto, human]).reviews[0].criticName, 'H');
});

test('BRO-8228 review: path-case-only URL differences are not deleted (left for the gate)', () => {
  const a = { showId: 's', outletId: 'o', criticName: 'A', url: 'https://x.test/Review-A' };
  const b = { ...a, criticName: 'B', url: 'https://x.test/review-a' };
  assert.equal(dedupeBySameUrl([a, b]).dropped.length, 0);
  // Host case, fragment and trailing slash still collapse.
  const c = { ...a, criticName: 'C', url: 'https://X.TEST/Review-A/#top' };
  assert.equal(dedupeBySameUrl([a, c]).dropped.length, 1);
});

test('BRO-8228 review: the rebuild requires the baseline file to exist before deleting', () => {
  assert.throws(() => loadSameUrlBaseline('/nonexistent/bro-8228.json', { mustExist: true }), /missing/);
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'rebuild-all-reviews.js'), 'utf8');
  assert.match(src, /loadSameUrlBaseline\(undefined, \{ mustExist: true \}\)/);
  assert.match(src, /if \(d\.dropped\.manualEntry === true\) heldManualEntries\.push\(d\.dropped\)/);
});
