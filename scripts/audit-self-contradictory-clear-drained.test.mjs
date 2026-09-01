// Acceptance test for BRO-185: drain the self-contradictory-clear backlog and
// ratchet the gate to 0.
//
// This does NOT assert the backlog is literally empty. BRO-185's own corpus
// scan (2026-09-01) found 718 contradictions split two ways:
//   - 267 were zero-score-impact: resolving them (retracting the stale clear
//     breadcrumb, or demoting a stale wrongShow promotion) provably moves no
//     scored review in or out of the corpus. --fix-safe drained all of these.
//   - 451 carry a live score signal. Resolving those means deciding, per
//     record, which side (the flag or its own clear) is actually correct —
//     a judgement call this detector cannot make from state alone. Bulk-
//     resolving them either direction risks silently moving scored reviews
//     in or out of composite scores, which is exactly what this same
//     corpus's own --fix caused on 2026-08-14 (memory/feedback_audit_fix_
//     remediation_untrusted.md: 438 live-scored reviews, incl. NYT/Brantley,
//     WSJ/Teachout, The Stage and the FT, newly excluded). That backlog is
//     tracked separately via the committed baseline band
//     (data/audit/self-contradictory-clears-baseline.json, ratcheted
//     776 -> 451 by this same session) — not by this test.
//
// What this test DOES guarantee, forever: no contradiction should ever sit in
// the backlog when resolving it is provably zero-impact. --fix-safe (see
// isZeroScoreImpactFix() in lib/flag-contradiction.js) is safe to re-run any
// time, so this bucket regressing above zero means either a new writer
// started creating these no-impact contradictions faster than anything drains
// them, or someone stopped running --fix-safe — both worth knowing about.
//
// Reads LIVE repo data via the scanner — run from the main checkout that owns
// data/review-texts (pattern: audit-cross-outlet-attributions.test.mjs).

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

const REVIEW_TEXTS_DIR = path.join(repoRoot, 'data', 'review-texts');
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
    t.skip('data/review-texts not present in this checkout — run from the main checkout');
    return;
  }
  const showDirs = listShowDirs();
  let scanned = 0;
  const stillSafe = [];

  for (const showId of showDirs) {
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    let files;
    try { files = readdirSync(showDir).filter((f) => f.endsWith('.json')); }
    catch { continue; }

    for (const file of files) {
      let data;
      try { data = JSON.parse(readFileSync(path.join(showDir, file), 'utf8')); }
      catch { continue; }
      scanned++;

      for (const c of detectAllSelfContradictoryClears(data)) {
        if (isZeroScoreImpactFix(data, c)) {
          stillSafe.push(`${showId}/${file} (${c.flag}+${c.breadcrumb})`);
        }
      }
    }
  }

  // Same fail-loud-on-empty-corpus principle as corpus-scan-guard.js (#1063):
  // a missing/empty checkout would otherwise report a vacuous pass.
  assert.ok(scanned > 1000, `corpus scan found suspiciously few files (${scanned}) — checkout likely incomplete`);
  assert.deepEqual(
    stillSafe.slice(0, 10),
    [],
    stillSafe.length
      ? `${stillSafe.length} zero-score-impact contradiction(s) left undrained (showing first 10) — ` +
        'run: node scripts/audit-self-contradictory-clears.js --fix-safe'
      : undefined,
  );
});
