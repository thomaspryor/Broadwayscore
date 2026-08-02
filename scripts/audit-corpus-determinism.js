#!/usr/bin/env node
/**
 * Corpus determinism audit (task #653) — read-only.
 *
 * Reconstructs the reviewCount history from git's record of
 * data/audit/deploy-watermark.json and reports how often the published corpus
 * moved DOWN, and how often it made a transient excursion (baseline → spike →
 * baseline) — the signature of a reviews.json published from review-texts state
 * that the PROTECTED_FIELDS restore then undid.
 *
 * Acceptance command for the #653 card:
 *   node scripts/audit-corpus-determinism.js --since-hours=48 --gate
 *
 * Read-only: only `git log` / `git show` on this repo, plus an optional JSON
 * report write under data/audit/.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { buildReport, evaluateGate, DEFAULT_MIN_DELTA, DEFAULT_TOLERANCE } = require('./lib/corpus-determinism.js');

const WATERMARK_PATH = 'data/audit/deploy-watermark.json';
const DEFAULT_REPORT_PATH = path.join(__dirname, '../data/audit/corpus-determinism.json');

const USAGE = `
audit-corpus-determinism.js — is the published review corpus deterministic?

Usage:
  node scripts/audit-corpus-determinism.js [options]

Options:
  --since-hours=N      Window of watermark history to analyse (default 48)
  --last=N             Cap to the most recent N samples (default: no cap)
  --min-delta=N        Swing size treated as material, in reviews (default ${DEFAULT_MIN_DELTA})
  --tolerance=N        "Came back to where it started" slack (default ${DEFAULT_TOLERANCE})
  --max-decreases=N    Gate limit on material decreases (default 10)
  --gate               Exit 1 when the gate fails (for CI / acceptance recheck)
  --json               Print the raw report as JSON
  --report-out=PATH    Write the report JSON (default data/audit/corpus-determinism.json)
  --no-report          Skip the report write
  --help               Show this message

Reads git history only — never mutates review data.
`.trim();

function parseArgs(argv) {
  const num = (name, dflt) => {
    const hit = argv.find(a => a.startsWith(`--${name}=`));
    if (!hit) return dflt;
    const v = Number(hit.split('=')[1]);
    return Number.isFinite(v) ? v : dflt;
  };
  const outHit = argv.find(a => a.startsWith('--report-out='));
  return {
    sinceHours: num('since-hours', 48),
    last: num('last', 0),
    minDelta: num('min-delta', DEFAULT_MIN_DELTA),
    tolerance: num('tolerance', DEFAULT_TOLERANCE),
    maxDecreases: num('max-decreases', 10),
    gate: argv.includes('--gate'),
    json: argv.includes('--json'),
    noReport: argv.includes('--no-report'),
    reportOut: outHit ? outHit.split('=')[1] : DEFAULT_REPORT_PATH,
  };
}

/**
 * Read the watermark reviewCount at each commit that touched it.
 *
 * Uses `git log -p` (one process) rather than a `git show` per commit — the
 * file changes thousands of times a month and per-commit spawns took minutes.
 */
function loadWatermarkHistory(sinceHours) {
  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim();
  const patch = execFileSync(
    'git',
    ['log', `--since=${sinceHours} hours ago`, '-p', '--format=@@@%H|%ct|%s', '--', WATERMARK_PATH],
    { cwd: repoRoot, encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 },
  );

  const samples = [];
  let cur = null;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@@')) {
      if (cur && cur.rc != null) samples.push(cur);
      const [sha, ct, ...rest] = line.slice(3).split('|');
      cur = { sha, t: Number(ct), subj: rest.join('|'), rc: null };
      continue;
    }
    if (!cur) continue;
    // Only the ADDED side of the hunk — that is the value this commit published.
    const m = line.match(/^\+\s*"reviewCount":\s*(\d+)/);
    if (m) cur.rc = Number(m[1]);
  }
  if (cur && cur.rc != null) samples.push(cur);

  // git log is newest-first; the analysis wants ascending time.
  samples.reverse();
  return samples;
}

function main() {
  if (hasHelpFlag(process.argv.slice(2))) {
    console.log(USAGE);
    return 0;
  }
  const opts = parseArgs(process.argv.slice(2));

  let samples = loadWatermarkHistory(opts.sinceHours);
  if (opts.last > 0 && samples.length > opts.last) samples = samples.slice(-opts.last);

  if (samples.length < 3) {
    console.log(
      `⚠️  Only ${samples.length} watermark sample(s) in the last ${opts.sinceHours}h — not enough history to judge determinism.`,
    );
    console.log('   (Expected on a fresh clone or a shallow checkout: this reads local git history.)');
    return 0;
  }

  const report = buildReport(samples, { minDelta: opts.minDelta, tolerance: opts.tolerance });
  const gate = evaluateGate(report, { maxMaterialDecreases: opts.maxDecreases });

  if (opts.json) {
    console.log(JSON.stringify({ ...report, gate, windowHours: opts.sinceHours }, null, 2));
  } else {
    const first = new Date(samples[0].t * 1000).toISOString();
    const lastT = new Date(samples[samples.length - 1].t * 1000).toISOString();
    console.log(`Corpus determinism — ${samples.length} watermark samples, ${first} → ${lastT}`);
    console.log(`  transitions:           ${report.transitions}`);
    console.log(`  decreases (any size):  ${report.decreases}`);
    console.log(`  decreases >= ${report.minDelta}:      ${report.materialDecreases}   ← the flap`);
    console.log(`  worst single drop:     ${report.worstDrop}`);
    console.log(`  reviewCount range:     ${report.minReviewCount} … ${report.maxReviewCount}`);
    console.log(`  transient excursions:  ${report.transientExcursions} (exact reverts: ${report.exactReverts})`);
    for (const e of report.excursionDetail.slice(0, 10)) {
      console.log(
        `     ${new Date(e.t * 1000).toISOString()}  ${e.before} → ${e.spike} → ${e.after}` +
          `  (${e.delta > 0 ? '+' : ''}${e.delta})  ${String(e.subj || '').slice(0, 60)}`,
      );
    }
    console.log(gate.pass ? '\n✅ PASS — corpus is deterministic over this window' : '\n❌ FAIL');
    for (const f of gate.failures) console.log(`   - ${f}`);
  }

  if (!opts.noReport) {
    try {
      fs.mkdirSync(path.dirname(opts.reportOut), { recursive: true });
      fs.writeFileSync(
        opts.reportOut,
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            windowHours: opts.sinceHours,
            gate,
            ...report,
          },
          null,
          2,
        ) + '\n',
      );
    } catch (e) {
      console.warn(`⚠️  Could not write report to ${opts.reportOut}: ${e.message}`);
    }
  }

  return opts.gate && !gate.pass ? 1 : 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { loadWatermarkHistory, parseArgs };
