// BRO-176: explainExclusion() (scripts/lib/review-guards.js) is the single
// implementation of the includability rule chain and names a stable rule for
// every excluded review, but nothing consumed those names — corpus-count
// drift monitors only ever saw "N fewer reviews", never which rule. These
// tests exercise the new consumer (scripts/lib/exclusion-rule-census.js +
// scripts/exclusion-rule-census.js): it must actually call explainExclusion()
// on real review data (not a mock), aggregate the rule names it returns, and
// attribute a change in excluded-review counts to the specific rule (and
// show) that moved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const { explainExclusion } = require('../../scripts/lib/review-guards.js');
const { buildCensus, diffCensus, formatCensusReport, formatDriftReport } =
  require('../../scripts/lib/exclusion-rule-census.js');

// --- Fixtures: real review-file shapes explainExclusion() actually branches on ---

const cleanReview = {
  outletId: 'nytimes',
  criticName: 'Ben Brantley',
  fullText: 'A glowing, substantial review of the production that runs on for a while.',
  publishDate: '2026-06-11T12:00:00-04:00',
};

const wrongProductionReview = {
  outletId: 'variety',
  criticName: 'Some Critic',
  wrongProduction: true,
  fullText: 'This review is actually about a different production entirely.',
};

const noSignalReview = {
  outletId: 'some-blog',
  criticName: 'Nobody',
  // No fullText, no aggregatorStars, no llmScore, no originalScore.
};

test('buildCensus consumes real explainExclusion() rule names (not a hand-copied reason string)', () => {
  // Sanity: these fixtures actually trip the rules this test cares about,
  // via the SAME function production code calls — a forked/hand-maintained
  // rule chain here would be exactly the bug class this card exists to close.
  assert.equal(explainExclusion(cleanReview), null);
  assert.equal(explainExclusion(wrongProductionReview), 'wrongProduction');
  assert.equal(explainExclusion(noSignalReview), 'noTextOrScoreSignal');

  const records = [
    { showId: 'show-a', file: 'nytimes--brantley.json', rule: explainExclusion(cleanReview) },
    { showId: 'show-a', file: 'variety--critic.json', rule: explainExclusion(wrongProductionReview) },
    { showId: 'show-b', file: 'variety--critic2.json', rule: explainExclusion(wrongProductionReview) },
    { showId: 'show-b', file: 'blog--nobody.json', rule: explainExclusion(noSignalReview) },
  ];

  const census = buildCensus(records);

  assert.equal(census.totalScanned, 4);
  assert.equal(census.totalIncluded, 1);
  assert.equal(census.totalExcluded, 3);

  // The rule name is the aggregation key — this is the "consumption" the
  // card asks for: granularity beyond a flat count.
  assert.equal(census.byRule.wrongProduction.count, 2);
  // byRule/byShow are Object.create(null) (prototype-pollution guard) — spread
  // into a plain object before deepEqual so the strict-assert prototype check
  // compares the entries, not the (deliberately different) prototype.
  assert.deepEqual({ ...census.byRule.wrongProduction.shows }, { 'show-a': 1, 'show-b': 1 });
  assert.equal(census.byRule.noTextOrScoreSignal.count, 1);
  assert.equal(census.byRule.wrongProduction, census.byRule.wrongProduction); // no forked copy

  assert.equal(census.byShow['show-b'].excluded, 2);
  assert.deepEqual({ ...census.byShow['show-b'].byRule }, { wrongProduction: 1, noTextOrScoreSignal: 1 });
});

test('buildCensus never buckets an includable review (rule=null) under a rule name', () => {
  const records = [{ showId: 'show-a', file: 'x.json', rule: explainExclusion(cleanReview) }];
  const census = buildCensus(records);
  assert.equal(Object.keys(census.byRule).length, 0);
  assert.equal(census.totalIncluded, 1);
});

test('buildCensus does not let a __proto__/constructor showId pollute Object.prototype', () => {
  const records = [
    { showId: '__proto__', file: 'a.json', rule: explainExclusion(wrongProductionReview) },
    { showId: 'constructor', file: 'b.json', rule: explainExclusion(wrongProductionReview) },
  ];
  const census = buildCensus(records);
  assert.equal(census.byShow['__proto__'].excluded, 1);
  assert.equal(census.byShow['constructor'].excluded, 1);
  assert.equal(census.byRule.wrongProduction.shows['__proto__'], 1);
  // The real assertion: an unrelated fresh object must not have inherited
  // a `.scanned`/`.excluded` from Object.prototype after the above.
  assert.equal({}.scanned, undefined);
  assert.equal(Object.prototype.excluded, undefined);
});

test('diffCensus attributes a rise in excluded-review counts to the specific rule AND show driving it', () => {
  // Baseline: show-a and show-c clean, show-b already has 1 wrongProduction.
  const baseline = buildCensus([
    { showId: 'show-a', file: 'a1.json', rule: explainExclusion(cleanReview) },
    { showId: 'show-b', file: 'b1.json', rule: explainExclusion(wrongProductionReview) },
    { showId: 'show-c', file: 'c1.json', rule: explainExclusion(cleanReview) },
  ]);

  // Current: show-b picks up 2 MORE wrongProduction exclusions (a genuine
  // spike a flat-count monitor would only ever see as "3 fewer reviews").
  const current = buildCensus([
    { showId: 'show-a', file: 'a1.json', rule: explainExclusion(cleanReview) },
    { showId: 'show-b', file: 'b1.json', rule: explainExclusion(wrongProductionReview) },
    { showId: 'show-b', file: 'b2.json', rule: explainExclusion(wrongProductionReview) },
    { showId: 'show-b', file: 'b3.json', rule: explainExclusion(wrongProductionReview) },
    { showId: 'show-c', file: 'c1.json', rule: explainExclusion(cleanReview) },
  ]);

  const diff = diffCensus(baseline, current);

  assert.equal(diff.excludedDelta, 2); // 1 -> 3 excluded
  assert.equal(diff.perRule.length, 1);
  const [wp] = diff.perRule;
  assert.equal(wp.rule, 'wrongProduction');
  assert.equal(wp.before, 1);
  assert.equal(wp.after, 3);
  assert.equal(wp.delta, 2);
  // The attribution: it must name show-b as the driver, not just "the corpus".
  assert.equal(wp.topShows.length, 1);
  assert.equal(wp.topShows[0].showId, 'show-b');
  assert.equal(wp.topShows[0].delta, 2);
});

test('diffCensus reports no rule movement when nothing changed', () => {
  const census = buildCensus([{ showId: 'show-a', file: 'a1.json', rule: explainExclusion(wrongProductionReview) }]);
  const diff = diffCensus(census, census);
  assert.equal(diff.excludedDelta, 0);
  assert.equal(diff.scannedDelta, 0);
  assert.deepEqual(diff.perRule, []);
});

test('formatCensusReport and formatDriftReport render the rule name and the driving show as text', () => {
  const census = buildCensus([
    { showId: 'giant-2026', file: 'a.json', rule: explainExclusion(wrongProductionReview) },
    { showId: 'giant-2026', file: 'b.json', rule: explainExclusion(wrongProductionReview) },
  ]);
  const report = formatCensusReport(census, { limit: 5 });
  assert.match(report, /wrongProduction/);
  assert.match(report, /giant-2026/);
  assert.match(report, /2 excluded/);

  const diff = diffCensus(buildCensus([]), census);
  const driftReport = formatDriftReport(diff, { limit: 5 });
  assert.match(driftReport, /wrongProduction/);
  assert.match(driftReport, /giant-2026/);
  assert.match(driftReport, /\+2/);
});

// --- End-to-end: the CLI script's own corpus walk, against real fixture files ---

test('scripts/exclusion-rule-census.js scanCorpus() calls explainExclusion() per file and names the rule', () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exclusion-rule-census-'));
  try {
    const showDir = path.join(fixtureDir, 'giant-2026');
    fs.mkdirSync(showDir, { recursive: true });
    fs.writeFileSync(path.join(showDir, 'nytimes--brantley.json'), JSON.stringify(cleanReview));
    fs.writeFileSync(path.join(showDir, 'variety--critic.json'), JSON.stringify(wrongProductionReview));
    fs.writeFileSync(path.join(showDir, 'blog--nobody.json'), JSON.stringify(noSignalReview));

    const { scanCorpus } = require('../../scripts/exclusion-rule-census.js');
    const records = scanCorpus({ reviewTextsDir: fixtureDir, showById: {}, showFilter: null });

    assert.equal(records.length, 3);
    const byFile = Object.fromEntries(records.map((r) => [r.file, r.rule]));
    assert.equal(byFile['nytimes--brantley.json'], null);
    assert.equal(byFile['variety--critic.json'], 'wrongProduction');
    assert.equal(byFile['blog--nobody.json'], 'noTextOrScoreSignal');

    const census = buildCensus(records);
    assert.equal(census.byRule.wrongProduction.shows['giant-2026'], 1);
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('CLI main(): each run diffs against the PRIOR run, not a stale one-generation-back snapshot', () => {
  // Regression for a bug caught by adversarial review: reading the rotated
  // "-previous.json" baseline before overwriting it (rotate-then-diff vs
  // diff-then-rotate) meant every run >= 3 diffed against run N-2, silently
  // dropping whatever changed on run N-1. Runs the actual CLI as a
  // subprocess three times against a fixture corpus that changes between
  // run 2 and run 3, and asserts run 3's diff sees exactly that change.
  const { execFileSync } = require('node:child_process');
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exclusion-rule-census-cli-'));
  const auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exclusion-rule-census-audit-'));
  const showDir = path.join(fixtureDir, 'show-a');
  fs.mkdirSync(showDir, { recursive: true });
  const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'exclusion-rule-census.js');

  const run = () =>
    JSON.parse(
      execFileSync('node', [cliPath, '--json-only'], {
        encoding: 'utf8',
        env: { ...process.env, REVIEW_TEXTS_DIR: fixtureDir, EXCLUSION_CENSUS_AUDIT_DIR: auditDir, SHOWS_JSON: path.join(fixtureDir, 'no-shows.json') },
      })
    );

  try {
    fs.writeFileSync(path.join(showDir, 'a.json'), JSON.stringify(cleanReview));
    const run1 = run(); // no prior snapshot yet
    assert.equal(run1.diff, null);

    const run2 = run(); // diffs against run1 (no change)
    assert.equal(run2.diff.excludedDelta, 0);

    // Change happens strictly between run 2 and run 3.
    fs.writeFileSync(path.join(showDir, 'b.json'), JSON.stringify(wrongProductionReview));
    const run3 = run();

    assert.equal(run3.diff.excludedDelta, 1);
    assert.equal(run3.diff.perRule.length, 1);
    assert.equal(run3.diff.perRule[0].rule, 'wrongProduction');
    assert.equal(run3.diff.perRule[0].delta, 1);
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
    fs.rmSync(auditDir, { recursive: true, force: true });
  }
});
