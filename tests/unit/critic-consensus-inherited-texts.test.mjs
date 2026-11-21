/**
 * BRO-7539 class guard: a show that CARRIES its earlier run's reviews via
 * priorRuns (same-market transfer / return) shows those rows in reviews.json
 * under its own id, so the Critics' Take generator must read the carried review
 * TEXTS too. It read only data/review-texts/<own id>/, so Pride at the Bridge
 * (25 live rows, 3 unusable own files) logged "only 0 scored reviews" and never
 * got a Take; the opening-night check kept dispatching update-critic-consensus.yml.
 *
 * Fixtures mirror the four shows that hit it. Revert loadReviewTexts' carried
 * branch (critic-consensus-inputs.js) and the carry tests go red.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { loadReviewTexts, consensusFingerprint, shouldRegenerate } = require('../../scripts/lib/critic-consensus-inputs.js');
const { liveOutletKeys, isConsensusEligible } = require('../../scripts/lib/critic-consensus-eligibility.js');
const { createWithinShowDedup } = require('../../scripts/lib/within-show-dedup.js');
const { run: criticsTakePresent } = require('../../scripts/lib/opening-night-checks/critics-take-present.check.js');

// The four shows found with inherited live rows and no Take (2026-11-15).
const CASES = [
  { newer: 'pride-bridge-theatre-off-west-end-2026', older: 'pride-west-end-2026', open: '2026-11-14', run: ['2026-06-25', '2026-09-12'], cat: 'west-end' },
  { newer: 'arcadia-duke-of-yorks-west-end-2026', older: 'arcadia-west-end-2026', open: '2026-05-01', run: ['2026-02-04', '2026-03-21'], cat: 'west-end' },
  { newer: 'going-bacharach-the-songs-of-an-icon-return-off-broadway-2026', older: 'going-bacharach-the-songs-of-an-icon-off-broadway-2026', open: '2026-09-10', run: ['2026-01-12', '2026-02-22'], cat: 'off-broadway' },
  { newer: 'springsteen-on-broadway-2021', older: 'springsteen-on-broadway-2017', open: '2021-06-26', run: ['2017-10-12', '2018-12-15'], cat: 'broadway' },
];

function mkdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bro7539-')); }
function put(root, showId, name, data) {
  const dir = path.join(root, showId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
}
function review(outletId, n, extra = {}) {
  return { outletId, outlet: outletId.toUpperCase(), criticName: `Critic ${n}`, url: `https://${outletId}.example/${n}`, fullText: `Review text ${n}.`, assignedScore: 70 + n, publishDate: null, ...extra };
}

function fixture(c, { ownFiles = {}, dates = null } = {}) {
  const root = mkdir();
  const older = { id: c.older, title: 'T', category: c.cat, status: 'closed', openingDate: c.run[0], closingDate: c.run[1] };
  const newer = {
    id: c.newer, title: 'T', category: c.cat, status: 'open', openingDate: c.open,
    priorRuns: [{ id: c.older, venue: 'V', openingDate: c.run[0], closingDate: c.run[1] }],
  };
  const inWindow = dates || c.run[0].slice(0, 8) + '28';
  ['guardian', 'times', 'telegraph'].forEach((o, i) => put(root, c.older, `${o}--critic.json`, review(o, i + 1, { publishDate: inWindow })));
  for (const [name, d] of Object.entries(ownFiles)) put(root, c.newer, name, d);
  // reviews.json rows the rebuild would write: inherited copies under the newer id.
  const reviewsJson = { reviews: ['guardian', 'times', 'telegraph'].map((o, i) => ({ showId: c.newer, outletId: o, assignedScore: 70 + i, inheritedFromShowId: c.older })) };
  return { root, older, newer, shows: [older, newer], liveOutlets: liveOutletKeys(reviewsJson), reviewsJson };
}

const opts = (f, extra = {}) => ({ reviewTextsDir: f.root, show: f.newer, shows: f.shows, createDedup: createWithinShowDedup, ...extra });

describe('Critics Take reads carried (priorRuns) review texts', () => {
  for (const c of CASES) {
    it(`${c.newer}: texts come from ${c.older}, keyed to the inheriting show`, () => {
      const f = fixture(c, { ownFiles: { 'nonsense--unknown.json': { outletId: 'x', wrongProduction: true, fullText: 'no' } } });
      const rows = loadReviewTexts(c.newer, f.liveOutlets, opts(f));
      assert.equal(rows.length, 3, 'inherited texts are loaded');
      assert.ok(isConsensusEligible(rows.filter(r => r.score != null).length), 'enough for a Take');
      assert.equal(consensusFingerprint(rows).reviewCount, 3, 'fingerprint counts the carried inputs');
    });

    it(`${c.newer}: without opts.shows nothing is carried (own-folder behaviour kept)`, () => {
      const f = fixture(c);
      assert.equal(loadReviewTexts(c.newer, f.liveOutlets, opts(f, { shows: undefined })).length, 0);
    });
  }

  const c = CASES[0];

  it('a carried file is only used when the inheriting show has a live row for that outlet', () => {
    const f = fixture(c);
    const live = new Set([`${c.newer}|guardian`]);
    assert.equal(loadReviewTexts(c.newer, live, opts(f)).length, 1);
  });

  it('own file wins over the carried twin (same URL / outlet+critic): no double count', () => {
    const own = review('guardian', 1, { publishDate: '2026-11-15' });
    const f = fixture(c, { ownFiles: { 'guardian--critic.json': own } });
    const rows = loadReviewTexts(c.newer, f.liveOutlets, opts(f));
    assert.equal(rows.filter(r => r.outlet === 'GUARDIAN').length, 1);
    assert.equal(rows.length, 3);
  });

  it('a review dated outside the declared window is not carried', () => {
    const f = fixture(c, { dates: '2026-11-20' });
    assert.equal(loadReviewTexts(c.newer, f.liveOutlets, opts(f)).length, 0);
  });

  it('inheritReviews:false stops the carry (the rebuild\'s own rule)', () => {
    const f = fixture(c);
    f.newer.priorRuns[0].inheritReviews = false;
    assert.equal(loadReviewTexts(c.newer, f.liveOutlets, opts(f)).length, 0);
  });

  it('an outlet that reviewed the return supersedes its earlier-run text, even with another critic (BRO-4954 rule)', () => {
    const f = fixture(c, { ownFiles: { 'guardian--other.json': review('guardian', 9, { publishDate: '2026-11-16' }) } });
    const rows = loadReviewTexts(c.newer, f.liveOutlets, opts(f));
    assert.equal(rows.filter(r => r.outlet === 'GUARDIAN').length, 1, 'only the current-run Guardian text');
    assert.equal(rows.length, 3);
  });

  it('a sibling file the rebuild would drop (wrongProduction) is not carried', () => {
    const f = fixture(c);
    put(f.root, c.older, 'guardian--critic.json', review('guardian', 1, { publishDate: '2026-06-28', wrongProduction: true }));
    assert.equal(loadReviewTexts(c.newer, f.liveOutlets, opts(f)).length, 2);
  });

  it('closes the loop: the check demands a Take only when the generator can write one', () => {
    const f = fixture(c);
    const rows = loadReviewTexts(c.newer, f.liveOutlets, opts(f));
    const ctx = { reviewsDoc: { [c.newer]: f.reviewsJson.reviews }, criticConsensusDoc: {} };
    const verdict = criticsTakePresent({ id: c.newer, compositeScore: 72 }, ctx);
    // Check says a Take is due (3 live rows) ...
    assert.equal(verdict.ok, false);
    // ... and the generator now has the inputs to satisfy it, so the dispatch converges.
    assert.ok(isConsensusEligible(rows.filter(r => r.score != null).length));
  });
});

describe('wiring: every caller of loadReviewTexts passes the show list', () => {
  const want = {
    'scripts/generate-critic-consensus.js': 'loadReviewTexts(showId, liveOutlets, show, showsData.shows)',
    'scripts/audit-critic-consensus-contamination.js': 'shows: showsById && [...showsById.values()]',
  };
  for (const [file, needle] of Object.entries(want)) {
    it(`${file} passes shows`, () => {
      assert.ok(fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf-8').includes(needle));
    });
  }
});

// Second half of BRO-7539: a transfer's first own reviews replace carried ones
// outlet by outlet, so count, mean and buckets can stay flat. The Take must still
// regenerate when a review of THIS run arrives.
describe('transfer Take regenerates when a review of the new run arrives', () => {
  const carried = (n, score = 90) => ({ score, hasFullText: true, carried: true, outlet: `o${n}` });
  const own = (n, score = 90) => ({ score, hasFullText: true, outlet: `own${n}` });

  it('fingerprint counts only rows from the show\'s own folder', () => {
    const fp = consensusFingerprint([carried(1), carried(2), own(1)]);
    assert.equal(fp.reviewCount, 3);
    assert.equal(fp.ownReviewCount, 1);
  });

  it('one own review replacing a carried one (flat count, mean, buckets) triggers a regenerate', () => {
    const before = [carried(1), carried(2), carried(3), own(0)];
    const stored = { ...consensusFingerprint(before) };
    const after = [carried(1), carried(2), own(1), own(0)]; // same count, same scores
    const r = shouldRegenerate(stored, after);
    assert.equal(r.should, true);
    assert.match(r.reason, /new review\(s\) of this run/);
  });

  it('no change at all does not regenerate; a Take stored before this field existed is left alone', () => {
    const rows = [carried(1), carried(2), own(1)];
    assert.equal(shouldRegenerate(consensusFingerprint(rows), rows).should, false);
    const legacy = consensusFingerprint(rows); delete legacy.ownReviewCount;
    assert.equal(shouldRegenerate(legacy, rows).should, false);
  });

  it('the generator imports the shared decision, it does not keep its own copy', () => {
    const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'scripts', 'generate-critic-consensus.js'), 'utf8');
    assert.match(src, /shouldRegenerate \} from '\.\/lib\/critic-consensus-inputs\.js'/);
    assert.doesNotMatch(src, /function shouldRegenerate/);
  });
});
