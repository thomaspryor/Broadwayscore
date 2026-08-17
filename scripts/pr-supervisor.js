#!/usr/bin/env node
/**
 * pr-supervisor.js — decide what should happen to each open agent PR.
 *
 * Loop 5: agent PRs get finished and then sit. Four had been open all night.
 *
 * THIS SCRIPT CANNOT MERGE ANYTHING. There is no --merge flag and no code path
 * that pushes, merges, comments, or closes. That is the plan review's explicit
 * first increment ("review all four PRs and MERGE NOTHING; merge rights come
 * after"), and it is enforced structurally rather than by a default-off flag so
 * it cannot be flipped on by accident or by an agent editing a default.
 *
 * When merge rights are granted, the actor is `.github/workflows/autonomous-merge.yml`
 * calling scripts/autonomous-merge.js — the ONLY place a branch reaches main,
 * and the holder of the global concurrency group that exists because two merges
 * racing on main was a real incident. This script will hand it verdicts; it will
 * not grow its own merge path.
 *
 * Decision logic lives in scripts/lib/pr-supervisor-core.js as a pure,
 * fixture-tested function. This file is I/O only: fetch, call, print.
 *
 * Usage:
 *   node scripts/pr-supervisor.js                    # every open PR
 *   node scripts/pr-supervisor.js --pr=596,594       # only these
 *   node scripts/pr-supervisor.js --json             # machine-readable
 *   node scripts/pr-supervisor.js --digest           # morning-digest section
 */

const { execFileSync } = require('child_process');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { assessPullRequests, renderSupervisorDigest, rollupCheckState } = require('./lib/pr-supervisor-core.js');

const REPO_ROOT = path.join(__dirname, '..');

if (hasHelpFlag(process.argv.slice(2))) {
  console.log(`pr-supervisor.js — verdicts for open agent PRs. Never merges.

  --pr=N,N     restrict to these PR numbers
  --json       emit the verdict array as JSON
  --digest     emit the one-screen owner summary
  --limit=N    how many open PRs to fetch (default 60)`);
  process.exit(0);
}

const args = process.argv.slice(2);
const flag = (name) => (args.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1] || null;
const only = (flag('pr') || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number);
const asJson = args.includes('--json');
const asDigest = args.includes('--digest');
const limit = Number(flag('limit') || 60);

function gh(argv) {
  return execFileSync('gh', argv, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

/**
 * Read the review-gate ledger. Deliberately the SAME ledger the push gate uses —
 * a second verdict store is exactly what review-gate.mjs:463-513 refuses to allow,
 * because two stores disagree the moment one of them is written by hand.
 */
async function loadEvidence() {
  const mod = await import(path.join(REPO_ROOT, 'scripts/lib/review-gate.mjs'));
  try {
    return mod.readLedger(mod.canonicalRoot(REPO_ROOT)) || [];
  } catch (err) {
    console.error(`[pr-supervisor] could not read the review ledger (${err.message}) — every code PR will HOLD for missing evidence, which is the safe direction.`);
    return [];
  }
}

(async () => {
  let raw;
  try {
    raw = JSON.parse(gh(['pr', 'list', '--state', 'open', '--limit', String(limit),
      '--json', 'number,title,headRefName,headRefOid,isDraft,files,mergeStateStatus,statusCheckRollup']));
  } catch (err) {
    console.error(`[pr-supervisor] gh pr list failed: ${err.message}`);
    process.exit(2);
  }

  // NO SILENT CAPS. Collision detection is only correct over the WHOLE open set —
  // if the fetch was truncated, a PR outside the window is invisible and its
  // collisions are never reported, which would turn an escalate into a merge.
  if (raw.length >= limit) {
    console.error(`[pr-supervisor] refusing: fetched ${raw.length} open PRs, which is the --limit=${limit} cap, so the list may be truncated. Collision detection needs every open PR. Re-run with a higher --limit.`);
    process.exit(2);
  }

  const allOpenPrs = raw.map((p) => ({
    number: p.number,
    title: p.title,
    headSha: p.headRefOid,
    isDraft: p.isDraft,
    files: (p.files || []).map((f) => f.path),
    // Per-file additions/deletions: the additive-registry collision exemption is
    // only granted to an edit PROVEN to delete nothing.
    fileStats: Object.fromEntries((p.files || []).map((f) => [f.path,
      { additions: f.additions, deletions: f.deletions }])),
    mergeStateStatus: p.mergeStateStatus,
    checksState: rollupCheckState(p.statusCheckRollup),
  }));

  const ledger = await loadEvidence();
  const supervised = (only.length ? allOpenPrs.filter((p) => only.includes(p.number)) : allOpenPrs)
    .map((p) => ({
      ...p,
      // Ledger rows carry {head, reviewer, result}. Matching happens in the core.
      // Prefilter only — the core requires an EXACT head match, so a short-prefix
      // collision here cannot clear a PR. Kept narrow anyway.
      evidence: ledger.filter((e) => e && e.head && p.headSha && e.head.startsWith(p.headSha.slice(0, 9))),
    }));

  const verdicts = assessPullRequests(supervised, { allOpenPrs });

  if (asJson) { console.log(JSON.stringify(verdicts, null, 2)); return; }
  if (asDigest) { console.log(renderSupervisorDigest(verdicts, { dryRun: true })); return; }

  const order = { refuse: 0, escalate: 1, hold: 2, merge: 3 };
  for (const v of verdicts.slice().sort((a, b) => order[a.verdict] - order[b.verdict] || a.number - b.number)) {
    console.log(`\n#${v.number} [${v.verdict.toUpperCase()}] ${v.title || ''}`);
    console.log(`  sha ${v.headSha ? v.headSha.slice(0, 9) : '?'}${v.deterministicGreen ? '  deterministic-green' : ''}`);
    for (const r of v.reasons) console.log(`  - ${r}`);
    if (!v.reasons.length) console.log('  - all files allowed, evidence bound to this commit');
  }
  const counts = verdicts.reduce((m, v) => ({ ...m, [v.verdict]: (m[v.verdict] || 0) + 1 }), {});
  console.log(`\n${verdicts.length} PR(s): ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ')}`);
  console.log('NOTHING WAS MERGED — this script has no merge path.');
})();
