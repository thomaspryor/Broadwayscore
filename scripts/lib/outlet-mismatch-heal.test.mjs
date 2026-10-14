/**
 * outlet-mismatch-heal.test.mjs — rebuild-all-reviews.js's stale
 * outlet-mismatch pass (URL-edition rewrite, guarded rename, flagged-tombstone
 * deletion, converging dry-run).
 *
 * Run: node --test scripts/lib/outlet-mismatch-heal.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const {
  urlEditionCorrection,
  publisherDomainCorrection,
  sameArticlePath,
  applyUrlEditionCorrection,
  sameReviewUrl,
  carriesOperatorAssertion,
  flaggedTombstoneDecision,
  runOutletMismatchCleanup,
} = require_('./outlet-mismatch-heal.js');

const LONDON = 'https://www.timeout.com/london/theatre/my-neighbour-totoro-review';
const NEWYORK = 'https://www.timeout.com/newyork/theater/just-in-time-review';

// ── urlEditionCorrection ────────────────────────────────────────────────────

test('urlEditionCorrection: /london URL on a "timeout" file -> timeout-london', () => {
  const fix = urlEditionCorrection({ outletId: 'timeout', outlet: 'Time Out', url: LONDON });
  assert.equal(fix.outletId, 'timeout-london');
  assert.equal(fix.outlet, 'Time Out London');
  assert.equal(fix.from, 'timeout');
});

test('urlEditionCorrection: timeout.com/newyork URL filed as nytimes (T1) -> timeout', () => {
  assert.equal(urlEditionCorrection({ outletId: 'nytimes', url: NEWYORK }).outletId, 'timeout');
});

test('urlEditionCorrection: null when the edition agrees, off-host, another city edition, no url, or _locked', () => {
  assert.equal(urlEditionCorrection({ outletId: 'timeout-london', url: LONDON }), null);
  assert.equal(urlEditionCorrection({ outletId: 'timeout', url: NEWYORK }), null);
  // Only declared path-split hosts: an ordinary cross-domain disagreement is NOT rewritten here.
  assert.equal(urlEditionCorrection({ outletId: 'observer', url: 'https://www.theguardian.com/stage/x' }), null);
  assert.equal(urlEditionCorrection({ outletId: 'sunday-telegraph', url: 'https://www.telegraph.co.uk/theatre/x' }), null);
  // Time Out Chicago is neither registered edition: never promoted to T1 "timeout".
  assert.equal(urlEditionCorrection({ outletId: 'time-out-chicago', url: 'https://www.timeout.com/chicago/theater/x' }), null);
  assert.equal(urlEditionCorrection({ outletId: 'timeout' }), null);
  assert.equal(urlEditionCorrection({ outletId: 'timeout', url: LONDON, _locked: true }), null);
});

test('applyUrlEditionCorrection: rewrites outletId AND outlet, stamps a breadcrumb', () => {
  const d = { outletId: 'timeout', outlet: 'Time Out', url: LONDON };
  applyUrlEditionCorrection(d, '2026-09-29');
  assert.equal(d.outletId, 'timeout-london');
  assert.equal(d.outlet, 'Time Out London');
  assert.equal(d.outletIdCorrectedFrom, 'timeout');
  assert.match(d.outletIdCorrectedReason, /^url-edition: .* resolves to timeout-london \(2026-09-29\)$/);
});

// ── helpers ─────────────────────────────────────────────────────────────────

test('sameReviewUrl: ignores scheme, www, trailing slash; distinct paths differ', () => {
  assert.ok(sameReviewUrl('http://www.timeout.com/london/theatre/x/', 'https://timeout.com/london/theatre/x'));
  assert.ok(!sameReviewUrl('https://timeout.com/london/theatre/x', 'https://timeout.com/london/theatre/y'));
  assert.ok(!sameReviewUrl(null, null));
});

test('carriesOperatorAssertion: every human/operator marker keeps the file', () => {
  assert.equal(carriesOperatorAssertion({ wrongProduction: true, wrongProductionNote: 'Pre-opening guard: x' }), false);
  for (const d of [
    { wrongProductionManualClear: true },
    { wrongShowOverride: true },
    { someNewThingManualClear: true },
    { humanReviewScore: 70 },
    { humanReviewedWrongProduction: true },
    { manualContentTier: 'complete' },
    { _locked: true },
    { wrongProductionReason: 'manual-audit 2026-09-01' },
    { rejectionReason: 'human: not a review' },
    { wrongShowNote: 'audit-we-market-misroutes: moved' },
    { rejectedBy: ['human-review'] },
    { wrongProductionProvenance: 'manual' },
  ]) {
    assert.equal(carriesOperatorAssertion(d), true, JSON.stringify(d));
  }
});

// ── flaggedTombstoneDecision ────────────────────────────────────────────────

const flagged = (extra = {}) => ({ outletId: 'timeout-london', url: LONDON, wrongProduction: true, wrongProductionNote: 'Pre-opening guard: pre-window', ...extra });
// Stand-in for explainExclusion bound to a show dir: excluded iff flagged.
const explain = (d) => (d && d.wrongProduction === true ? 'wrongProduction' : null);
const base = (over = {}) => ({
  source: flagged(),
  target: flagged(),
  sourceFile: 'timeout--a.json',
  targetFile: 'timeout-london--a.json',
  siblings: [],
  explain,
  ...over,
});
const reasonFor = (over) => flaggedTombstoneDecision(base(over)).reason;

test('flaggedTombstoneDecision: deletes a same-URL excluded tombstone of an excluded target', () => {
  const d = flaggedTombstoneDecision(base());
  assert.equal(d.delete, true);
  assert.deepEqual(d.repoint, []);
  assert.deepEqual(d.transfer, {});
});

test('flaggedTombstoneDecision: keeps for each unmet condition', () => {
  assert.equal(reasonFor({ target: { outletId: 'timeout-london', url: LONDON } }), 'target-not-excluded');
  // "Excluded today" is explainExclusion's answer, not the raw flag.
  assert.equal(reasonFor({ explain: (d, f) => (f === 'timeout-london--a.json' ? null : 'wrongProduction') }), 'target-not-excluded');
  assert.equal(reasonFor({ target: flagged({ url: LONDON + '-2' }) }), 'different-url');
  assert.equal(reasonFor({ explain: (d, f) => (f === 'timeout--a.json' ? null : 'wrongProduction') }), 'source-not-excluded');
  assert.equal(reasonFor({ source: flagged({ humanReviewScore: 60 }) }), 'source-operator-assertion');
  assert.equal(reasonFor({ source: flagged({ fullText: 'A unique body.' }), target: flagged({ fullText: 'Different.' }) }), 'source-unique-fulltext');
  assert.equal(reasonFor({ siblings: [{ file: 'timeout-london--a.json', data: flagged({ duplicateOf: 'timeout--a.json' }) }] }), 'target-points-at-source');
  // Moving the source's unique fields must not un-exclude the target.
  assert.equal(reasonFor({
    source: flagged({ urlDiscoveredAt: '2026-01-01' }),
    explain: (d, f) => (f === 'timeout-london--a.json' && d.urlDiscoveredAt ? null : 'wrongProduction'),
  }), 'merge-would-include-target');
});

test('flaggedTombstoneDecision: identical fullText is fine; only provenance is handed over', () => {
  const d = flaggedTombstoneDecision(base({
    source: flagged({ fullText: 'Same  body.', urlDiscoveredAt: '2026-01-01', urlDiscoveryMethod: 'serp', serpRetryCount: 2, wrongShowReason: 'x' }),
    target: flagged({ fullText: 'Same body.' }),
  }));
  assert.equal(d.delete, true);
  assert.deepEqual(d.transfer, { urlDiscoveredAt: '2026-01-01', urlDiscoveryMethod: 'serp' });
});

test('flaggedTombstoneDecision: score/excerpt data the target lacks keeps the tombstone (never transferred)', () => {
  for (const extra of [
    { llmScore: { score: 70 } }, { ensembleData: {} }, { assignedScore: 70 }, { adjudicatedScore: 70 },
    { originalScore: '4/5' }, { aggregatorStars: '4/5' }, { aggregatorStarsNormalized: 80 },
    { westEndTheatreExcerpt: 'q' }, { dtliExcerpt: 'q' }, { excerpt: 'q' }, { bwwThumb: 'up' }, { dtliThumb: 'up' },
  ]) {
    assert.equal(reasonFor({ source: flagged(extra) }), 'source-has-unique-score-data', JSON.stringify(extra));
  }
  // The same data already on the target is not unique: delete proceeds, nothing moves.
  const d = flaggedTombstoneDecision(base({ source: flagged({ aggregatorStars: '4/5' }), target: flagged({ aggregatorStars: '3/5' }) }));
  assert.equal(d.delete, true);
  assert.deepEqual(d.transfer, {});
});

test('flaggedTombstoneDecision: other siblings pointing at the source are returned for repointing', () => {
  const sib = { file: 'other--b.json', data: { duplicateOf: 'timeout--a.json' } };
  const d = flaggedTombstoneDecision(base({ siblings: [sib, { file: 'x--c.json', data: {} }] }));
  assert.equal(d.delete, true);
  assert.deepEqual(d.repoint.map(s => s.file), ['other--b.json']);
});

// ── runOutletMismatchCleanup on a real directory ────────────────────────────

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'outlet-mismatch-heal-'));
  const dir = path.join(root, 'show-a');
  fs.mkdirSync(dir);
  for (const [f, d] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), JSON.stringify(d, null, 2));
  const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const exists = (f) => fs.existsSync(path.join(dir, f));
  const snapshot = () => fs.readdirSync(dir).sort().map(f => [f, fs.readFileSync(path.join(dir, f), 'utf8')]);
  return { root, dir, read, exists, snapshot, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
// Fixtures have no shows.json record, so the real explainExclusion would call
// every file excluded ('no show'); inject the same flag-based stand-in.
const run = (root, opts = {}) => runOutletMismatchCleanup({ reviewTextsDir: root, showDirs: ['show-a'], showById: {}, log: () => {}, explainFn: explain, ...opts });

test('runOutletMismatchCleanup: edition rewrite then rename (JSON first, so it sticks)', () => {
  const fx = fixture({ 'timeout--andrzej-lukowski.json': { showId: 'show-a', outletId: 'timeout', outlet: 'Time Out', criticName: 'Andrzej Lukowski', url: LONDON } });
  try {
    const r = run(fx.root);
    assert.equal(r.editionFixedCount, 1);
    assert.equal(r.renamedCount, 1);
    assert.ok(!fx.exists('timeout--andrzej-lukowski.json'));
    const d = fx.read('timeout-london--andrzej-lukowski.json');
    assert.equal(d.outletId, 'timeout-london');
    assert.equal(d.outlet, 'Time Out London');
    // Idempotent: a second pass changes nothing.
    const again = run(fx.root);
    assert.equal(again.editionFixedCount + again.renamedCount + again.tombstoneDeletedCount, 0);
  } finally { fx.cleanup(); }
});

test('runOutletMismatchCleanup: a rename repoints sibling pointers (the-cherry-orchard-2016 broken_duplicate_ref shape)', () => {
  const OLD = 'https://www.timeout.com/newyork/blog/cherry-orchard-review';
  const fx = fixture({
    'the-answer-is--cherry-orchard.json': { showId: 'show-a', outletId: 'the-answer-is', outlet: 'the-answer-is', criticName: 'Cherry Orchard', url: OLD, rejectionReason: 'garbage_outlet' },
    'timeout--david-cote.json': { showId: 'show-a', outletId: 'timeout', criticName: 'David Cote', url: OLD, duplicateTextOf: 'the-answer-is--cherry-orchard.json' },
  });
  try {
    const r = run(fx.root);
    assert.equal(r.renamedCount, 1);
    assert.ok(fx.exists('timeout--cherry-orchard.json'));
    assert.equal(fx.read('timeout--david-cote.json').duplicateTextOf, 'timeout--cherry-orchard.json');
  } finally { fx.cleanup(); }
});

test('runOutletMismatchCleanup: deletes a flagged same-URL tombstone, moves its provenance, repoints siblings', () => {
  const fx = fixture({
    'timeout--andrzej-lukowski.json': { showId: 'show-a', criticName: 'Andrzej Lukowski', ...flagged({ urlDiscoveredAt: '2026-01-01' }) },
    'timeout-london--andrzej-lukowski.json': { showId: 'show-a', criticName: 'Andrzej Lukowski', ...flagged() },
    // Same URL (a pointer only ever joins same-URL files; the write guard
    // self-heals a duplicateOf whose target URL differs).
    'timeout-london--unknown.json': { showId: 'show-a', outletId: 'timeout-london', criticName: 'Unknown', url: LONDON, duplicateOf: 'timeout--andrzej-lukowski.json' },
  });
  try {
    const r = run(fx.root);
    assert.equal(r.tombstoneDeletedCount, 1);
    assert.ok(!fx.exists('timeout--andrzej-lukowski.json'));
    assert.equal(fx.read('timeout-london--andrzej-lukowski.json').urlDiscoveredAt, '2026-01-01');
    assert.equal(fx.read('timeout-london--unknown.json').duplicateOf, 'timeout-london--andrzej-lukowski.json');
  } finally { fx.cleanup(); }
});

test('runOutletMismatchCleanup: keeps a flagged tombstone whose target is live, or whose text is unique', () => {
  const fx = fixture({
    'timeout--andrzej-lukowski.json': { showId: 'show-a', criticName: 'Andrzej Lukowski', ...flagged() },
    'timeout-london--andrzej-lukowski.json': { showId: 'show-a', outletId: 'timeout-london', criticName: 'Andrzej Lukowski', url: LONDON },
    'timeout--jane-doe.json': { showId: 'show-a', criticName: 'Jane Doe', ...flagged({ fullText: 'only here' }) },
    'timeout-london--jane-doe.json': { showId: 'show-a', criticName: 'Jane Doe', ...flagged() },
  });
  try {
    const r = run(fx.root);
    assert.equal(r.tombstoneDeletedCount, 0);
    assert.deepEqual(Object.keys(r.kept).sort(), ['source-unique-fulltext', 'target-not-excluded']);
    assert.ok(fx.exists('timeout--andrzej-lukowski.json'));
    assert.ok(fx.exists('timeout--jane-doe.json'));
    assert.equal(fx.read('timeout-london--andrzej-lukowski.json').wrongProduction, undefined);
  } finally { fx.cleanup(); }
});

test('runOutletMismatchCleanup: dry-run touches nothing and its plan equals the apply', () => {
  const OLD = 'https://www.timeout.com/newyork/blog/c';
  const files = {
    // Rename chain the plan must follow: edition fix -> rename -> sibling repoint.
    'the-answer-is--c.json': { showId: 'show-a', outletId: 'the-answer-is', criticName: 'C', url: OLD, rejectionReason: 'garbage' },
    'timeout--d.json': { showId: 'show-a', outletId: 'timeout', criticName: 'D', url: OLD, duplicateTextOf: 'the-answer-is--c.json' },
    'timeout--x.json': { showId: 'show-a', outletId: 'timeout', outlet: 'Time Out', criticName: 'X', url: LONDON },
    'timeout--andrzej-lukowski.json': { showId: 'show-a', criticName: 'Andrzej Lukowski', ...flagged() },
    'timeout-london--andrzej-lukowski.json': { showId: 'show-a', criticName: 'Andrzej Lukowski', ...flagged() },
  };
  const fx = fixture(files);
  try {
    const before = fx.snapshot();
    const dry = run(fx.root, { dryRun: true });
    assert.deepEqual(fx.snapshot(), before);
    const applied = run(fx.root);
    assert.deepEqual(dry.actions, applied.actions);
    assert.equal(dry.errorCount + applied.errorCount, 0);
    // And a dry-run after the apply plans nothing.
    assert.deepEqual(run(fx.root, { dryRun: true }).actions, []);
  } finally { fx.cleanup(); }
});

test('runOutletMismatchCleanup: a _locked file refusing its rename is counted, not an error', () => {
  const fx = fixture({
    'time--jane-doe.json': { showId: 'show-a', outletId: 'guardian', criticName: 'Jane Doe', url: 'https://www.theguardian.com/stage/x', _locked: true },
  });
  try {
    const r = run(fx.root);
    assert.equal(r.skippedLockedCount, 1);
    assert.equal(r.errorCount, 0);
    assert.deepEqual(r.kept.locked, ['show-a/time--jane-doe.json']);
    assert.ok(fx.exists('time--jane-doe.json'));
  } finally { fx.cleanup(); }
});

// ── publisherDomainCorrection (BRO-4402) ────────────────────────────────────

const NYT = 'http://theater.nytimes.com/2009/03/10/theater/reviews/10thir.html';

test('publisherDomainCorrection: nytimes URL on about-entertainment -> nytimes', () => {
  const fix = publisherDomainCorrection({ outletId: 'about-entertainment', criticName: 'Ben Brantley', url: NYT });
  assert.equal(fix.outletId, 'nytimes');
  assert.equal(fix.from, 'about-entertainment');
  const d = { outletId: 'about-entertainment', outlet: 'About Entertainment', criticName: 'Ben Brantley', url: NYT };
  applyUrlEditionCorrection(d, '2026-09-30');
  assert.equal(d.outletId, 'nytimes');
  assert.match(d.outletIdCorrectedReason, /^publisher-domain:/);
});

test('publisherDomainCorrection: observer on theguardian.com is NOT corrected (sister paper)', () => {
  assert.equal(publisherDomainCorrection({ outletId: 'observer', criticName: 'Kate Kellaway', url: 'https://www.theguardian.com/stage/2019/jun/16/x' }), null);
});

test('publisherDomainCorrection: archive host, own domain, _locked, roundup/wrongShow, rejected, duplicate untouched', () => {
  const base = { outletId: 'about-entertainment', criticName: 'Ben Brantley', url: NYT };
  assert.equal(publisherDomainCorrection({ ...base, _locked: true }), null);
  assert.equal(publisherDomainCorrection({ ...base, wrongShow: true }), null);
  assert.equal(publisherDomainCorrection({ ...base, wrongProduction: true }), null);
  assert.equal(publisherDomainCorrection({ ...base, isRoundupArticle: true }), null);
  assert.equal(publisherDomainCorrection({ ...base, rejectedAt: '2026-01-01' }), null);
  assert.equal(publisherDomainCorrection({ ...base, duplicateOf: 'nytimes--ben-brantley.json' }), null);
  assert.equal(publisherDomainCorrection({ ...base, humanReviewScore: 80 }), null);
  assert.equal(publisherDomainCorrection({ outletId: 'denver-post', criticName: 'X', url: 'https://www.jasonraize.net/pr_tlk_dp020898.html' }), null);
  assert.equal(publisherDomainCorrection({ outletId: 'nytimes', criticName: 'X', url: 'https://www.nytimes.com/a' }), null);
  assert.equal(publisherDomainCorrection({ outletId: 'sunday-telegraph', criticName: 'X', url: 'https://www.telegraph.co.uk/a' }), null);
});

test('publisherDomainCorrection: a critic established at the current outlet keeps the label (URL is the wrong field)', () => {
  // Robert Feldberg is a North Jersey critic: variety.com URL is a bad URL, not a bad outlet.
  assert.equal(publisherDomainCorrection({ outletId: 'northjerseycom', criticName: 'Robert Feldberg', url: 'https://variety.com/2015/legit/reviews/x/' }), null);
});

test('runOutletMismatchCleanup: publisher-domain relabel renames; excluded stub at the target is replaced, not merged over', () => {
  const live = { showId: 'show-a', outletId: 'about-entertainment', outlet: 'About Entertainment', criticName: 'Ben Brantley', url: NYT, fullText: 'A full review text. '.repeat(30), contentTier: 'complete' };
  const fx = fixture({ 'about-entertainment--ben-brantley.json': live });
  try {
    const r = run(fx.root);
    assert.equal(r.errorCount, 0);
    assert.ok(!fx.exists('about-entertainment--ben-brantley.json'));
    assert.equal(fx.read('nytimes--ben-brantley.json').outletId, 'nytimes');
    assert.deepEqual(run(fx.root, { dryRun: true }).actions, []);
  } finally { fx.cleanup(); }
  const fx2 = fixture({
    'about-entertainment--ben-brantley.json': live,
    'nytimes--ben-brantley.json': { ...live, outletId: 'nytimes', outlet: 'The New York Times', url: 'https://www.nytimes.com/2009/03/10/theater/reviews/10thir.html', fullText: 'garbage', wrongProduction: true },
  });
  try {
    const r = run(fx2.root);
    assert.equal(r.errorCount, 0);
    assert.ok(!fx2.exists('about-entertainment--ben-brantley.json'));
    const t = fx2.read('nytimes--ben-brantley.json');
    assert.equal(t.wrongProduction, undefined);
    assert.match(t.fullText, /^A full review/);
  } finally { fx2.cleanup(); }
});

test('sameArticlePath: same publisher + path across host prefixes only', () => {
  assert.equal(sameArticlePath(NYT, 'https://www.nytimes.com/2009/03/10/theater/reviews/10thir.html?ref=x'), true);
  assert.equal(sameArticlePath('https://www.express.co.uk/a', 'https://www.dailymail.co.uk/a'), false);
  assert.equal(sameArticlePath('https://www.nytimes.com/', 'https://www.nytimes.com/'), false);
});

// ── BRO-4411: publisher-domain misfile that is a duplicateOf an EXCLUDED file ─

const excl = (d) => (d && (d.duplicateOf ? 'duplicateOf' : d.isSyndicatedDuplicate ? 'isSyndicatedDuplicate' : d.wrongAttribution ? 'wrongAttribution' : d.wrongProduction ? 'wrongProduction' : null)) || null;
const NYT_WWW = 'https://www.nytimes.com/2009/03/10/theater/reviews/10thir.html';
const misfile = (extra = {}) => ({ showId: 'show-a', outletId: 'about-entertainment', outlet: 'About Entertainment', criticName: 'Ben Brantley', url: NYT, assignedScore: 71, duplicateOf: 'nytimes--ben-brantley.json', duplicateReason: 'outlet-mismatch: ...', ...extra });
const nytFile = (extra = {}) => ({ showId: 'show-a', outletId: 'nytimes', outlet: 'The New York Times', criticName: 'Ben Brantley', url: NYT_WWW, assignedScore: 78, fullText: 'The full NYT review text. '.repeat(20), isSyndicatedDuplicate: true, syndicatedPrimaryFile: 'show-a/about-entertainment--ben-brantley.json', syndicationSimilarity: 95, ...extra });

test('publisherDomainCorrection: duplicateOf stays untouched by default, corrected only with ignoreDuplicateOf', () => {
  const d = misfile();
  assert.equal(publisherDomainCorrection(d), null);
  assert.equal(publisherDomainCorrection(d, { ignoreDuplicateOf: true }).outletId, 'nytimes');
  assert.equal(publisherDomainCorrection({ ...d, duplicateTextOf: 'x.json' }, { ignoreDuplicateOf: true }), null);
});

test('runOutletMismatchCleanup: misfile duplicateOf an excluded nytimes file (syndication cycle) collapses to ONE live nytimes row', () => {
  const fx = fixture({ 'about-entertainment--ben-brantley.json': misfile(), 'nytimes--ben-brantley.json': nytFile() });
  try {
    const r = run(fx.root, { explainFn: excl });
    assert.equal(r.errorCount, 0);
    assert.ok(!fx.exists('about-entertainment--ben-brantley.json'), 'misfile removed: no double count');
    const t = fx.read('nytimes--ben-brantley.json');
    assert.equal(t.isSyndicatedDuplicate, false);
    assert.equal(t.syndicatedPrimaryFile, null);
    assert.equal(t.assignedScore, 78, 'target text/score kept');
    assert.match(t.fullText, /^The full NYT review/);
    assert.equal(excl(t), null, 'target now scores');
    assert.deepEqual(run(fx.root, { explainFn: excl, dryRun: true }).actions, [], 'converged');
  } finally { fx.cleanup(); }
});

test('runOutletMismatchCleanup: pointer at a file excluded for its OWN reason is left alone when it is not the corrected file', () => {
  const fx = fixture({
    'about-entertainment--ben-brantley.json': misfile({ duplicateOf: 'nytimes--charles-isherwood.json' }),
    'nytimes--charles-isherwood.json': nytFile({ criticName: 'Charles Isherwood', isSyndicatedDuplicate: undefined, syndicatedPrimaryFile: undefined, wrongAttribution: true }),
  });
  try {
    const r = run(fx.root, { explainFn: excl });
    assert.equal(r.errorCount, 0);
    assert.ok(fx.exists('nytimes--ben-brantley.json'), 'renamed to the correct outlet');
    assert.equal(fx.read('nytimes--ben-brantley.json').duplicateOf, undefined);
    assert.equal(fx.read('nytimes--charles-isherwood.json').wrongAttribution, true, 'wrongAttribution file untouched');
  } finally { fx.cleanup(); }
});

test('runOutletMismatchCleanup: nothing happens when the duplicateOf target scores, is wrongShow, or operator-asserted', () => {
  for (const tgt of [nytFile({ isSyndicatedDuplicate: undefined }), nytFile({ wrongShow: true }), nytFile({ humanReviewScore: 80 })]) {
    const fx = fixture({ 'about-entertainment--ben-brantley.json': misfile(), 'nytimes--ben-brantley.json': tgt });
    try {
      const before = fx.snapshot();
      run(fx.root, { explainFn: excl });
      assert.deepEqual(fx.snapshot(), before);
    } finally { fx.cleanup(); }
  }
});

test('runOutletMismatchCleanup: twin (stale rejection on the misfile, live same-article nytimes file) keeps ONE row', () => {
  const stale = misfile({ duplicateOf: undefined, duplicateReason: undefined, rejectedAt: '2026-07-11T00:00:00Z', rejectedBy: 'ensemble-scoreability-check', fullText: 'The full NYT review text. '.repeat(20) });
  const live = nytFile({ isSyndicatedDuplicate: undefined, syndicatedPrimaryFile: undefined, syndicationSimilarity: undefined });
  // explain: rejection markers alone do not exclude (stale-flag exception); mimic explainExclusion.
  const ex = (d) => (d && (d.duplicateOf ? 'duplicateOf' : d.isSyndicatedDuplicate ? 'isSyndicatedDuplicate' : null)) || null;
  const fx = fixture({ 'about-entertainment--ben-brantley.json': stale, 'nytimes--ben-brantley.json': live });
  try {
    const r = run(fx.root, { explainFn: ex });
    assert.equal(r.errorCount, 0);
    assert.ok(!fx.exists('about-entertainment--ben-brantley.json'));
    assert.equal(fx.read('nytimes--ben-brantley.json').assignedScore, 78);
  } finally { fx.cleanup(); }
  // Text the target lacks is never thrown away.
  const fx2 = fixture({ 'about-entertainment--ben-brantley.json': { ...stale, fullText: 'A completely different body.' }, 'nytimes--ben-brantley.json': live });
  try {
    const before = fx2.snapshot();
    run(fx2.root, { explainFn: ex });
    assert.deepEqual(fx2.snapshot(), before);
  } finally { fx2.cleanup(); }
});

test('runOutletMismatchCleanup: cycle tolerates a script duplicateClearReason breadcrumb and text the target prefixes with a URL', () => {
  const src = misfile({ duplicateClearReason: 'audit-duplicate-of-url-mismatch.js (--fix) on 2026-08-07: url differed', fullText: 'Other peoples dreams are boring.' });
  const tgt = nytFile({ fullText: 'https://www.nytimes.com/x.htmlShare full article Other peoples dreams are boring.' });
  const fx = fixture({ 'about-entertainment--ben-brantley.json': src, 'nytimes--ben-brantley.json': tgt });
  try {
    run(fx.root, { explainFn: excl });
    assert.ok(!fx.exists('about-entertainment--ben-brantley.json'));
    assert.equal(fx.read('nytimes--ben-brantley.json').isSyndicatedDuplicate, false);
  } finally { fx.cleanup(); }
});

test('runOutletMismatchCleanup: cycle where the misfile has the fuller extraction replaces the boilerplate target', () => {
  const body = 'Oh, what a lovely production this is. '.repeat(30);
  const src = misfile({ fullText: `https://www.nytimes.com/x.htmlShare full article\n\n${body}` });
  const tgt = nytFile({ fullText: 'All print options include free, unlimited access to NYTimes.com.', bwwExcerpt: 'Roundup excerpt only the target has' });
  const fx = fixture({ 'about-entertainment--ben-brantley.json': src, 'nytimes--ben-brantley.json': tgt });
  try {
    const r = run(fx.root, { explainFn: excl });
    assert.equal(r.errorCount, 0);
    assert.ok(!fx.exists('about-entertainment--ben-brantley.json'));
    const t = fx.read('nytimes--ben-brantley.json');
    assert.equal(t.outletId, 'nytimes');
    assert.match(t.fullText, /lovely production/);
    assert.equal(t.duplicateOf, undefined);
    assert.equal(t.isSyndicatedDuplicate, undefined);
    assert.equal(t.bwwExcerpt, 'Roundup excerpt only the target has', 'target-only data carried over');
  } finally { fx.cleanup(); }
});

test('publisherDomainCorrection: a human-written duplicateClearReason still protects the file', () => {
  assert.equal(publisherDomainCorrection(misfile({ duplicateClearReason: 'manual: keep as About' }), { ignoreDuplicateOf: true }), null);
  assert.equal(publisherDomainCorrection(misfile({ duplicateClearReason: 'audit-duplicate-of-url-mismatch.js (--fix) on 2026-08-07' }), { ignoreDuplicateOf: true }).outletId, 'nytimes');
});

test('runOutletMismatchCleanup: a differing conclusion is not "covered" text', () => {
  const body = 'A long shared paragraph of the review body goes here. '.repeat(20);
  const src = misfile({ fullText: body + ' And the verdict: a triumph nobody else quotes.' });
  const tgt = nytFile({ fullText: body });
  const fx = fixture({ 'about-entertainment--ben-brantley.json': src, 'nytimes--ben-brantley.json': tgt });
  try {
    run(fx.root, { explainFn: excl });
    // Source is longer, so it may replace the target, but never be folded away as "covered".
    assert.match(fx.read('nytimes--ben-brantley.json').fullText, /triumph nobody else quotes/);
  } finally { fx.cleanup(); }
});
