// Parity regression guard for scripts/lib/market-routing.js — Sprint 3 / S3-T2.
//
// Per feedback_refactor_parity_test.md: the same-title-disambig refactor
// changed classifyMarketRouting in ways unit tests alone cannot prove safe.
// This test snapshots the classifier's decision on a representative 95-sample
// fixture and asserts byte-identical output on every run.
//
// Snapshot lives at data/audit/classify-parity-baseline.json (committed
// alongside this file). To intentionally update the baseline after a vetted
// policy change, re-run the one-shot generator described in plan task S3-T2
// (NOT this test) and commit the diff with a justification.
//
// Sample composition (see baseline.composition):
//   - 11 known-bad findings from data/audit/same-title-confusion.json
//   - 47 same-market same-title-sibling reviews (titanique, oh-mary, ...)
//   - 10 cross-market West End reviews
//   - 27 general random plain-accept reviews
//
// PER PRE-MORTEM: the sample is capped at 95 review URLs. We MUST NOT load
// data/reviews.json — that file holds 36k+ records and exceeded the 5-minute
// CI cap in an earlier design. Per-review JSONs (one classifyMarketRouting
// call each) run in <1s locally.
//
// ALLOWED_DIFFS contains a (currently empty) list of URLs whose decision is
// known to legitimately flip in a future change. Any UN-listed diff fails
// the test and surfaces the before/after JSON for the operator to inspect.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

const { classifyMarketRouting, buildSiblingIndex } =
  require(path.join(REPO_ROOT, 'scripts/lib/market-routing.js'));

const BASELINE_PATH = path.join(REPO_ROOT, 'data/audit/classify-parity-baseline.json');
const SHOWS_PATH = path.join(REPO_ROOT, 'data/shows.json');

// Allowed diff list — known-good policy flips. Keep empty by default; add an
// entry with a justification comment when a future change is intentional.
// Format: { showId, url, reason }
const ALLOWED_DIFFS = [
  // finding 8: oh-mary-2024 1minutecritic review published 2026-01-19 — 32d after
  // oh-mary-west-end-2025 opening. Was accept under 30d threshold; now reroutes to
  // oh-mary-west-end-2025 under CROSS_MARKET_SIBLING_CLOSE_DAYS=60 (intentional).
  {
    showId: 'oh-mary-2024',
    url: 'https://1minutecritic.com/oh-mary-broadway-review/',
    reason: 'cross-market threshold raised 30→60d; 32d distToSib now reroutes to oh-mary-west-end-2025',
  },
];

function loadBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) {
    throw new Error(`Missing baseline at ${BASELINE_PATH}`);
  }
  return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
}

function loadShows() {
  const j = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  // shows.json is { _meta, shows: [...] }
  return Array.isArray(j) ? j : j.shows;
}

function canonicalize(decision) {
  // Compare a stable subset — ignore non-deterministic fields if any are
  // added later. Currently classifyMarketRouting returns only action/
  // targetShowId/reason/flag/signalsByCandidate. signalsByCandidate is
  // included so signal-cascade regressions surface here.
  return JSON.stringify({
    action: decision.action,
    targetShowId: decision.targetShowId ?? null,
    flag: decision.flag ?? null,
    reason: decision.reason ?? null,
    signalsByCandidate: decision.signalsByCandidate
      ? decision.signalsByCandidate.map(s => ({ id: s.id, signals: [...s.signals].sort() }))
      : null,
  });
}

function isAllowed(showId, url) {
  return ALLOWED_DIFFS.some(d => d.showId === showId && d.url === url);
}

test('classify-market-routing parity vs committed baseline (95 samples)', () => {
  const baseline = loadBaseline();
  const shows = loadShows();
  const showById = new Map(shows.map(s => [s.id, s]));
  const siblingIndex = buildSiblingIndex(shows);

  assert.ok(Array.isArray(baseline.samples), 'baseline.samples must be an array');
  assert.ok(baseline.samples.length >= 80 && baseline.samples.length <= 100,
    `sample size must stay in 80–100 range (was ${baseline.samples.length}) — see pre-mortem in header`);

  const diffs = [];
  const t0 = Date.now();
  for (const sample of baseline.samples) {
    const show = showById.get(sample.showId);
    // If the show was removed from shows.json the sibling index won't have it.
    // Treat as a test-data drift and fail loudly so the operator regenerates.
    if (!show) {
      diffs.push({
        showId: sample.showId,
        url: sample.url,
        kind: 'missing-show',
        baseline: sample.decision,
        current: null,
      });
      continue;
    }
    const input = {
      showId: sample.showId,
      url: sample.url,
      outletId: sample.outletId,
      publishDate: sample.publishDate,
      category: show.category || null,
      siblingIndex,
    };
    const current = classifyMarketRouting(input);
    if (canonicalize(current) !== canonicalize(sample.decision)) {
      if (!isAllowed(sample.showId, sample.url)) {
        diffs.push({
          showId: sample.showId,
          url: sample.url,
          kind: 'decision-mismatch',
          baseline: sample.decision,
          current,
        });
      }
    }
  }
  const elapsedMs = Date.now() - t0;

  // Performance guard — pre-mortem said the original loaded reviews.json and
  // timed out CI. 60s ceiling matches the acceptance criterion.
  assert.ok(elapsedMs < 60000, `parity test took ${elapsedMs}ms, must stay <60s`);

  if (diffs.length) {
    const preview = diffs.slice(0, 5)
      .map(d => `  - [${d.kind}] ${d.showId}\n    url: ${d.url}\n    baseline: ${JSON.stringify(d.baseline)}\n    current:  ${JSON.stringify(d.current)}`)
      .join('\n');
    assert.fail(
      `Parity regression: ${diffs.length} diff(s) vs data/audit/classify-parity-baseline.json.\n` +
      `First ${Math.min(5, diffs.length)}:\n${preview}\n\n` +
      `If this change is intentional:\n` +
      `  1. Add an entry to ALLOWED_DIFFS in this test with a justification comment, OR\n` +
      `  2. Regenerate the baseline (re-run the one-shot generator from plan task S3-T2) and commit it together with the policy change.`
    );
  }
});
