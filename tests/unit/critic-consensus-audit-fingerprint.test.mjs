/**
 * BRO-7558: since BRO-6226 the Critics' Take generator stores the fingerprint of
 * its FILTERED inputs (scorer predicate + within-show dedup), while the
 * write-free contamination audit can only rebuild the UNFILTERED view. Comparing
 * the two drifted by 12-27 rows on takes the generator itself judged current
 * (Spies 24 vs 36). The generator now also stores auditReviewCount/auditMeanScore
 * from auditInputFingerprint(), the same call the audit makes.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  loadReviewTexts,
  consensusFingerprint,
  consensusDriftFlags,
  auditInputFingerprint,
} = require('../../scripts/lib/critic-consensus-inputs.js');
const { isScoreable } = require('../../scripts/lib/is-scoreable.js');
const { createWithinShowDedup } = require('../../scripts/lib/within-show-dedup.js');

const SHOW = 'fixture-show-west-end-2026';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

const base = (o) => ({
  showId: SHOW, outlet: 'New York Stage Review', outletId: 'nysr', publishDate: '2026-10-01',
  fullText: 'A full review of the show with plenty of words in it. '.repeat(20), contentTier: 'complete', assignedScore: 75, ...o,
});

describe('BRO-7558: audit compares like with like', () => {
  let root;
  const live = new Set([`${SHOW}|nysr`, `${SHOW}|guardian`]);
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7558-'));
    const dir = path.join(root, SHOW);
    fs.mkdirSync(dir, { recursive: true });
    const files = {
      'nysr--unknown.json': base({ criticName: 'Unknown', url: 'https://nystagereview.com/2026/10/01/other/', contentTier: 'stub', fullText: null, dtliExcerpt: 'Short excerpt.' }),
      'nysr--david-finkle.json': base({ criticName: 'David Finkle', url: 'https://nystagereview.com/2026/10/01/show-review/' }),
      'nysr--david-finkle-2.json': base({ criticName: 'David Finkle', url: 'https://nystagereview.com/2026/10/01/show-review/', duplicateOf: 'nysr--david-finkle.json' }),
      'guardian--a-critic.json': base({ outlet: 'The Guardian', outletId: 'guardian', criticName: 'A Critic', url: 'https://www.theguardian.com/stage/2026/oct/01/show-review', assignedScore: 60 }),
    };
    for (const [f, d] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), JSON.stringify(d));
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('a record the generator just stamped shows no drift, though its filtered count is lower', () => {
    const show = { id: SHOW, title: 'Fixture Show' };
    const filtered = consensusFingerprint(loadReviewTexts(SHOW, live, { reviewTextsDir: root, show, isScoreable, createDedup: createWithinShowDedup }));
    const stamped = { ...filtered, ...auditInputFingerprint(SHOW, live, { reviewTextsDir: root, show }) };
    // What the audit rebuilds:
    const a = auditInputFingerprint(SHOW, live, { reviewTextsDir: root, show });
    const current = { reviewCount: a.auditReviewCount, meanScore: a.auditMeanScore };
    assert.ok(filtered.reviewCount < current.reviewCount, 'precondition: the two views differ on this fixture');
    assert.deepEqual(consensusDriftFlags(stamped, current), []);
  });

  it('drift fires on the stored audit count when the unfiltered set really grows', () => {
    const stored = { reviewCount: 24, meanScore: 80, auditReviewCount: 24, auditMeanScore: 80 };
    assert.match(consensusDriftFlags(stored, { reviewCount: 36, meanScore: 80 }).join(), /REVIEWCOUNT_DRIFT:consensus=24,actual=36/);
  });

  it('the Spies shape (filtered 24, unfiltered 36, generator says current) no longer fails', () => {
    const stored = { reviewCount: 24, meanScore: 86, auditReviewCount: 36, auditMeanScore: 85 };
    assert.deepEqual(consensusDriftFlags(stored, { reviewCount: 36, meanScore: 85 }), []);
  });

  it('a record without the audit fields falls back to the generator count (old behaviour)', () => {
    assert.match(consensusDriftFlags({ reviewCount: 24, meanScore: 80 }, { reviewCount: 36, meanScore: 80 }).join(), /REVIEWCOUNT_DRIFT:consensus=24/);
  });

  it('generator and audit both call auditInputFingerprint (one input view, no hand-kept copy)', () => {
    const gen = fs.readFileSync(path.join(ROOT, 'scripts', 'generate-critic-consensus.js'), 'utf8');
    const audit = fs.readFileSync(path.join(ROOT, 'scripts', 'audit-critic-consensus-contamination.js'), 'utf8');
    // Stamped on a fresh take AND on a "no significant changes" skip.
    assert.equal((gen.match(/auditInputFingerprint\(showId, liveOutlets/g) || []).length, 2);
    assert.match(audit, /auditInputFingerprint\(id, reviewsData\.liveOutlets/);
    assert.doesNotMatch(audit, /consensusFingerprint\(loadReviewTexts/);
  });
});
