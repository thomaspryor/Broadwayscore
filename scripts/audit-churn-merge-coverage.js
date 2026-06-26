#!/usr/bin/env node
'use strict';

/**
 * audit-churn-merge-coverage.js
 *
 * Coverage monitor for .gitattributes merge drivers. The registration guard in
 * test.yml ("merge drivers registered") checks that every DECLARED `merge=`
 * driver is registered in setup-local-data.sh — it cannot see a file that SHOULD
 * have a driver but never got one. This audit closes that gap from the other
 * side: it finds high-churn TRACKED files that lack a merge attribute, the exact
 * files that conflict on a human's bare `git merge` to main.
 *
 * Why it exists: the .gitattributes `merge=ours`/`merge=union` block was built by
 * hand-triaging churn twice (2026-06-21 top tier, 2026-06-25 next tier). Both
 * passes were a manual `git log | sort | uniq -c` + per-file read-back. The
 * collection-state/*.json files (500+ commits/3d, no driver) sat uncovered the
 * whole time because nobody re-ran the manual count. "Did this twice by hand →
 * write the tool." This is that tool.
 *
 * Classification (pure logic in scripts/lib/churn-merge-coverage.js):
 *   covered  — has a real `merge` attribute. No human conflict.
 *   exempt   — no driver, but `merge-coverage=exempt` in .gitattributes (served/
 *              human-editable needing a real 3-way merge, or accumulate-state
 *              with no clean driver). Intentional; suppressed.
 *   flagged  — high churn, no driver, not exempt → needs a merge-attr decision.
 *
 * Wired into check-corpus-drift.js as a non-blocking AUDITS entry: flagged files
 * surface in the daily digest, they do NOT fail the build.
 *
 * Usage:
 *   node scripts/audit-churn-merge-coverage.js                # write json, exit 0/1
 *   node scripts/audit-churn-merge-coverage.js --days=7 --min-churn=20
 *   node scripts/audit-churn-merge-coverage.js --json         # print verdict to stdout
 *   node scripts/audit-churn-merge-coverage.js --audit-out=PATH
 *
 * Exit codes (chosen to fit check-corpus-drift's model — see its crashCodes):
 *   0 — no flagged files (all high-churn files covered or exempt)
 *   1 — one or more flagged files need a merge-attr decision (drift; non-blocking)
 *   2 — could not run (not a git repo / git unavailable). check-corpus-drift maps
 *       this to a crash → real error. Insufficient git history is NOT exit 2 — it
 *       degrades gracefully (degraded:true) so a shallow-checkout hiccup can never
 *       turn this passive monitor into a red build.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { classifyChurnCoverage } = require('./lib/churn-merge-coverage.js');

const DEFAULT_DAYS = 3; // matches the "commits/3d" bucket taxonomy in .gitattributes
const DEFAULT_MIN_CHURN = 30; // the lowest hand-triaged tier ("30–100 commits/3d")
const AUDIT_OUT_DEFAULT = path.join(process.cwd(), 'data', 'audit', 'churn-merge-coverage.json');

function git(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
}

function gitOk(args) {
  try {
    git(args, { stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

// Count per-file appearances across commits in the window. A file that churned
// then got deleted is excluded by intersecting with the live `git ls-files` set,
// and gitignored-but-historically-committed files (e.g. rebuild-consistency.json)
// fall out the same way — both would otherwise produce un-actionable flags.
function computeChurn(days) {
  const since = `${days} days ago`;
  const raw = git(['log', `--since=${since}`, '--name-only', '--pretty=format:']);
  const counts = new Map();
  for (const line of raw.split('\n')) {
    const f = line.trim();
    if (!f) continue;
    counts.set(f, (counts.get(f) || 0) + 1);
  }
  return counts;
}

function trackedSet() {
  const raw = git(['ls-files']);
  return new Set(raw.split('\n').map((s) => s.trim()).filter(Boolean));
}

// Batch-query `merge` + `merge-coverage` for the candidate paths in one process.
// Output is two lines per path: "<path>: merge: <v>" and "<path>: merge-coverage: <v>".
function readMergeAttrs(paths) {
  const attrs = new Map(); // path -> { mergeAttr, coverageAttr }
  if (paths.length === 0) return attrs;
  const out = git(['check-attr', 'merge', 'merge-coverage', '--stdin'], {
    input: paths.join('\n') + '\n',
  });
  for (const line of out.split('\n')) {
    // Split on the LAST two ": " so paths containing ": " still parse.
    const m = line.match(/^(.*): (merge|merge-coverage): (.*)$/);
    if (!m) continue;
    const [, file, attr, value] = m;
    const rec = attrs.get(file) || {};
    if (attr === 'merge') rec.mergeAttr = value;
    else rec.coverageAttr = value;
    attrs.set(file, rec);
  }
  return attrs;
}

// True when every commit in the window is reachable. Full clone → always true.
// Shallow clone → true only if the oldest reachable commit predates the window
// start (otherwise churn counts are truncated and we report degraded:true).
function historyComplete(days) {
  const shallow = git(['rev-parse', '--is-shallow-repository']).trim() === 'true';
  if (!shallow) return true;
  const all = git(['log', '--format=%cI']).trim().split('\n').filter(Boolean);
  if (all.length === 0) return false;
  const oldest = new Date(all[all.length - 1]).getTime();
  const windowStart = Date.now() - days * 86400 * 1000;
  return oldest <= windowStart;
}

function parseArgs(argv) {
  const get = (name, dflt) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.split('=')[1] : dflt;
  };
  return {
    days: Math.max(1, parseInt(get('days', String(DEFAULT_DAYS)), 10) || DEFAULT_DAYS),
    minChurn: Math.max(1, parseInt(get('min-churn', String(DEFAULT_MIN_CHURN)), 10) || DEFAULT_MIN_CHURN),
    json: argv.includes('--json'),
    auditOut: (() => {
      const p = get('audit-out', null);
      return p ? path.resolve(p) : AUDIT_OUT_DEFAULT;
    })(),
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!gitOk(['rev-parse', '--git-dir'])) {
    console.error('[churn-merge-coverage] not a git repository (or git unavailable)');
    process.exit(2);
  }

  let degraded = false;
  try {
    degraded = !historyComplete(opts.days);
  } catch {
    degraded = true; // can't prove completeness → flag, don't crash
  }

  const churn = computeChurn(opts.days);
  const tracked = trackedSet();

  // Candidates: tracked files at/above the churn floor. Cap attr lookups to these.
  const candidates = [];
  for (const [file, count] of churn) {
    if (count >= opts.minChurn && tracked.has(file)) candidates.push(file);
  }
  const attrs = readMergeAttrs(candidates);

  const files = candidates.map((p) => ({
    path: p,
    churn: churn.get(p),
    mergeAttr: (attrs.get(p) || {}).mergeAttr || 'unspecified',
    coverageAttr: (attrs.get(p) || {}).coverageAttr || 'unspecified',
  }));

  const result = classifyChurnCoverage({ files, minChurn: opts.minChurn });

  const verdict = {
    _meta: {
      generatedAt: new Date().toISOString(),
      windowDays: opts.days,
      minChurn: opts.minChurn,
      degraded,
      note:
        'Churn-vs-merge-attribute coverage monitor. Non-blocking; surfaced via ' +
        'health-check.js digest. Flagged = high-churn tracked file with no merge ' +
        'driver and no merge-coverage=exempt mark in .gitattributes.',
    },
    summary: result.summary,
    flagged: result.flagged,
    exempt: result.exempt,
    covered: result.covered,
  };

  fs.mkdirSync(path.dirname(opts.auditOut), { recursive: true });
  fs.writeFileSync(opts.auditOut, JSON.stringify(verdict, null, 2) + '\n');

  if (opts.json) {
    console.log(JSON.stringify(verdict, null, 2));
  } else {
    console.log(
      `[churn-merge-coverage] window=${opts.days}d minChurn=${opts.minChurn} → ` +
        `${result.summary.flaggedCount} flagged, ${result.summary.exemptCount} exempt, ` +
        `${result.summary.coveredCount} covered${degraded ? ' (DEGRADED: incomplete git history)' : ''}`
    );
    for (const f of result.flagged) {
      console.log(`  ⚠️  ${String(f.churn).padStart(4)}  ${f.path}  — no merge driver; needs a decision`);
    }
    if (result.flagged.length === 0) {
      console.log('  ✅ all high-churn tracked files are covered or exempt');
    }
    console.log(`[churn-merge-coverage] wrote ${opts.auditOut}`);
  }

  process.exit(result.summary.flaggedCount > 0 ? 1 : 0);
}

if (require.main === module) {
  main();
}

module.exports = { computeChurn, readMergeAttrs, historyComplete, parseArgs };
