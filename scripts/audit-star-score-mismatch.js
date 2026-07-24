#!/usr/bin/env node
/**
 * audit-star-score-mismatch.js
 *
 * Scans review-texts for reviews whose EXPLICIT published rating (star / letter
 * grade / fraction) contradicts the site's independent reads (LLM ensemble +
 * assignedScore) beyond a threshold. Catches the class where a rating is
 * mis-extracted (e.g. the wrong show's star grabbed off a combined multi-show
 * review column — the Birthright/Theater Life case, card #396) and then wins
 * score-routing, silently mis-scoring the review on the live site.
 *
 * Decision logic lives in scripts/lib/star-score-mismatch.js (pure, unit-tested).
 *
 * BASELINE MODEL: a time window is the wrong filter here — Birthright's review
 * was mis-extracted 19 days before the user noticed. Instead we baseline the
 * known/triaged backlog (data/audit/star-score-mismatch-baseline.json) and the
 * daily health check alerts only on findings NOT in the baseline (genuinely new
 * mismatches). Same posture as scrapingbee-ack / SEO post-fix grace.
 *
 * USAGE:
 *   node scripts/audit-star-score-mismatch.js                 # NEW mismatches (not baselined); exit 1 if any
 *   node scripts/audit-star-score-mismatch.js --all           # whole corpus, ignore baseline (audit mode, exit 0)
 *   node scripts/audit-star-score-mismatch.js --write-baseline# snapshot current findings into the baseline file
 *   node scripts/audit-star-score-mismatch.js --threshold=40  # override gap threshold
 *   node scripts/audit-star-score-mismatch.js --json          # machine-readable output
 *   node scripts/audit-star-score-mismatch.js --show=<id>     # single show
 *
 * EXIT CODES: 0 = no new mismatches (or --all audit mode / --write-baseline).
 * 1 = new (non-baselined) mismatches found. 2 = usage/error.
 */

const fs = require('fs');
const path = require('path');
const { scanReviewTexts, keyOf, DEFAULT_THRESHOLD } = require('./lib/star-score-mismatch');

function parseArgs(argv) {
  const args = { all: false, json: false, threshold: DEFAULT_THRESHOLD, show: null, writeBaseline: false };
  for (const a of argv) {
    if (a === '--help' || a === '-h') { args.help = true; }
    else if (a === '--all') { args.all = true; }
    else if (a === '--json') { args.json = true; }
    else if (a === '--write-baseline') { args.writeBaseline = true; }
    else if (a.startsWith('--threshold=')) { args.threshold = parseFloat(a.slice(12)); }
    else if (a.startsWith('--show=')) { args.show = a.slice(7); }
  }
  return args;
}

function usage() {
  console.log(`audit-star-score-mismatch.js — flag reviews whose explicit rating contradicts the site score.

  (default)          list NEW mismatches (not in the baseline); exit 1 if any
  --all              whole corpus, ignore baseline (audit mode; always exit 0)
  --write-baseline   snapshot ALL current findings into the baseline file (one-time / after triage)
  --show=<id>        scan a single show directory
  --threshold=<n>    gap threshold in points (default ${DEFAULT_THRESHOLD})
  --json             machine-readable output
  -h, --help         this help

Baseline file: data/audit/star-score-mismatch-baseline.json`);
}

// review-texts lives only in the private data clone; resolve from repo root.
// REVIEW_TEXTS_DIR overrides for cross-repo runs (this code in a worktree
// pointing at the main clone's private data) and for tests.
function reviewTextsRoot() {
  if (process.env.REVIEW_TEXTS_DIR) return process.env.REVIEW_TEXTS_DIR;
  return path.join(path.resolve(__dirname, '..'), 'data', 'review-texts');
}
function baselinePath() {
  if (process.env.STAR_MISMATCH_BASELINE) return process.env.STAR_MISMATCH_BASELINE;
  return path.join(path.resolve(__dirname, '..'), 'data', 'audit', 'star-score-mismatch-baseline.json');
}
function loadBaselineKeys() {
  const p = baselinePath();
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return new Set(Array.isArray(data.keys) ? data.keys : []);
  } catch { return new Set(); }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); process.exit(0); }
  if (Number.isNaN(args.threshold)) { console.error('Bad --threshold'); process.exit(2); }

  const RT = reviewTextsRoot();
  if (!fs.existsSync(RT)) {
    console.error(`review-texts not found at ${RT} — is the private data clone present? (run ./scripts/setup-local-data.sh)`);
    process.exit(2);
  }

  // --write-baseline / --all ignore the baseline; the default run subtracts it.
  const useBaseline = !args.all && !args.writeBaseline;
  const baselineKeys = useBaseline ? loadBaselineKeys() : null;

  const { scanned, findings, baselinedCount } = scanReviewTexts(RT, {
    threshold: args.threshold,
    shows: args.show ? [args.show] : undefined,
    baselineKeys,
  });

  if (args.writeBaseline) {
    const p = baselinePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const payload = {
      _meta: {
        description: 'Known/triaged star-vs-score mismatches (card #396). The daily health check alerts only on findings NOT listed here. Regenerate after triaging with: node scripts/audit-star-score-mismatch.js --write-baseline',
        threshold: args.threshold,
        count: findings.length,
      },
      keys: findings.map(keyOf).sort(),
    };
    fs.writeFileSync(p, JSON.stringify(payload, null, 2) + '\n');
    console.log(`Wrote baseline: ${findings.length} known mismatches → ${p}`);
    process.exit(0);
  }

  if (args.json) {
    console.log(JSON.stringify({ scanned, threshold: args.threshold, mode: args.all ? 'all' : 'new', baselinedCount, count: findings.length, findings }, null, 2));
  } else {
    const scope = args.all ? 'whole corpus (baseline ignored)' : `new since baseline (${baselinedCount} baselined)`;
    console.log(`Star-vs-score mismatch audit (${scope}, gap>${args.threshold}): ${findings.length} flagged / ${scanned} reviews scanned`);
    const hidden = findings.filter(f => f.starWonHidingContradiction).length;
    if (hidden) console.log(`  ${hidden} are "star won routing, hiding in the live score" (Birthright shape — highest priority)`);
    for (const f of findings) {
      const tag = f.starWonHidingContradiction ? ' [STAR-WON-HIDING]' : '';
      console.log(`  ${f.worstGap}\t${f.showId}\t${f.outlet}\torig=${f.originalRating}(→${f.expected}) llm=${f.llm} assigned=${f.assigned} src=${f.scoreSource}${tag}`);
    }
  }

  // --all is audit mode (never fails on the backlog). A default run fails so the
  // daily health check surfaces genuinely NEW (non-baselined) contradictions.
  if (!args.all && findings.length > 0) process.exit(1);
  process.exit(0);
}

if (require.main === module) main();
