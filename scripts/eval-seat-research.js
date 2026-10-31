#!/usr/bin/env node

/**
 * Seat-research eval harness
 *
 * Aggregates adjudicator output across a batch of theaters (typically the test
 * set in data/seat-research-eval/test-set.json) and produces a single score
 * for a given prompt version. Append-only history log lets you compare
 * prompt iterations over time.
 *
 * Workflow:
 *   1. Run research prompt against test set (manual via Task tool / subagents)
 *   2. For each theater: node scripts/adjudicate-seat-research.js /tmp/{slug}-research.json
 *      → produces /tmp/{slug}-research-audit.json per theater
 *   3. Run this aggregator:
 *      node scripts/eval-seat-research.js \
 *        --prompt-version=v1 \
 *        --audits /tmp/majestic-research-audit.json /tmp/music-box-research-audit.json /tmp/...
 *      (or: --audits-dir /tmp to auto-pick *-research-audit.json)
 *   4. Stats written to data/seat-research-eval/results/{YYYYMMDD-HHMM}-{prompt}.json
 *      and appended to data/seat-research-eval/history.jsonl
 *   5. To compare two prompt versions: node scripts/eval-seat-research.js --compare v1 v2
 *
 * Exit codes:
 *   0  — aggregate produced
 *   1  — usage / setup error
 */

import fs from 'fs';
import pathMod from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathMod.dirname(__filename);
const ROOT = pathMod.resolve(__dirname, '..');
const EVAL_DIR = pathMod.join(ROOT, 'data', 'seat-research-eval');
const HISTORY_FILE = pathMod.join(EVAL_DIR, 'history.jsonl');
const RESULTS_DIR = pathMod.join(EVAL_DIR, 'results');

function getArg(name) {
  const needle = `--${name}=`;
  const flag = process.argv.find((a) => a.startsWith(needle));
  if (flag) return flag.slice(needle.length);
  // Also accept space-separated: --name value
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < process.argv.length && !process.argv[idx + 1].startsWith('--')) {
    return process.argv[idx + 1];
  }
  return null;
}

function getListArg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return [];
  const list = [];
  for (let i = idx + 1; i < process.argv.length; i++) {
    if (process.argv[i].startsWith('--')) break;
    list.push(process.argv[i]);
  }
  return list;
}

function loadAudits(auditPaths) {
  const audits = [];
  for (const p of auditPaths) {
    if (!fs.existsSync(p)) {
      console.warn(`⚠  missing: ${p}`);
      continue;
    }
    try {
      audits.push(JSON.parse(fs.readFileSync(p, 'utf8')));
    } catch (e) {
      console.warn(`⚠  bad JSON: ${p} (${e.message})`);
    }
  }
  return audits;
}

function aggregateAudit(audits) {
  const totals = {
    theaters_total: audits.length,
    theaters_with_errors: 0,
    sections_total: 0,
    sections_by_support: { STRONG: 0, MODERATE: 0, WEAK: 0, UNSUPPORTED: 0, ERROR: 0 },
    claims_total: 0,
    claims_by_support: { STRONG: 0, MODERATE: 0, WEAK: 0, UNSUPPORTED: 0 },
    warnings_total: 0,
    urls_fetched_total: 0,
    urls_failed_total: 0,
    unsupported_claims_examples: [],
  };

  const perTheater = [];

  for (const audit of audits) {
    const t = {
      theater: audit.theater,
      sections_total: audit.sections_total,
      sections_audited: audit.sections_audited,
      sections_by_support: { STRONG: 0, MODERATE: 0, WEAK: 0, UNSUPPORTED: 0, ERROR: 0 },
      warnings: 0,
      unsupported_claims: 0,
    };

    for (const r of audit.results || []) {
      totals.sections_total += 1;
      if (r.error) {
        t.sections_by_support.ERROR += 1;
        totals.sections_by_support.ERROR += 1;
        continue;
      }
      const lvl = r.verdict_support;
      if (lvl) {
        t.sections_by_support[lvl] = (t.sections_by_support[lvl] || 0) + 1;
        totals.sections_by_support[lvl] = (totals.sections_by_support[lvl] || 0) + 1;
      }
      t.warnings += (r.warnings?.length || 0);
      totals.warnings_total += (r.warnings?.length || 0);
      totals.urls_fetched_total += (r.urls_fetched || 0);
      totals.urls_failed_total += (r.urls_failed || 0);

      for (const c of r.claim_results || []) {
        totals.claims_total += 1;
        const clvl = c.support;
        if (clvl) totals.claims_by_support[clvl] = (totals.claims_by_support[clvl] || 0) + 1;
        if (clvl === 'UNSUPPORTED') {
          t.unsupported_claims += 1;
          if (totals.unsupported_claims_examples.length < 10) {
            totals.unsupported_claims_examples.push({
              theater: audit.theater,
              section: r.section,
              note: c.note,
            });
          }
        }
      }
    }
    if (t.sections_by_support.ERROR > 0) totals.theaters_with_errors += 1;
    perTheater.push(t);
  }

  return { totals, perTheater };
}

function scoreBoard(totals) {
  // A composite 0-100 score — higher = cleaner research.
  // Sections: STRONG=1.0, MODERATE=0.7, WEAK=0.3, UNSUPPORTED/ERROR=0
  // Claims: same scale
  // Penalty: -1 per warning (max -20)
  const s = totals.sections_by_support;
  const c = totals.claims_by_support;
  const sectionPts = s.STRONG * 1.0 + s.MODERATE * 0.7 + s.WEAK * 0.3;
  const sectionMax = totals.sections_total;
  const sectionScore = sectionMax > 0 ? (sectionPts / sectionMax) * 50 : 0;

  const claimPts = c.STRONG * 1.0 + c.MODERATE * 0.7 + c.WEAK * 0.3;
  const claimMax = totals.claims_total;
  const claimScore = claimMax > 0 ? (claimPts / claimMax) * 50 : 0;

  const warningPenalty = Math.min(totals.warnings_total, 20);
  const composite = Math.max(0, sectionScore + claimScore - warningPenalty);
  return { composite: Math.round(composite * 10) / 10, sectionScore: Math.round(sectionScore * 10) / 10, claimScore: Math.round(claimScore * 10) / 10, warningPenalty };
}

function printReport({ totals, perTheater }, promptVersion) {
  const score = scoreBoard(totals);
  console.log(`\n═══ Seat-research eval report — ${promptVersion || '(no version tag)'} ═══`);
  console.log(`   ${totals.theaters_total} theater(s), ${totals.sections_total} section(s), ${totals.claims_total} claim(s)`);
  console.log(`   URLs fetched: ${totals.urls_fetched_total} (${totals.urls_failed_total} failed)`);
  console.log();
  console.log(`   COMPOSITE SCORE: ${score.composite}/100`);
  console.log(`     section score:   ${score.sectionScore}/50`);
  console.log(`     claim score:     ${score.claimScore}/50`);
  console.log(`     warning penalty: -${score.warningPenalty}`);
  console.log();
  console.log('   Sections by verdict-support:');
  for (const [lvl, n] of Object.entries(totals.sections_by_support)) {
    if (n > 0) console.log(`     ${lvl.padEnd(12)} ${n}/${totals.sections_total}`);
  }
  console.log();
  console.log('   Claims by support:');
  for (const [lvl, n] of Object.entries(totals.claims_by_support)) {
    if (n > 0) console.log(`     ${lvl.padEnd(12)} ${n}/${totals.claims_total}`);
  }
  console.log();
  console.log(`   Warnings total: ${totals.warnings_total}`);

  if (totals.unsupported_claims_examples.length > 0) {
    console.log('\n   ❌ UNSUPPORTED claim examples:');
    for (const ex of totals.unsupported_claims_examples.slice(0, 5)) {
      console.log(`     — ${ex.theater} / ${ex.section}: ${ex.note}`);
    }
  }

  console.log('\n   Per-theater:');
  for (const t of perTheater) {
    const tScore = scoreBoard({
      sections_total: t.sections_total || 0,
      sections_by_support: t.sections_by_support,
      claims_total: 0,
      claims_by_support: { STRONG: 0, MODERATE: 0, WEAK: 0, UNSUPPORTED: 0 },
      warnings_total: t.warnings,
    });
    const breakdown = Object.entries(t.sections_by_support)
      .filter(([, n]) => n > 0)
      .map(([l, n]) => `${l[0]}${n}`)
      .join(' ');
    console.log(`     ${t.theater.padEnd(30)} ${breakdown.padEnd(20)} warnings=${t.warnings} unsupported=${t.unsupported_claims}`);
  }
}

function saveResults({ totals, perTheater }, promptVersion) {
  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const score = scoreBoard(totals);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const filename = `${ts}-${promptVersion || 'untagged'}.json`;
  const out = pathMod.join(RESULTS_DIR, filename);
  const payload = {
    promptVersion: promptVersion || null,
    timestamp: new Date().toISOString(),
    score,
    totals,
    perTheater,
  };
  fs.writeFileSync(out, JSON.stringify(payload, null, 2));

  // Append to history jsonl for trend tracking
  const historyLine = JSON.stringify({
    timestamp: payload.timestamp,
    promptVersion: payload.promptVersion,
    composite: score.composite,
    theaters: totals.theaters_total,
    sections: totals.sections_total,
    claims: totals.claims_total,
    unsupported_sections: totals.sections_by_support.UNSUPPORTED,
    unsupported_claims: totals.claims_by_support.UNSUPPORTED,
    warnings: totals.warnings_total,
  });
  fs.appendFileSync(HISTORY_FILE, historyLine + '\n');

  console.log(`\n📝 Saved: ${pathMod.relative(ROOT, out)}`);
  console.log(`📈 Appended to: ${pathMod.relative(ROOT, HISTORY_FILE)}`);
}

function compareVersions(a, b) {
  if (!fs.existsSync(HISTORY_FILE)) {
    console.error(`No history file at ${HISTORY_FILE}. Run aggregator at least once first.`);
    process.exit(1);
  }
  const lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean);
  const entries = lines.map((l) => JSON.parse(l));
  const runsA = entries.filter((e) => e.promptVersion === a);
  const runsB = entries.filter((e) => e.promptVersion === b);
  if (runsA.length === 0 || runsB.length === 0) {
    console.error(`Need at least one run each for ${a} and ${b}. Have: ${a}=${runsA.length}, ${b}=${runsB.length}.`);
    console.log('\nAvailable versions in history:');
    const versions = [...new Set(entries.map((e) => e.promptVersion))];
    for (const v of versions) console.log(`   ${v} (${entries.filter((e) => e.promptVersion === v).length} run(s))`);
    process.exit(1);
  }
  const latestA = runsA[runsA.length - 1];
  const latestB = runsB[runsB.length - 1];
  console.log(`\n═══ Compare ${a} → ${b} ═══\n`);
  const fields = ['composite', 'unsupported_sections', 'unsupported_claims', 'warnings'];
  console.log(`   ${'metric'.padEnd(24)} ${a.padEnd(10)} ${b.padEnd(10)} ${'delta'.padEnd(10)}`);
  console.log(`   ${'-'.repeat(58)}`);
  for (const f of fields) {
    const va = latestA[f] ?? 0;
    const vb = latestB[f] ?? 0;
    const delta = vb - va;
    const arrow = delta > 0 ? '▲' : delta < 0 ? '▼' : ' ';
    const goodDirection = f === 'composite' ? delta > 0 : delta < 0;
    const marker = delta === 0 ? ' ' : goodDirection ? '✓' : '⚠';
    console.log(`   ${f.padEnd(24)} ${String(va).padEnd(10)} ${String(vb).padEnd(10)} ${arrow}${delta >= 0 ? '+' : ''}${delta} ${marker}`);
  }
}

function main() {
  // Mode: compare
  if (process.argv.includes('--compare')) {
    const idx = process.argv.indexOf('--compare');
    const a = process.argv[idx + 1];
    const b = process.argv[idx + 2];
    if (!a || !b) {
      console.error('Usage: --compare v1 v2');
      process.exit(1);
    }
    compareVersions(a, b);
    return;
  }

  // Mode: aggregate
  let auditPaths = getListArg('audits');
  const dir = getArg('audits-dir');
  if (dir) {
    const entries = fs.readdirSync(dir).filter((f) => f.endsWith('-research-audit.json'));
    auditPaths = entries.map((f) => pathMod.join(dir, f));
  }
  if (auditPaths.length === 0) {
    console.error(`Usage: eval-seat-research.js --prompt-version=v1 --audits <path>... [--audits-dir <dir>]`);
    console.error(`       eval-seat-research.js --compare v1 v2`);
    process.exit(1);
  }
  const promptVersion = getArg('prompt-version');
  const audits = loadAudits(auditPaths);
  if (audits.length === 0) {
    console.error('No valid audit files loaded.');
    process.exit(1);
  }
  const report = aggregateAudit(audits);
  printReport(report, promptVersion);
  saveResults(report, promptVersion);
}

main();
