// Run: node --test scripts/lib/prior-production-citations.test.mjs
//
// BRO-3928. These tests require() the real modules (CLAUDE.md §15) — they do
// not restate the rule, so a production change that re-inflates a headline
// count fails here rather than shipping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ppc = require('./prior-production-citations.js');
const { countsFor, censusVerdictFor } = require('./gap-audit-merge.js');

// A revival shaped like the real ones: a handful of genuinely missing
// current-run reviews, buried under a pile of correctly-blocked citations from
// an earlier production of the same title (beetlejuice-2025 carried 58 of 74).
const REVIVAL = {
  showId: 'revival-2026',
  openingDate: '2026-08-01',
  aggregatorArticles: ['https://agg.example/roundup-2026'],
  aggregatorListedUrls: ['https://covered.example/review-2026'],
  missing: [
    { url: 'https://real-gap.example/a', host: 'real-gap.example', knownOutletId: 'rga' },
    { url: 'https://old.example/2012-a', host: 'old.example', knownOutletId: 'olda', priorRun: true, priorRunSource: 'aggregator-article-date' },
    { url: 'https://old.example/2012-b', host: 'old.example', knownOutletId: 'oldb', priorRun: true, priorRunSource: 'aggregator-article-date' },
  ],
  flaggedMisses: [
    { url: 'https://old.example/2012-c', host: 'old.example', knownOutletId: 'oldc', priorRun: true },
  ],
  citedNoUrl: [
    { outletId: 'oldd', source: 'bww-rr', priorRun: true },
  ],
};

test('isPriorProductionCitation is strict-true only — a reshaped producer reads as a REAL gap, never silently as noise', () => {
  assert.equal(ppc.isPriorProductionCitation({ priorRun: true }), true);
  assert.equal(ppc.isPriorProductionCitation({ priorRun: false }), false);
  assert.equal(ppc.isPriorProductionCitation({}), false);
  assert.equal(ppc.isPriorProductionCitation(null), false);
  assert.equal(ppc.isPriorProductionCitation(undefined), false);
  // The direction that matters: a truthy non-true value must NOT be swallowed.
  // Counts going UP gets investigated; counts going quietly DOWN hides a gap.
  assert.equal(ppc.isPriorProductionCitation({ priorRun: 'aggregator-article-date' }), false);
  assert.equal(ppc.isPriorProductionCitation({ priorRun: 1 }), false);
});

test('splitGapCounts separates current-run from prior-production across all three lists', () => {
  const s = ppc.splitGapCounts(REVIVAL);
  assert.equal(s.missing, 1, 'one genuinely missing current-run review');
  assert.equal(s.flaggedMisses, 0);
  assert.equal(s.citedNoUrl, 0);
  assert.equal(s.total, 1);
  assert.equal(s.priorProduction.missing, 2);
  assert.equal(s.priorProduction.flaggedMisses, 1);
  assert.equal(s.priorProduction.citedNoUrl, 1);
  assert.equal(s.priorProduction.total, 4);
});

test('splitGapCounts tolerates legacy rows with missing arrays', () => {
  const s = ppc.splitGapCounts({ showId: 'legacy' });
  assert.equal(s.total, 0);
  assert.equal(s.priorProduction.total, 0);
  assert.deepEqual(ppc.splitGapCounts(null).priorProduction.total, 0);
});

test('countsFor headline numbers are CURRENT-RUN — the BRO-3928 regression', () => {
  const c = countsFor([REVIVAL]);
  assert.equal(c.withGap, 1, 'the show does have one real gap');
  assert.equal(c.missingCurrentRun, 1, 'the headline must NOT include the 2 prior-production URLs');
  assert.equal(c.totalFlaggedMisses, 0);
  assert.equal(c.totalCitedNoUrl, 0);
  assert.equal(c.priorProductionCitations, 4, 'subtracted, not hidden');
});

test('countsFor: a show whose ONLY citations are prior-production does not count as gapped', () => {
  const allOld = {
    showId: 'bull-durham-like',
    aggregatorArticles: ['https://agg.example/r'],
    aggregatorListedUrls: [],
    missing: [
      { url: 'https://o.example/1', host: 'o.example', priorRun: true },
      { url: 'https://o.example/2', host: 'o.example', priorRun: true },
      { url: 'https://o.example/3', host: 'o.example', priorRun: true },
    ],
    flaggedMisses: [],
    citedNoUrl: [],
  };
  const c = countsFor([allOld]);
  assert.equal(c.withGap, 0, 'this is what put "0 of 3 known reviews live" above real gaps in the owner digest');
  assert.equal(c.missingCurrentRun, 0);
  assert.equal(c.priorProductionCitations, 3);

  // …and its census must carry no information rather than a stuck `incomplete`.
  const cv = censusVerdictFor(allOld);
  assert.equal(cv.verdict, 'no-census-yet');
  assert.equal(cv.candidateCount, 0);
});

test('censusVerdictFor drops prior-production citations from the candidate pool', () => {
  const cv = censusVerdictFor(REVIVAL);
  // 1 covered aggregator URL + 1 real missing = 2 candidates. The 4 old ones
  // are gone: with them in, this show could never reach `complete` however
  // many reviews we collected.
  assert.equal(cv.candidateCount, 2);
  assert.equal(cv.liveCount, 1);
  assert.equal(cv.verdict, 'incomplete');
  const urls = cv.candidates.map((c) => c.url);
  assert.ok(!urls.some((u) => String(u).includes('old.example')), 'no prior-production URL may be a candidate');
});

test('censusVerdictFor CAN now reach complete for a revival once its current-run reviews are in', () => {
  const healed = {
    ...REVIVAL,
    aggregatorListedUrls: ['https://covered.example/review-2026', 'https://real-gap.example/a'],
    missing: REVIVAL.missing.filter((m) => m.priorRun),
  };
  const cv = censusVerdictFor(healed);
  assert.equal(cv.verdict, 'complete', 'prior-production citations must not pin a healed revival at incomplete');
});

test('every gap list a human-facing count reads is routed through the canonical predicate', async () => {
  // Guard against the failure this module exists to fix: the rule was already
  // correct in five scattered places and wrong in the two a human reads. If a
  // new `.priorRun` filter is hand-rolled in the counting path, this fails.
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.resolve(import.meta.dirname, '..', '..');
  const files = [
    'scripts/lib/gap-audit-merge.js',
    'scripts/audit-show-review-gap.js',
    'scripts/lib/newsletter-preflight.js',
    'scripts/newsletter/pre-send-check.mjs',
  ];
  const handRolled = [];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    src.split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;            // comments may name the field
      if (!/\.priorRun\b/.test(line)) return;
      // Producers (assignment) and pass-through (object literal field) are fine.
      if (/\.priorRun\s*=[^=]/.test(line)) return;
      if (/priorRun:\s/.test(line)) return;
      // What is NOT fine: a filter/every/some that re-derives the rule inline.
      if (/\.(filter|every|some)\s*\(/.test(line)) handRolled.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(handRolled, [],
    'hand-rolled priorRun filter(s) — use prior-production-citations.js so every count agrees:\n' + handRolled.join('\n'));
});

// ── Schema migration: the whole file must converge on the new rule in ONE
// merge, and the blast-radius guard must not mistake that for coverage loss.
const { mergeGapAudit, needsCensusMigration, CENSUS_SCHEMA, riskStateMap, isRiskyGapChange } =
  require('./gap-audit-merge.js');

test('needsCensusMigration flags a pre-BRO-3928 row and leaves current + verdictless rows alone', () => {
  const withSource = (cv) => ({ censusVerdict: cv, missing: [{ url: 'x', host: 'x.com' }] });
  assert.equal(needsCensusMigration(withSource({ verdict: 'incomplete', liveCount: 1, candidateCount: 9 })), true);
  assert.equal(needsCensusMigration(withSource({ censusSchema: 1, liveCount: 1, candidateCount: 9 })), true);
  assert.equal(needsCensusMigration(withSource({ censusSchema: CENSUS_SCHEMA })), false);
  // No source arrays to rebuild from → refuse, however stale the stamp.
  assert.equal(needsCensusMigration({ censusVerdict: { verdict: 'incomplete', liveCount: 1, candidateCount: 9 } }), false);
  assert.equal(needsCensusMigration({ showId: 'legacy-no-verdict' }), false, 'never invent a verdict for a show nobody audited');
  assert.equal(needsCensusMigration(null), false);
});

test('a carried-forward stale-schema row is re-derived on the next merge, not left for a year', () => {
  const stale = {
    ...REVIVAL,
    computedAt: '2026-09-01T00:00:00.000Z',
    // What v1 wrote: the 4 prior-production citations counted as candidates.
    censusVerdict: { verdict: 'incomplete', liveCount: 1, candidateCount: 6, candidates: [] },
  };
  const merged = mergeGapAudit(
    { generatedAt: '2026-09-01T00:00:00.000Z', results: [stale] },
    { generatedAt: '2026-09-22T00:00:00.000Z', results: [] },   // this run audited nothing
  );
  const row = merged.results.find((r) => r.showId === 'revival-2026');
  assert.equal(row.censusVerdict.censusSchema, CENSUS_SCHEMA);
  assert.equal(row.censusVerdict.candidateCount, 2, 'the 4 prior-production candidates are gone');
  assert.equal(row.computedAt, '2026-09-01T00:00:00.000Z', 'migration must not fake freshness');
});

test('the schema bump does not read as coverage LOSS to the blast-radius guard', () => {
  const v1Row = {
    ...REVIVAL,
    censusVerdict: { verdict: 'incomplete', liveCount: 1, candidateCount: 6, candidates: [] },
  };
  const v2Row = { ...REVIVAL, censusVerdict: censusVerdictFor(REVIVAL) };
  const prev = riskStateMap([v1Row]);
  const next = riskStateMap([v2Row]);
  assert.equal(prev['revival-2026'], next['revival-2026'],
    'both sides normalise to the current rule, so a rule change is not a diff');
  assert.equal(isRiskyGapChange(prev['revival-2026'], next['revival-2026']), false);
});

test('a REAL coverage loss still trips the guard after normalisation', () => {
  const healthy = { ...REVIVAL, censusVerdict: censusVerdictFor(REVIVAL) };
  // Broken checkout: the covered aggregator URL vanished, so liveCount drops.
  const broken = { ...REVIVAL, aggregatorListedUrls: [] };
  broken.censusVerdict = censusVerdictFor(broken);
  const prev = riskStateMap([healthy]);
  const next = riskStateMap([broken]);
  assert.equal(isRiskyGapChange(prev['revival-2026'], next['revival-2026']), true);
});

// ── Migration guards (Codex adversarial review) ─────────────────────────────

test('a row with no usable source arrays is NOT migrated — refuse rather than erase', () => {
  // A partial write leaves a populated verdict beside empty arrays. Rebuilding
  // from those arrays would produce candidateCount 0 and silently erase a real
  // census — and riskStateMap would normalise the previous row the same way,
  // so the blast-radius guard could not see the loss either.
  const hollow = {
    showId: 'hollow-2026',
    computedAt: '2026-09-01T00:00:00.000Z',
    missing: [], flaggedMisses: [], citedNoUrl: [], aggregatorListedUrls: [], aggregatorArticles: [],
    censusVerdict: { verdict: 'incomplete', liveCount: 4, candidateCount: 9, candidates: [] },
  };
  assert.equal(needsCensusMigration(hollow), false);
  const merged = mergeGapAudit(
    { generatedAt: '2026-09-01T00:00:00.000Z', results: [hollow] },
    { generatedAt: '2026-09-22T00:00:00.000Z', results: [] },
  );
  const row = merged.results.find((r) => r.showId === 'hollow-2026');
  assert.equal(row.censusVerdict.candidateCount, 9, 'the stale-but-real verdict survives');
  assert.equal(row.censusVerdict.liveCount, 4);
});

test('an unparseable computedAt does not become the census clock', () => {
  // Such a stamp deliberately survives the retention check (it keeps rows it
  // cannot date). Passed to the classifier as `now`, every age comparison goes
  // NaN — a GAP downgrades to IN_FLIGHT and the schema stamp then stops it
  // ever being retried. The run clock is used instead.
  const bad = { ...REVIVAL, computedAt: 'not-a-date',
    censusVerdict: { verdict: 'incomplete', liveCount: 1, candidateCount: 6, candidates: [] } };
  const merged = mergeGapAudit(
    { generatedAt: '2026-09-01T00:00:00.000Z', results: [bad] },
    { generatedAt: '2026-09-22T00:00:00.000Z', results: [] },
  );
  const row = merged.results.find((r) => r.showId === 'revival-2026');
  assert.equal(row.censusVerdict.censusSchema, CENSUS_SCHEMA);
  assert.equal(row.censusVerdict.candidateCount, 2);
  for (const c of row.censusVerdict.candidates || []) {
    assert.ok(c.state && c.state !== 'undefined', 'every candidate still carries a real state');
  }
});

test('migration is idempotent — a second merge changes nothing', () => {
  const stale = { ...REVIVAL, computedAt: '2026-09-01T00:00:00.000Z',
    censusVerdict: { verdict: 'incomplete', liveCount: 1, candidateCount: 6, candidates: [] } };
  const once = mergeGapAudit({ generatedAt: '2026-09-01T00:00:00.000Z', results: [stale] },
    { generatedAt: '2026-09-22T00:00:00.000Z', results: [] });
  const twice = mergeGapAudit(once, { generatedAt: '2026-09-23T00:00:00.000Z', results: [] });
  const a = once.results.find((r) => r.showId === 'revival-2026');
  const b = twice.results.find((r) => r.showId === 'revival-2026');
  assert.equal(b.censusVerdict.candidateCount, a.censusVerdict.candidateCount);
  assert.equal(b.censusVerdict.liveCount, a.censusVerdict.liveCount);
  assert.equal(b.computedAt, a.computedAt, 'migration must never fake freshness, on any pass');
});

test('stateless-candidates does not expect a state for a citation the census excludes', () => {
  // Otherwise the drift monitor fires on every revival forever and gets muted,
  // losing the real contract-drift detection it exists for.
  const { auditShowCandidates } = require('./stateless-candidates.js');
  const row = { ...REVIVAL, censusVerdict: censusVerdictFor(REVIVAL) };
  const report = auditShowCandidates(row);
  const flagged = [...(report.statelessUrls || []), ...(report.statelessOutlets || [])];
  assert.deepEqual(flagged.filter((x) => String(x).includes('old.example')), [],
    'no prior-production citation may be reported as a stateless candidate');
});
