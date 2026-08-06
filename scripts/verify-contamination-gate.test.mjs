/**
 * verify-contamination-gate.test.mjs — the machine-checkable acceptance command
 * for the review-text contamination gate (Notion 3b3637c5-416f-818b / task #1072).
 *
 * Like verify-provider-spend-streak.test.mjs, this deliberately asserts against
 * LIVE repo data rather than a fixture: it shells out to the real
 * audit-review-contamination.js --gate over the real review-texts corpus. Its
 * whole purpose is to be re-runnable by a dispatched session (and by
 * scripts/autonomous-acceptance-recheck.js) to answer "is the gate green yet?"
 * A red run here is not a code regression — it is the drift claim still being
 * true, which is exactly the signal the card exists to produce.
 *
 * Two assertions, deliberately split:
 *  - class A (cross-market leak) must be ZERO. This is the user-facing one: a
 *    show displaying another production's reviews. It regressed to 1 on
 *    2026-08-05 when a regional tryout absorbed three Broadway reviews, and is
 *    now additionally blocked at write time (createReviewFile).
 *  - strict hits must be at or under GATE_FLOOR. This is the accumulated-drift
 *    half and is what task #1072 is actually about.
 *
 * SKIPS (does not fail) when the review-texts corpus is absent — it lives in a
 * separate private repo, so a checkout without it can't judge the claim either
 * way, and a false red would be worse than no signal.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..');
const CORPUS = path.join(REPO, 'data', 'review-texts');
const AUDIT = path.join(REPO, 'scripts', 'audit-review-contamination.js');

function runGate() {
  try {
    return execFileSync('node', [AUDIT, '--gate'], {
      cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000,
    });
  } catch (err) {
    // The audit exits non-zero when the gate fails — that is the case we are
    // here to inspect, so read its output rather than treating it as a crash.
    return `${err.stdout || ''}${err.stderr || ''}`;
  }
}

function parseGate(out) {
  const m = out.match(/GATE:\s*(\d+)\s*cross-market leak\(s\).*?\+\s*(\d+)\s*strict hit\(s\)\s*(?:vs|≤)\s*floor\s*(\d+)/);
  if (!m) return null;
  return { leaks: Number(m[1]), strict: Number(m[2]), floor: Number(m[3]) };
}

const corpusPresent = fs.existsSync(CORPUS) && fs.readdirSync(CORPUS).length > 10;

test('no class-A cross-market leaks (a show showing another production\'s reviews)', { skip: !corpusPresent && 'review-texts corpus not checked out' }, () => {
  const g = parseGate(runGate());
  assert.ok(g, 'could not parse the GATE line from audit-review-contamination --gate');
  assert.equal(g.leaks, 0,
    `${g.leaks} cross-market leak(s) — a user is being shown another production's reviews. ` +
    'Run `node scripts/audit-review-contamination.js --gate` and read the A_cross_market block.');
});

test('strict contamination hits are at or under GATE_FLOOR', { skip: !corpusPresent && 'review-texts corpus not checked out' }, () => {
  const g = parseGate(runGate());
  assert.ok(g, 'could not parse the GATE line from audit-review-contamination --gate');
  assert.ok(g.strict <= g.floor,
    `${g.strict} strict hit(s) vs floor ${g.floor}. Triage the largest class down ` +
    '(C_domain_mismatch, C2_url_multi_critic, D_pre_opening_feature, B_false_positive_wp, ' +
    'F_empty_unknown). Do NOT raise GATE_FLOOR to go green — it is a mass-spike detector.');
});
