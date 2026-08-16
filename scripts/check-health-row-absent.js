#!/usr/bin/env node
/**
 * check-health-row-absent.js — machine-checkable acceptance criteria for
 * digest-autofix cards (Digest v3, owner mandate 2026-08-02).
 *
 * Exit 0 iff the named health-check row is ABSENT from the latest daily
 * health snapshot (data/audit/health-digest-snapshot.json). This is the
 * safe-form verify command digest-autofix writes into every auto-filed card,
 * so bsc-next's verification gate can arm it and the nightly acceptance
 * recheck can re-run it.
 *
 * Deliberately READ-ONLY: it reads the snapshot the scheduled health check
 * already writes every morning instead of re-running scripts/health-check.js,
 * which sends email digests and writes alert ledgers — a recheck must never
 * have side effects. Freshness is enforced instead: a snapshot older than
 * MAX_AGE_H is a verification failure (exit 3), never a silent pass.
 *
 * --live (Digest-autofix S5, task #1224): re-runs the same core check list
 * LIVE, via scripts/lib/health-row-probe.js, instead of reading yesterday's
 * snapshot — the probe is itself side-effect-free (see its header), so this
 * stays a safe verify command. Use this when a same-day fix needs proving
 * before the next scheduled snapshot exists. Exit codes are unchanged, EXCEPT
 * the probe's 'unknown' verdict (row not verifiable in this environment —
 * e.g. no GH_TOKEN/NOTION_API_KEY here — see health-row-probe.js) maps to the
 * same "cannot verify" exit 3 as a stale/missing snapshot, rather than a
 * false pass.
 *
 * The row name travels as base64url (--row-b64) because the check runner
 * (scripts/lib/autonomous-checks.js cardCheckArgv) splits commands on
 * whitespace with no quote parsing, and the safe-form regex in
 * autonomous-triage-core.js constrains args to a single [A-Za-z0-9_-] token.
 *
 * Exit codes: 0 row absent (fixed) · 1 row present · 2 usage/decode error
 *             3 snapshot missing/stale, or (--live) cannot verify in this
 *             environment
 */

'use strict';

const fs = require('fs');
const path = require('path');

// HEALTH_ROW_ABSENT_SNAPSHOT_PATH override (task #1662): lets tests point this
// at a throwaway fixture instead of racing CI/parallel sessions on the real
// tracked data/audit/health-digest-snapshot.json.
const SNAPSHOT = process.env.HEALTH_ROW_ABSENT_SNAPSHOT_PATH
  || path.join(__dirname, '..', 'data', 'audit', 'health-digest-snapshot.json');
const MAX_AGE_H = 48;

function b64urlDecode(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

async function main(argv) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node scripts/check-health-row-absent.js (--row "<name>" | --row-b64 <base64url>) [--live]');
    console.log('Exit 0 iff the named row is absent from the latest health-digest snapshot.');
    console.log('--live re-runs the core checks live instead of reading the snapshot (scripts/lib/health-row-probe.js).');
    return 2;
  }
  let row = null;
  const b64At = args.indexOf('--row-b64');
  const rowAt = args.indexOf('--row');
  if (b64At !== -1 && args[b64At + 1]) {
    try { row = b64urlDecode(args[b64At + 1]); } catch { /* fall through */ }
  } else if (rowAt !== -1 && args[rowAt + 1]) {
    row = args[rowAt + 1];
  }
  if (!row || !row.trim()) {
    console.error('[check-health-row-absent] no row name given (use --row or --row-b64)');
    return 2;
  }
  row = row.trim();

  if (args.includes('--live')) {
    const { probeHealthRowLive } = require('./lib/health-row-probe.js');
    let probe;
    try {
      probe = await probeHealthRowLive(row);
    } catch (err) {
      console.error(`[check-health-row-absent] --live probe crashed: ${err.message}`);
      return 3;
    }
    if (probe.verdict === 'unknown') {
      console.error(`[check-health-row-absent] --live CANNOT VERIFY: "${row}" did not appear (or only appeared as a credential-skip placeholder) in this environment's live check run — this environment is likely missing a credential the owning check needs (see scripts/lib/health-row-probe.js)`);
      return 3;
    }
    if (probe.verdict === 'present') {
      console.error(`[check-health-row-absent] --live FAIL: "${row}" still flagged (${probe.matched.status}): ${probe.matched.message}`);
      return 1;
    }
    console.log(`[check-health-row-absent] --live PASS: "${row}" absent from the live check run (${probe.generatedAt})`);
    return 0;
  }

  let snap;
  try {
    snap = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  } catch (err) {
    console.error(`[check-health-row-absent] snapshot unreadable (${SNAPSHOT}): ${err.message}`);
    return 3;
  }
  const ageH = (Date.now() - Date.parse(snap.generatedAt || 0)) / 36e5;
  if (!Number.isFinite(ageH) || ageH > MAX_AGE_H) {
    console.error(`[check-health-row-absent] snapshot stale (${Number.isFinite(ageH) ? ageH.toFixed(1) + 'h' : 'no generatedAt'} > ${MAX_AGE_H}h) — cannot verify; wait for the next scheduled health check`);
    return 3;
  }

  // Compare on the same 120-char bound digest-autofix encodes with, so long
  // row names stay verifiable instead of silently never-matching.
  const LIMIT = 120;
  const target = row.slice(0, LIMIT);
  const present = [...(snap.errors || []), ...(snap.warns || [])]
    .some(r => r && String(r.name || '').trim().slice(0, LIMIT) === target);
  if (present) {
    console.error(`[check-health-row-absent] FAIL: "${row}" still listed in the ${snap.generatedAt} health snapshot`);
    return 1;
  }
  console.log(`[check-health-row-absent] PASS: "${row}" absent from the ${snap.generatedAt} health snapshot`);
  return 0;
}

if (require.main === module) {
  main(process.argv).then(
    (code) => process.exit(code),
    (err) => { console.error(`[check-health-row-absent] crashed: ${err.stack || err.message}`); process.exit(3); }
  );
}
module.exports = { main, MAX_AGE_H };
