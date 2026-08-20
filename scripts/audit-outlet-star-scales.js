#!/usr/bin/env node
/**
 * audit-outlet-star-scales.js
 *
 * Two modes:
 *   --mode=discover  (default) — Empirically discover each outlet's star scale
 *     from the denominator history in data/review-texts/*​/*.json. Output a
 *     classification: high-confidence (≥10 reviews, ≥80% same denominator),
 *     low-confidence, unknown.
 *
 *   --mode=mismatch  — Find reviews whose stored originalScore denominator
 *     disagrees with the registry's starScale for the outlet. Emit a
 *     JSONL queue for human triage.
 *
 *   --apply           — (discover mode) Write starScale to outlet-registry.json
 *     for high-confidence outlets.
 *
 * Background:
 * The Recs / Celebrity Autobiography (2026-05-20) shipped score 100 (Rave)
 * because Gemini parsed the article's "★★★★" as "4/4 stars". The Recs rates
 * out of 5 — bar 4 stars should normalize to 80. Add starScale to the
 * registry and pass it to parsers + LLM extractor as ground truth.
 */

const fs = require('fs');
const path = require('path');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');

const ROOT = path.join(__dirname, '..');
const REGISTRY_PATH = path.join(ROOT, 'data', 'outlet-registry.json');
// Read-only against review-texts (writes only go to REGISTRY_PATH/DISCOVER_OUT/
// MISMATCH_OUT) — see scripts/lib/review-texts-dir.js.
const REVIEW_TEXTS_DIR = resolveReviewTextsDir();
console.log(`[audit-outlet-star-scales] review-texts: ${REVIEW_TEXTS_DIR}`);
const DISCOVER_OUT = path.join(ROOT, 'data', 'audit', 'outlet-star-scales-discovered.json');
const MISMATCH_OUT = path.join(ROOT, 'data', 'audit', 'star-scale-mismatch-candidates.jsonl');

const HIGH_CONFIDENCE_MIN_REVIEWS = 10;
const HIGH_CONFIDENCE_MAJORITY = 0.80;
const LOW_CONFIDENCE_MIN_REVIEWS = 3;

// Match patterns:
//   "4/5 stars", "3.5/4 stars", "7/10 stars", "4/5"
//   "X out of Y stars"
//   "★★★★☆" — unicode (denominator inferred from filled+unfilled)
const DENOM_RE = /^(\d+(?:\.\d+)?)\s*(?:\/\s*(\d+)|out\s+of\s+(\d+))/i;

function detectDenominator(originalScore) {
  if (!originalScore) return null;
  const s = originalScore.toString().trim();
  // Skip letter grades, percentages, raw numeric
  if (/^[A-F][+-]?$/.test(s)) return null;
  if (/^\d+%$/.test(s)) return null;
  if (/^\d+(?:\.\d+)?$/.test(s)) return null;
  const m = s.match(DENOM_RE);
  if (m) {
    const denom = parseInt(m[2] || m[3], 10);
    if (denom > 0 && denom <= 100) return denom;
    return null;
  }
  // Unicode stars
  const filled = (s.match(/★/g) || []).length;
  const empty = (s.match(/☆/g) || []).length;
  if (filled > 0 && (filled + empty) <= 10) {
    return filled + empty || null;
  }
  return null;
}

function readReviewSafely(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch { return null; }
}

function gatherDenominatorsByOutlet() {
  if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
    console.error(`Review-texts directory not found: ${REVIEW_TEXTS_DIR}`);
    console.error('This script must run locally (review-texts is in a private repo).');
    process.exit(1);
  }
  const byOutlet = new Map(); // outletId → { '5': 12, '4': 3, ... }
  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR).filter((s) => !s.startsWith('.') && !s.startsWith('_'));
  for (const showId of showDirs) {
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    let stat; try { stat = fs.statSync(showDir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    let files; try { files = fs.readdirSync(showDir).filter((f) => f.endsWith('.json')); } catch { continue; }
    for (const f of files) {
      const d = readReviewSafely(path.join(showDir, f));
      if (!d || !d.outletId) continue;
      const denom = detectDenominator(d.originalScore);
      if (denom == null) continue;
      const map = byOutlet.get(d.outletId) || {};
      map[denom] = (map[denom] || 0) + 1;
      byOutlet.set(d.outletId, map);
    }
  }
  return byOutlet;
}

function classifyOutlet(denoms) {
  const entries = Object.entries(denoms).map(([k, v]) => [parseInt(k, 10), v]);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  entries.sort((a, b) => b[1] - a[1]);
  const [topDenom, topCount] = entries[0];
  const topShare = topCount / total;

  if (total >= HIGH_CONFIDENCE_MIN_REVIEWS && topShare >= HIGH_CONFIDENCE_MAJORITY) {
    return { confidence: 'high', starScale: topDenom, total, topShare: Number(topShare.toFixed(3)), distribution: Object.fromEntries(entries) };
  }
  if (total >= LOW_CONFIDENCE_MIN_REVIEWS) {
    return { confidence: 'low', starScale: topDenom, total, topShare: Number(topShare.toFixed(3)), distribution: Object.fromEntries(entries) };
  }
  return { confidence: 'unknown', starScale: null, total, topShare: Number(topShare.toFixed(3)), distribution: Object.fromEntries(entries) };
}

function modeDiscover(apply) {
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
  const outlets = registry.outlets;
  const byOutlet = gatherDenominatorsByOutlet();

  const classification = { high: [], low: [], unknown: [] };
  for (const [outletId, denoms] of byOutlet) {
    if (!outlets[outletId]) continue; // skip outlets not in registry
    const c = classifyOutlet(denoms);
    classification[c.confidence].push({ outletId, displayName: outlets[outletId].displayName, tier: outlets[outletId].tier, currentStarScale: outlets[outletId].starScale || null, ...c });
  }
  for (const k of Object.keys(classification)) {
    classification[k].sort((a, b) => b.total - a.total);
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    thresholds: { HIGH_CONFIDENCE_MIN_REVIEWS, HIGH_CONFIDENCE_MAJORITY, LOW_CONFIDENCE_MIN_REVIEWS },
    counts: { high: classification.high.length, low: classification.low.length, unknown: classification.unknown.length },
    classification,
  };

  fs.mkdirSync(path.dirname(DISCOVER_OUT), { recursive: true });
  fs.writeFileSync(DISCOVER_OUT, JSON.stringify(summary, null, 2) + '\n');

  console.log(`=== Outlet star-scale discovery ===\n`);
  console.log(`Total outlets with star ratings: ${classification.high.length + classification.low.length + classification.unknown.length}`);
  console.log(`  high confidence:    ${classification.high.length}`);
  console.log(`  low confidence:     ${classification.low.length}`);
  console.log(`  unknown (insufficient data): ${classification.unknown.length}`);
  console.log(`\nOutput: ${path.relative(ROOT, DISCOVER_OUT)}\n`);

  console.log(`=== HIGH confidence (will get starScale if --apply) ===`);
  for (const r of classification.high) {
    const flag = r.currentStarScale != null && r.currentStarScale !== r.starScale ? ' ⚠️ CONFLICT' : '';
    console.log(`  ${r.outletId.padEnd(40)} starScale=${r.starScale}  (${r.total} reviews, ${(r.topShare * 100).toFixed(0)}% same denom)${flag}`);
  }

  console.log(`\n=== LOW confidence (manual review recommended) ===`);
  for (const r of classification.low.slice(0, 15)) {
    console.log(`  ${r.outletId.padEnd(40)} top=${r.starScale}  (${r.total} reviews, ${(r.topShare * 100).toFixed(0)}% same denom, distribution: ${JSON.stringify(r.distribution)})`);
  }
  if (classification.low.length > 15) console.log(`  ... and ${classification.low.length - 15} more`);

  if (apply) {
    console.log(`\n=== --apply: writing starScale to registry for HIGH confidence outlets ===`);
    let changed = 0;
    let skipped = 0;
    for (const r of classification.high) {
      const entry = outlets[r.outletId];
      if (entry.starScale === r.starScale) { skipped++; continue; }
      if (entry.starScale != null && entry.starScale !== r.starScale) {
        console.log(`  SKIP ${r.outletId}: existing starScale=${entry.starScale} disagrees with audit=${r.starScale}`);
        skipped++;
        continue;
      }
      entry.starScale = r.starScale;
      console.log(`  ${r.outletId}: starScale=${r.starScale}`);
      changed++;
    }
    if (changed > 0) {
      fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n');
      console.log(`\n  Wrote ${changed} updates to ${path.relative(ROOT, REGISTRY_PATH)} (${skipped} skipped — already set or conflict)`);
      console.log(`  REMINDER: per memory/feedback_outlet_registry_dual_repo.md, commit to broadway-scorecard-data FIRST.`);
    } else {
      console.log(`\n  No changes (${skipped} skipped).`);
    }
  }
}

function modeMismatch() {
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
  const outlets = registry.outlets;
  if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
    console.error(`Review-texts directory not found: ${REVIEW_TEXTS_DIR}`);
    process.exit(1);
  }

  const suspects = [];
  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR).filter((s) => !s.startsWith('.') && !s.startsWith('_'));
  for (const showId of showDirs) {
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    let stat; try { stat = fs.statSync(showDir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    let files; try { files = fs.readdirSync(showDir).filter((f) => f.endsWith('.json')); } catch { continue; }
    for (const f of files) {
      const d = readReviewSafely(path.join(showDir, f));
      if (!d || !d.outletId) continue;
      const denom = detectDenominator(d.originalScore);
      if (denom == null) continue;
      const entry = outlets[d.outletId];
      if (!entry || !entry.starScale) continue;
      if (denom !== entry.starScale) {
        suspects.push({
          showId, file: f, outletId: d.outletId, criticName: d.criticName,
          url: d.url || null, originalScore: d.originalScore,
          storedDenominator: denom, registryStarScale: entry.starScale,
          assignedScore: d.assignedScore || d.llmScore?.score || null,
        });
      }
    }
  }

  fs.mkdirSync(path.dirname(MISMATCH_OUT), { recursive: true });
  fs.writeFileSync(MISMATCH_OUT, suspects.map((s) => JSON.stringify(s)).join('\n') + '\n');

  console.log(`Star-scale mismatch candidates: ${suspects.length}`);
  const byOutlet = new Map();
  for (const s of suspects) {
    if (!byOutlet.has(s.outletId)) byOutlet.set(s.outletId, []);
    byOutlet.get(s.outletId).push(s);
  }
  for (const [outletId, list] of byOutlet) {
    const registryScale = outlets[outletId].starScale;
    console.log(`\n${outletId} (registry starScale=${registryScale}) — ${list.length} suspects`);
    for (const s of list.slice(0, 10)) {
      console.log(`  ${s.showId} | "${s.originalScore}" (parsed denom=${s.storedDenominator}) | score=${s.assignedScore}`);
    }
    if (list.length > 10) console.log(`  ... and ${list.length - 10} more`);
  }
  console.log(`\nOutput: ${path.relative(ROOT, MISMATCH_OUT)}`);
  console.log('NOT auto-applied. Manual triage per row.');
}

function main() {
  const args = process.argv.slice(2);
  const mode = args.find((a) => a.startsWith('--mode='))?.split('=')[1] || 'discover';
  const apply = args.includes('--apply');

  if (mode === 'discover') modeDiscover(apply);
  else if (mode === 'mismatch') modeMismatch();
  else {
    console.error(`Unknown mode: ${mode}. Use --mode=discover or --mode=mismatch.`);
    process.exit(1);
  }
}

main();
