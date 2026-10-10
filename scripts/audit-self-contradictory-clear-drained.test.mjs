// Acceptance test for BRO-185: drain the self-contradictory-clear backlog and
// ratchet the gate to 0.
//
// This does NOT assert the backlog is literally empty. BRO-185's own corpus
// scan (2026-09-01) found 718 contradictions split two ways:
//   - 267 were zero-score-impact: resolving them (retracting the stale clear
//     breadcrumb, or demoting a stale wrongShow promotion) provably moves no
//     scored review in or out of the corpus, per isZeroScoreImpactFix() in
//     lib/flag-contradiction.js — which checks the SAME two functions
//     rebuild-all-reviews.js itself calls (isIncludableForRebuild,
//     getBestScore), not a re-derived proxy. --fix-safe drained all of these.
//   - 451 carry a live score signal, or would change inclusion. Resolving
//     those means deciding, per record, which side (the flag or its own
//     clear) is actually correct — a judgement call this detector cannot
//     make from state alone. Bulk-resolving them either direction risks
//     silently moving scored reviews in or out of composite scores, which is
//     exactly what this same corpus's own --fix caused on 2026-08-14
//     (memory/feedback_audit_fix_remediation_untrusted.md: 438 live-scored
//     reviews, incl. NYT/Brantley, WSJ/Teachout, The Stage and the FT, newly
//     excluded). That backlog is tracked separately via the committed
//     baseline band (data/audit/self-contradictory-clears-baseline.json,
//     ratcheted 776 -> 451 by this same session) — not by this test.
//
// What this test DOES guarantee: no contradiction should ever sit in the
// backlog when resolving it is provably zero-impact. --fix-safe is safe to
// re-run any time, so this bucket regressing above zero means either a new
// writer started creating these no-impact contradictions faster than
// anything drains them, or nobody re-ran --fix-safe since the last one
// appeared — both worth knowing about, at whatever cadence this test
// actually runs (see the corpus-presence note below).
//
// Corpus presence: like review-guards.explain.test.mjs and its siblings, this
// skips locally when data/review-texts is absent (the unit-tests CI job never
// checks it out — see that file's header for the full story) and is meant to
// be RE-RUN in test.yml's Data Validation job after checkout-review-texts
// with REQUIRE_REVIEW_CORPUS=1, which turns a missing/empty corpus into a
// hard failure instead of a silent, always-green skip.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  detectAllSelfContradictoryClears,
  isZeroScoreImpactFix,
} = require('./lib/flag-contradiction.js');

const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR || path.join(repoRoot, 'data', 'review-texts');
const SHOWS_PATH = path.join(repoRoot, 'data', 'shows.json');
const REQUIRE_CORPUS = process.env.REQUIRE_REVIEW_CORPUS === '1';

// Same skip list as audit-self-contradictory-clears.js: `_superseded-
// misattributed/` is a graveyard for records already replaced, not a live
// scoring input.
const SKIP_DIRS = new Set(['_superseded-misattributed']);

function listShowDirs() {
  let entries;
  try {
    entries = readdirSync(REVIEW_TEXTS_DIR, { withFileTypes: true });
  } catch {
    return null;
  }
  return entries
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => e.name)
    .filter((name) => !SKIP_DIRS.has(name))
    .filter((name) => {
      try { return statSync(path.join(REVIEW_TEXTS_DIR, name)).isDirectory(); }
      catch { return false; }
    });
}

test('no zero-score-impact self-contradictory-clear remains undrained (BRO-185)', (t) => {
  if (!existsSync(REVIEW_TEXTS_DIR)) {
    assert.ok(
      !REQUIRE_CORPUS,
      `REQUIRE_REVIEW_CORPUS=1 but no corpus at ${REVIEW_TEXTS_DIR} — the review-texts checkout did not land, so this would have silently skipped. Fix the checkout rather than unsetting the flag.`
    );
    t.skip(`no corpus at ${REVIEW_TEXTS_DIR} — run from the main checkout, or set REVIEW_TEXTS_DIR`);
    return;
  }

  let showsById = new Map();
  try {
    const shows = JSON.parse(readFileSync(SHOWS_PATH, 'utf8'));
    showsById = new Map((shows.shows || shows).map((s) => [s.id, s]));
  } catch { /* show context is optional — isZeroScoreImpactFix degrades conservatively without it */ }

  const showDirs = listShowDirs();
  let scanned = 0;
  const stillSafe = [];

  for (const showId of showDirs) {
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    let files;
    try { files = readdirSync(showDir).filter((f) => f.endsWith('.json')); }
    catch { continue; }
    const show = showsById.get(showId) || null;

    for (const file of files) {
      const filePath = path.join(showDir, file);
      let data;
      try { data = JSON.parse(readFileSync(filePath, 'utf8')); }
      catch { continue; }
      scanned++;

      for (const c of detectAllSelfContradictoryClears(data)) {
        if (isZeroScoreImpactFix(data, c, { show, filePath })) {
          stillSafe.push(`${showId}/${file} (${c.flag}+${c.breadcrumb})`);
        }
      }
    }
  }

  // Same policy as review-guards.explain.test.mjs: presence of the directory
  // is not presence of the corpus (the unit-tests job leaves a bare, empty
  // data/review-texts/ behind) — only the file count decides.
  if (scanned === 0) {
    assert.ok(
      !REQUIRE_CORPUS,
      `REQUIRE_REVIEW_CORPUS=1 but ${REVIEW_TEXTS_DIR} holds 0 readable review files — the checkout did not land, so this would have been vacuous. Fix the checkout rather than unsetting the flag.`
    );
    t.skip(`corpus at ${REVIEW_TEXTS_DIR} is empty — run from the main checkout, or set REVIEW_TEXTS_DIR`);
    return;
  }

  assert.deepEqual(
    stillSafe.slice(0, 10),
    [],
    stillSafe.length
      ? `${stillSafe.length} zero-score-impact contradiction(s) left undrained (showing first 10) — ` +
        'run: node scripts/audit-self-contradictory-clears.js --fix-safe'
      : undefined,
  );
});
