/**
 * BRO-4869: the contamination audit compares a stored Critics' Take
 * fingerprint against the one a regeneration would write, built from the same
 * review-text inputs. Text-light shows must not drift; genuine drift must.
 */
import { describe, it, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  reviewTextInput,
  loadReviewTexts,
  consensusFingerprint,
  consensusDriftFlags,
  REVIEWCOUNT_DRIFT_THRESHOLD,
  MEANSCORE_DRIFT_THRESHOLD,
} = require('../../scripts/lib/critic-consensus-inputs.js');
const { liveOutletKeys } = require('../../scripts/lib/critic-consensus-eligibility.js');

const SHOW = 'some-show-west-end-2026';

/** Write review-text files for SHOW into a temp root. */
function writeTexts(root, files) {
  const dir = path.join(root, SHOW);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
}

describe('reviewTextInput', () => {
  it('skips flagged files, text-less files and outlets the site does not show', () => {
    const live = new Set([`${SHOW}|guardian`]);
    assert.equal(reviewTextInput({ outletId: 'guardian', fullText: 'x', wrongProduction: true }, SHOW, live), null);
    assert.equal(reviewTextInput({ outletId: 'guardian', assignedScore: 80 }, SHOW, live), null, 'no text');
    assert.equal(reviewTextInput({ outletId: 'telegraph', fullText: 'x', assignedScore: 80 }, SHOW, live), null, 'not live');
    const row = reviewTextInput({ outletId: 'guardian', outlet: 'The Guardian', criticName: 'A', fullText: 'Great.', assignedScore: 80 }, SHOW, live);
    assert.deepEqual({ text: row.text, score: row.score, hasFullText: row.hasFullText }, { text: 'Great.', score: 80, hasFullText: true });
  });

  it('falls back to joined excerpts when there is no fullText', () => {
    const row = reviewTextInput({ outletId: 'o', dtliExcerpt: 'one', bwwExcerpt: 'two', assignedScore: 60 }, SHOW, null);
    assert.equal(row.text, 'one\n\ntwo');
    assert.equal(row.hasFullText, false);
  });
});

describe('consensusFingerprint', () => {
  it('counts every input, means only scored ones, buckets at 61/40', () => {
    const fp = consensusFingerprint([
      { score: 90, hasFullText: true }, { score: 61, hasFullText: true },
      { score: 40 }, { score: 39 }, { score: null, hasFullText: true },
    ]);
    assert.deepEqual(fp, {
      reviewCount: 5,
      fullTextCount: 3,
      meanScore: Math.round((90 + 61 + 40 + 39) / 4),
      bucketBreakdown: { positive: 2, mixed: 1, negative: 1 },
    });
    assert.equal(consensusFingerprint([]).meanScore, null);
  });
});

describe('consensusDriftFlags', () => {
  it('genuine drift still flags: many new inputs, or a moved mean', () => {
    const stored = { reviewCount: 3, meanScore: 85 };
    const flags = consensusDriftFlags(stored, { reviewCount: 3 + REVIEWCOUNT_DRIFT_THRESHOLD, meanScore: 85 });
    assert.equal(flags.length, 1);
    assert.match(flags[0], /^REVIEWCOUNT_DRIFT:consensus=3,actual=13,diff=10$/);

    const meanFlags = consensusDriftFlags({ reviewCount: 20, meanScore: 80 }, { reviewCount: 20, meanScore: 80 - MEANSCORE_DRIFT_THRESHOLD });
    assert.deepEqual(meanFlags, ['MEANSCORE_DRIFT:consensus=80,actual=65,diff=15']);

    // Inputs removed count too (generator's "reviews removed" trigger).
    assert.match(consensusDriftFlags({ reviewCount: 32, meanScore: 70 }, { reviewCount: 18, meanScore: 70 })[0], /^REVIEWCOUNT_DRIFT/);
  });

  it('below the thresholds, or with no mean on either side, is not drift', () => {
    assert.deepEqual(consensusDriftFlags({ reviewCount: 10, meanScore: 70 }, { reviewCount: 19, meanScore: 84 }), []);
    assert.deepEqual(consensusDriftFlags({ reviewCount: 10, meanScore: null }, { reviewCount: 10, meanScore: 20 }), []);
    assert.deepEqual(consensusDriftFlags({ reviewCount: 10, meanScore: 70 }, { reviewCount: 10, meanScore: null }), []);
  });
});

describe('text-light show end to end (glass-kill / grease shape)', () => {
  let root;
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'consensus-inputs-'));
    // 4 reviews with text, 12 star-only rows with no text (WE aggregator stars).
    const files = {};
    for (let i = 0; i < 4; i++) files[`t${i}.json`] = { outletId: `text${i}`, fullText: 'Bold and strange.', assignedScore: 83 };
    for (let i = 0; i < 12; i++) files[`s${i}.json`] = { outletId: `star${i}`, assignedScore: 40 };
    files['failed-fetches.json'] = { not: 'a review' };
    writeTexts(root, files);
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  const reviewsJson = () => ({
    reviews: [
      ...[0, 1, 2, 3].map(i => ({ showId: SHOW, outletId: `text${i}`, assignedScore: 83 })),
      ...Array.from({ length: 12 }, (_, i) => ({ showId: SHOW, outletId: `star${i}`, assignedScore: 40 })),
    ],
  });

  it('the stored take matches what the generator would write today: no drift', () => {
    const live = liveOutletKeys(reviewsJson());
    const current = consensusFingerprint(loadReviewTexts(SHOW, live, { reviewTextsDir: root }));
    assert.equal(current.reviewCount, 4);
    assert.equal(current.meanScore, 83);
    // What the generator stored for this show (critic-consensus.json shape).
    const stored = { reviewCount: 4, fullTextCount: 4, meanScore: 83 };
    assert.deepEqual(consensusDriftFlags(stored, current), []);
  });

  it('a take written before 10+ texts arrived still flags', () => {
    const extra = {};
    for (let i = 0; i < 10; i++) extra[`late${i}.json`] = { outletId: `late${i}`, fullText: 'Late review.', assignedScore: 80 };
    writeTexts(root, extra);
    const json = reviewsJson();
    for (let i = 0; i < 10; i++) json.reviews.push({ showId: SHOW, outletId: `late${i}`, assignedScore: 80 });
    const current = consensusFingerprint(loadReviewTexts(SHOW, liveOutletKeys(json), { reviewTextsDir: root }));
    assert.equal(current.reviewCount, 14);
    assert.match(consensusDriftFlags({ reviewCount: 4, meanScore: 83 }, current).join(), /REVIEWCOUNT_DRIFT:consensus=4,actual=14/);
  });

  it('a missing show directory reads as zero inputs', () => {
    assert.deepEqual(loadReviewTexts('no-such-show', null, { reviewTextsDir: root }), []);
  });
});

describe('generator and audit share the module', () => {
  it('both import critic-consensus-inputs and the generator stores its fingerprint', () => {
    const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
    const gen = fs.readFileSync(path.join(root, 'scripts', 'generate-critic-consensus.js'), 'utf8');
    const audit = fs.readFileSync(path.join(root, 'scripts', 'audit-critic-consensus-contamination.js'), 'utf8');
    assert.match(gen, /consensusFingerprint\(reviews\)/);
    assert.match(gen, /\.\.\.fingerprint/);
    assert.match(audit, /require\('\.\/lib\/critic-consensus-inputs'\)/);
    assert.match(audit, /consensusDriftFlags\(c, current\)/);
  });
});

test('alias outlets match only through an injected normalizer (the audit stays write-free)', () => {
  const live = new Set(['s|metro-uk']);
  const row = { outletId: 'metro', fullText: 'x', assignedScore: 80 };
  assert.equal(reviewTextInput(row, 's', live), null);
  assert.ok(reviewTextInput(row, 's', live, (n) => (n === 'metro' ? 'metro-uk' : n)));
});

test('critic-consensus-inputs does not require review-normalization (safe-form allowlist graph)', () => {
  const src = fs.readFileSync(new URL('../../scripts/lib/critic-consensus-inputs.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /require\(['"]\.\/review-normalization['"]\)/);
});

describe('BRO-6226: inputs use the scorer predicate and the rebuild within-show dedup', () => {
  let root;
  before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro6226-')); });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  const base = (o) => ({
    showId: SHOW, outlet: 'New York Stage Review', outletId: 'nysr', publishDate: '2026-10-01',
    fullText: 'A full review of the show with plenty of words in it. '.repeat(20), contentTier: 'complete', assignedScore: 75, ...o,
  });

  it('drops an unknown-critic stub beside the named critic, and a duplicateOf twin', () => {
    writeTexts(root, {
      'nysr--unknown.json': base({ criticName: 'Unknown', url: 'https://nystagereview.com/2026/10/01/other-slug/', contentTier: 'stub', fullText: null, dtliExcerpt: 'Short excerpt.' }),
      'nysr--david-finkle.json': base({ criticName: 'David Finkle', url: 'https://nystagereview.com/2026/10/01/show-review/' }),
      'nysr--david-finkle-2.json': base({ criticName: 'David Finkle', url: 'https://nystagereview.com/2026/10/01/show-review/', duplicateOf: 'nysr--david-finkle.json' }),
      'guardian--a-critic.json': base({ outlet: 'The Guardian', outletId: 'guardian', criticName: 'A Critic', url: 'https://www.theguardian.com/stage/2026/oct/01/show-review', assignedScore: 60 }),
    });
    const live = new Set([`${SHOW}|nysr`, `${SHOW}|guardian`]);
    const { isScoreable } = require('../../scripts/lib/is-scoreable.js');
    const { createWithinShowDedup } = require('../../scripts/lib/within-show-dedup.js');
    const rows = loadReviewTexts(SHOW, live, { reviewTextsDir: root, show: { id: SHOW, title: 'Some Show' }, isScoreable, createDedup: createWithinShowDedup });
    assert.deepEqual(rows.map(r => r.critic).sort(), ['A Critic', 'David Finkle']);
    assert.equal(consensusFingerprint(rows).reviewCount, 2);
    // Without the injected predicate/dedup (the write-free audit) the stub still counts.
    assert.equal(loadReviewTexts(SHOW, live, { reviewTextsDir: root }).length, 3);
  });

  it('reviewTextInput runs the scorer predicate (isScoreable) when given a filePath', () => {
    const isScoreableMod = require('../../scripts/lib/is-scoreable.js');
    const data = base({ criticName: 'X', url: 'https://nystagereview.com/x/', incompleteReason: 'scraper_garbage' });
    const filePath = path.join(root, SHOW, 'nysr--x.json');
    assert.equal(isScoreableMod.isScoreable(data, undefined, filePath), false, 'precondition: the scorer drops it');
    assert.equal(reviewTextInput(data, SHOW, null, null, { filePath, isScoreable: isScoreableMod.isScoreable }), null);
    assert.notEqual(reviewTextInput(data, SHOW, null, null), null, 'without a path only the flag subset applies');
  });

  it('a row that emits no input (outlet not live) still registers, so a same-URL twin stays a duplicate', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro6226-notlive-'));
    try {
      const url = 'https://nystagereview.com/2026/10/01/show-review/';
      writeTexts(dir, {
        // Sorted first; includable, but its outlet has no live row, so no input.
        'aaa--david-finkle.json': base({ outletId: 'aaa', outlet: 'Old Outlet', criticName: 'David Finkle', url }),
        // Same review filed again under a live outlet: the rebuild drops it by URL.
        'nysr--david-finkle.json': base({ criticName: 'David Finkle', url }),
      });
      const live = new Set([`${SHOW}|nysr`]);
      const { isScoreable } = require('../../scripts/lib/is-scoreable.js');
      const { createWithinShowDedup } = require('../../scripts/lib/within-show-dedup.js');
      const rows = loadReviewTexts(SHOW, live, { reviewTextsDir: dir, show: { id: SHOW, title: 'Some Show' }, isScoreable, createDedup: createWithinShowDedup });
      assert.equal(rows.length, 0, 'the twin must not slip in because the first copy emitted no input');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('West End excerpt fields the scorer accepts reach the inputs (shared EXCERPT_FIELDS)', () => {
    const row = reviewTextInput(base({ criticName: 'X', fullText: null, contentTier: 'excerpt', stagedoorExcerpt: 'A strong, moving revival.' }), SHOW);
    assert.ok(row && /moving revival/.test(row.text));
  });

  it('file order matches the shared dedup order (no drift between the two copies)', () => {
    const { namedBeforeUnknown } = require('../../scripts/lib/critic-consensus-inputs.js');
    const shared = require('../../scripts/lib/within-show-dedup.js').namedBeforeUnknown;
    const files = ['nysr--unknown.json', 'a--zed.json', 'b--unnamed.json', 'a--amy.json', 'c--unknown-2.json', 'b--bob.json'];
    assert.deepEqual([...files].sort(namedBeforeUnknown), [...files].sort(shared));
  });
});
