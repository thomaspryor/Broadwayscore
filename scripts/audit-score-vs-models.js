#!/usr/bin/env node
/**
 * audit-score-vs-models.js (BRO-4596)
 *
 * Standing check for published review scores that disagree with the model
 * reading: |getBestScore - median(claude, openai, gemini)| >= 25 AND a bucket
 * flip. Human overrides, excluded rows and single-model records are skipped.
 * Decision logic lives in scripts/lib/score-vs-models.js (pure, unit-tested).
 *
 * NON-BLOCKING by design: always exits 0 on a completed scan, so the weekly
 * workflow shows a count and a rise (new vs baseline) without failing the run.
 * A missing or empty corpus exits 2 instead, via assertCorpusScanned, so a
 * private-repo checkout that silently came up empty cannot read as "0 found".
 *
 * Baseline is a committed per-finding key list (not a bare count: one fixed
 * and one new would net to zero). Without a baseline file every finding is new.
 *
 * USAGE:
 *   node scripts/audit-score-vs-models.js                  report total / baselined / new
 *   node scripts/audit-score-vs-models.js --write-baseline snapshot current findings
 *   node scripts/audit-score-vs-models.js --json           machine-readable
 *   node scripts/audit-score-vs-models.js --show=<id>      one show
 *   node scripts/audit-score-vs-models.js --gap=30         override the 25-point gap
 * Env: REVIEW_TEXTS_DIR, SCORE_VS_MODELS_BASELINE override the two paths.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');
const { assertCorpusScanned, CorpusNotScannedError } = require('./lib/corpus-scan-guard');
const { hasHelpFlag } = require('./lib/cli-help');
const { evaluateScoreVsModels, keyOf, DEFAULT_GAP } = require('./lib/score-vs-models');

const ROOT = path.resolve(__dirname, '..');
const reviewTextsRoot = () => process.env.REVIEW_TEXTS_DIR || path.join(ROOT, 'data', 'review-texts');
const baselinePath = () => process.env.SCORE_VS_MODELS_BASELINE || path.join(ROOT, 'data', 'audit', 'score-vs-models-baseline.json');

function loadBaselineKeys() {
  try {
    const d = JSON.parse(fs.readFileSync(baselinePath(), 'utf8'));
    return { present: true, keys: new Set(Array.isArray(d.keys) ? d.keys : []) };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { present: false, keys: new Set() };
    // A corrupt baseline must not read as "no baseline" (everything new, silently).
    console.error(`FAIL: baseline unreadable (${baselinePath()}): ${e.message}`);
    process.exit(2);
  }
}

/** Scan a review-texts root. Exported for the unit test. */
function scan(root, { gap = DEFAULT_GAP, shows } = {}) {
  const findings = [];
  let scanned = 0;
  for (const showId of shows || listShowDirs(root)) {
    let files;
    try { files = fs.readdirSync(path.join(root, showId)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      let r;
      try { r = JSON.parse(fs.readFileSync(path.join(root, showId, f), 'utf8')); } catch { continue; }
      scanned++;
      const hit = evaluateScoreVsModels(r, { gap });
      if (hit) findings.push({ showId, file: f, outlet: r.outlet || r.outletId || '', ...hit });
    }
  }
  findings.sort((a, b) => b.gap - a.gap);
  return { scanned, findings };
}

function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) {
    console.log('Usage: node scripts/audit-score-vs-models.js [--write-baseline] [--json] [--show=<id>] [--gap=N]\nReports published review scores that disagree with the model reading (read-only except --write-baseline).');
    return;
  }
  const get = (p) => (argv.find((a) => a.startsWith(p)) || '').slice(p.length);
  const gap = get('--gap=') ? parseFloat(get('--gap=')) : DEFAULT_GAP;
  const show = get('--show=') || null;
  if (Number.isNaN(gap)) { console.error('Bad --gap'); process.exit(2); }

  const root = reviewTextsRoot();
  const rootMissing = !fs.existsSync(root);
  let result = { scanned: 0, findings: [] };
  if (!rootMissing) result = scan(root, { gap, shows: show ? [show] : undefined });
  try {
    assertCorpusScanned(result.scanned, { gate: !show, label: root, corpusRootMissing: rootMissing });
  } catch (e) {
    if (!(e instanceof CorpusNotScannedError)) throw e;
    console.error(`FAIL: ${e.message}`);
    process.exit(2);
  }
  const { scanned, findings } = result;

  if (argv.includes('--write-baseline')) {
    const p = baselinePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({
      _meta: { description: 'Known/triaged published-score-vs-model gaps (BRO-4596). Regenerate after triage: node scripts/audit-score-vs-models.js --write-baseline', gap, count: findings.length },
      keys: findings.map(keyOf).sort(),
    }, null, 2) + '\n');
    console.log(`Wrote baseline: ${findings.length} findings → ${p}`);
    return;
  }

  const base = loadBaselineKeys();
  const fresh = findings.filter((f) => !base.keys.has(keyOf(f)));
  const out = { scanned, gap, total: findings.length, baselined: findings.length - fresh.length, new: fresh.length, baselineFile: base.present, findings: fresh };
  if (argv.includes('--json')) { console.log(JSON.stringify(out, null, 2)); return; }
  console.log(`Score-vs-models audit (gap>=${gap} + bucket flip): ${out.total} flagged / ${scanned} reviews scanned; ${out.baselined} baselined, ${out.new} new${base.present ? '' : ' (no baseline file yet, everything counts as new)'}`);
  for (const f of fresh.slice(0, 40)) console.log(`  gap ${f.gap}\t${f.showId}/${f.file}\tpublished=${f.score} (${f.source}) models=${f.median}`);
  if (fresh.length > 40) console.log(`  … ${fresh.length - 40} more (use --json)`);
}

if (require.main === module) main();
module.exports = { scan };
