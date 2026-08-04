// Acceptance test for Notion card 3b2637c5-416f-818f (Carmen-class sweep):
// passes only when every cross-outlet attribution suspect has been triaged
// (corrected, excluded, or annotated crossOutletVerified:true). Reads LIVE
// repo data via the scanner — run from the main checkout that owns
// data/review-texts (pattern: verify-provider-spend-streak.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The happy-path test below only ever exercises count===0 (a tiny payload) in
// this repo's current data, so it can't catch a regression to the bug it was
// written to prove is fixed: process.exit() called right after console.log()
// truncates execFileSync-captured stdout for pipes before the write flushes
// (repro'd 30/30 truncation failures at exactly 65536 bytes vs 30/30 clean
// parses with process.exitCode, which lets Node drain the stream first).
// A large real suspect list would silently start failing JSON.parse again
// without this static guard on the fix itself (ship-check finding, card
// 3b2637c5-416f-818f).
test('exit uses process.exitCode, not process.exit() — stdout-truncation regression guard', () => {
  const src = readFileSync(path.join(repoRoot, 'scripts', 'audit-cross-outlet-attributions.js'), 'utf8');
  assert.match(
    src,
    /process\.exitCode = suspects\.length > 0 \? 1 : 0;/,
    'final exit must set process.exitCode, not call process.exit() — process.exit() right after ' +
      'console.log() of the --json payload truncates execFileSync-captured stdout'
  );
});

test('no unreviewed cross-outlet attribution suspects remain', (t) => {
  let out;
  try {
    out = execFileSync(
      process.execPath,
      [path.join(repoRoot, 'scripts', 'audit-cross-outlet-attributions.js'), '--json'],
      { cwd: repoRoot, encoding: 'utf8' }
    );
  } catch (err) {
    if (err.status === 3) {
      // Scanner's "cannot verify here" exit: this checkout has no
      // data/review-texts (e.g. autonomous-acceptance-recheck's disposable
      // worktree). Skip rather than fail — the recheck is shadow-mode and a
      // human flips the card only after running this test from the MAIN
      // checkout, so a skip here never silently completes the card.
      t.skip('data/review-texts not present in this checkout — run from the main checkout');
      return;
    }
    // Exit 1 = suspects remain; stdout still carries the JSON report.
    out = err.stdout;
  }
  const { count, suspects } = JSON.parse(out);
  assert.strictEqual(
    count,
    0,
    `unreviewed cross-outlet suspects remain (first 5): ${JSON.stringify((suspects || []).slice(0, 5), null, 2)}`
  );
});

// Acceptance test for task #991 (card 3b2637c5-416f-81e6): the fullText-present
// T1/T2 population the base scan above explicitly skips (`if (d.fullText) continue`)
// must also be triaged, via `--include-fulltext`.
test('no unreviewed T1/T2 fullText-present cross-outlet attribution suspects remain', (t) => {
  let out;
  try {
    out = execFileSync(
      process.execPath,
      [path.join(repoRoot, 'scripts', 'audit-cross-outlet-attributions.js'), '--include-fulltext', '--json'],
      { cwd: repoRoot, encoding: 'utf8' }
    );
  } catch (err) {
    if (err.status === 3) {
      t.skip('data/review-texts not present in this checkout — run from the main checkout');
      return;
    }
    out = err.stdout;
  }
  const { count, suspects } = JSON.parse(out);
  assert.strictEqual(
    count,
    0,
    `unreviewed T1/T2 fullText-present cross-outlet suspects remain (first 5): ${JSON.stringify((suspects || []).slice(0, 5), null, 2)}`
  );
});

// Acceptance test for task #1008 (card 3b2637c5-416f-81da): the
// registry-mismatch-gated scans above miss a repeated instance of the same
// playbill-verdict byline-bleed bug when the critic's registry defaultCritic
// happens to resolve correctly at one outlet in the bleed group. --playbill-bleed
// groups by (showId, criticName) instead and must find zero unreviewed groups.
test('no unreviewed playbill-verdict byline-bleed groups remain', (t) => {
  let out;
  try {
    out = execFileSync(
      process.execPath,
      [path.join(repoRoot, 'scripts', 'audit-cross-outlet-attributions.js'), '--playbill-bleed', '--json'],
      { cwd: repoRoot, encoding: 'utf8' }
    );
  } catch (err) {
    if (err.status === 3) {
      t.skip('data/review-texts not present in this checkout — run from the main checkout');
      return;
    }
    out = err.stdout;
  }
  const { count, groups } = JSON.parse(out);
  assert.strictEqual(
    count,
    0,
    `unreviewed playbill-verdict byline-bleed groups remain: ${JSON.stringify((groups || []).slice(0, 5), null, 2)}`
  );
});

// Acceptance test for task #1023: crossOutletVerified:true + wrongAttribution:true
// together on a file that's otherwise live-scoring (has an assignedScore and
// isn't already excluded via wrongProduction/wrongShow) means a fix script's
// "clear the flag" write was silently reverted — review-write-guard.js's
// PROTECTED_FIELDS preserve loop only honors a wrongAttribution delete when the
// write carries the wrongArticleManualClear breadcrumb; without it the delete
// is dropped and the review stays excluded from scoring despite the byline fix
// (ship-check adversarial finding, task #1008). NOT flagged: files where BOTH
// flags are a deliberate dual annotation on content already excluded for other
// reasons (wrongProduction/wrongShow) or never scored (no assignedScore) —
// e.g. "Roy Berko is a real regional critic in general, but this specific file
// can't be confirmed" is a legitimate hybrid note, not a reverted clear.
test('no live-scoring review-text file has a reverted wrongAttribution clear', (t) => {
  const reviewTexts = path.join(repoRoot, 'data', 'review-texts');
  if (!existsSync(reviewTexts)) {
    t.skip('data/review-texts not present in this checkout — run from the main checkout');
    return;
  }
  const contradictions = [];
  for (const showId of readdirSync(reviewTexts)) {
    if (showId.startsWith('_') || showId.startsWith('.')) continue;
    const dir = path.join(reviewTexts, showId);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      let d;
      try {
        d = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
      } catch {
        continue;
      }
      if (
        d.crossOutletVerified === true &&
        d.wrongAttribution === true &&
        d.assignedScore != null &&
        d.wrongProduction !== true &&
        d.wrongShow !== true
      ) {
        contradictions.push(`${showId}/${file}`);
      }
    }
  }
  assert.strictEqual(
    contradictions.length,
    0,
    `live-scoring files with a reverted wrongAttribution clear remain: ${JSON.stringify(contradictions, null, 2)}`
  );
});
