#!/usr/bin/env node

/**
 * check-corpus-drift.js
 *
 * Passive monitor that runs the three CORPUS-STATISTICS audits and records a
 * single verdict to data/audit/corpus-drift.json. These audits assert on
 * properties of the live review corpus (full-text %, aggregator count ratios,
 * regex false-positive counts) that drift continuously as the CI bots commit
 * shows.json / reviews.json / review-texts every ~30 min. They are MONITORING
 * metrics, not code-correctness invariants, so they do NOT belong in the
 * blocking test.yml gate — when they flap, main goes red for non-code reasons,
 * the signal stops meaning anything, and real regressions hide in the noise.
 *
 * This script is the "separate non-blocking workflow" half of that split
 * (see .github/workflows/check-corpus-drift.yml), mirroring the established
 * check-review-count-drift.js / check-seo-health.js pattern: run daily +
 * after each rebuild, write a verdict JSON, and let scripts/health-check.js
 * surface it in the daily email digest. The catastrophe FLOOR (a genuine
 * quality collapse, not drift) stays blocking in test.yml via
 * `audit-text-quality.js --gate`.
 *
 * It runs each audit as a child process so the audit logic stays single-source
 * (no reimplementation/divergence) and records the exit code:
 *   - audit-text-quality.js        exit 0 = pass, 1 = threshold breach
 *   - validate-aggregator-truth.js exit 0 = ok/warnings, 1 = definite dup error
 *   - audit-regex-patterns.js      exit 0 = under threshold, 1 = over, 2 = scan failed
 *
 * Usage:
 *   node scripts/check-corpus-drift.js            # run audits, write json, exit 0
 *   node scripts/check-corpus-drift.js --strict   # exit 2 if any audit failed
 *   node scripts/check-corpus-drift.js --audit-out=PATH
 *
 * Exit codes:
 *   0 — always, unless --strict (this is a passive monitor; drift is not a job failure)
 *   2 — an audit reported a breach AND --strict
 *   3 — a child audit could not run at all (scan failed / crashed) — a real error
 *
 * Drift "breach" (ok:false) is NOT a workflow failure — it surfaces in the
 * digest. Only a child that cannot run (exit 3) or --strict escalates.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Locate sibling audit scripts relative to THIS file, but run them — and write
// the verdict — relative to the invocation cwd (the repo root in CI), so the
// audits resolve data/review-texts the same way they do when run standalone.
const SCRIPTS_DIR = __dirname;
const AUDIT_OUT_DEFAULT = path.join(process.cwd(), 'data', 'audit', 'corpus-drift.json');

// Each audit: how to run it and how to read its exit code. `crashCodes` are
// exit codes that mean "could not run" (a real error) vs "ran and found drift".
const AUDITS = [
  {
    name: 'text-quality',
    label: 'Review text quality (full/truncated/unknown %)',
    script: 'audit-text-quality.js',
    args: [],
    crashCodes: [],            // 0 pass / 1 drift; no distinct crash code
  },
  {
    name: 'aggregator-truth',
    label: 'Local vs aggregator review-count ratios',
    script: 'validate-aggregator-truth.js',
    args: [],
    crashCodes: [],            // 0 ok / 1 definite-duplicate drift
  },
  {
    name: 'regex-fp',
    label: 'content-quality regex false-positive rate',
    script: 'audit-regex-patterns.js',
    args: ['--full'],
    crashCodes: [2],           // 2 = scan failed (missing corpus / malformed)
  },
];

function runAudit(audit) {
  const scriptPath = path.join(SCRIPTS_DIR, audit.script);
  const res = spawnSync('node', [scriptPath, ...audit.args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const exitCode = res.status == null ? -1 : res.status;
  const crashed = exitCode === -1 || audit.crashCodes.includes(exitCode);
  const ok = exitCode === 0;
  // Keep the last ~40 lines of output as a digest-friendly detail snippet.
  const out = ((res.stdout || '') + (res.stderr || '')).trim();
  const tail = out.split('\n').slice(-40).join('\n');
  return {
    name: audit.name,
    label: audit.label,
    command: `node scripts/${audit.script}${audit.args.length ? ' ' + audit.args.join(' ') : ''}`,
    exitCode,
    ok,
    crashed,
    detail: tail,
  };
}

// Pure: assemble the verdict object from audit results. `now` injected for
// deterministic tests (Date is otherwise the only impurity).
function buildVerdict(auditResults, now) {
  const anyCrashed = auditResults.some((a) => a.crashed);
  const anyDrift = auditResults.some((a) => !a.ok && !a.crashed);
  return {
    _meta: {
      generatedAt: now,
      note: 'Corpus-statistics drift monitor. Non-blocking; surfaced via health-check.js digest. Not a code-correctness gate.',
    },
    summary: {
      auditsRun: auditResults.length,
      driftCount: auditResults.filter((a) => !a.ok && !a.crashed).length,
      crashCount: auditResults.filter((a) => a.crashed).length,
      anyDrift,
      anyCrashed,
    },
    audits: auditResults,
  };
}

// Pure: the exit-code policy. This is the load-bearing decision — drift is NOT
// a failure (it surfaces in the digest); only an audit that couldn't run, or
// drift under --strict, escalates.
//   3 — a child audit crashed / couldn't run (real error)
//   2 — drift detected AND --strict
//   0 — otherwise (passive monitor)
function decideExit({ anyCrashed, anyDrift, strict }) {
  if (anyCrashed) return 3;
  if (anyDrift && strict) return 2;
  return 0;
}

function main() {
  const argv = process.argv.slice(2);
  const strict = argv.includes('--strict');
  const outArg = argv.find((a) => a.startsWith('--audit-out='));
  const auditOut = outArg ? path.resolve(outArg.split('=')[1]) : AUDIT_OUT_DEFAULT;

  const audits = AUDITS.map(runAudit);
  const verdict = buildVerdict(audits, new Date().toISOString());

  fs.mkdirSync(path.dirname(auditOut), { recursive: true });
  fs.writeFileSync(auditOut, JSON.stringify(verdict, null, 2) + '\n');

  console.log(`[check-corpus-drift] wrote ${auditOut}`);
  for (const a of audits) {
    const status = a.crashed ? '💥 CRASHED' : a.ok ? '✅ ok' : '⚠️  drift';
    console.log(`  ${status}  ${a.name} (exit ${a.exitCode}) — ${a.label}`);
  }

  const code = decideExit({ ...verdict.summary, strict });
  if (code === 3) console.error('[check-corpus-drift] one or more audits could not run — investigate.');
  if (code === 2) console.error('[check-corpus-drift] drift detected and --strict set.');
  process.exit(code);
}

if (require.main === module) {
  main();
}

module.exports = { AUDITS, runAudit, buildVerdict, decideExit };
