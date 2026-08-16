#!/usr/bin/env node
/**
 * audit-broadway-category-predicate.js — CI lint guard against re-deriving the
 * Broadway-category check inline instead of calling isBroadwayCategory()
 * (scripts/lib/venue-classification.js).
 *
 * Why this exists (task #1496, 3rd wave): cards #1471 (18 files) and #1484 (5
 * files) both deduped scripts reimplementing `category === 'broadway'` onto
 * isBroadwayCategory(). A fresh grep found a THIRD wave of ~25 more
 * occurrences — this pattern regenerates faster than one-off sweeps drain it.
 * scripts/backfill-show-category.js's own docstring shows why the raw literal
 * is dangerous: on real data the strict form (`category === 'broadway'`)
 * matches 42/2449 shows while the permissive form
 * (`!category || category === 'broadway'`, what isBroadwayCategory()
 * implements) matches 2009/2449 — a huge, easy-to-miss gap on historical/
 * closed shows where category can be null. See venue-classification.js's
 * doc comment for the full CONVENTION rationale.
 *
 * Two ways to opt out of the guard:
 *   - Explicit allowlist below (the canonical predicate definitions
 *     themselves — nothing else belongs here)
 *   - A `// Intentionally NOT isBroadwayCategory` comment within
 *     MARKER_LOOKBACK_LINES above the specific occurrence, documenting why
 *     THAT occurrence needs the strict/raw form (established convention, see
 *     scripts/lib/opening-signal.js and scripts/lib/commercial-queue.js).
 *     Per-occurrence, not per-file — a multi-occurrence file (e.g.
 *     newsletter/generate.mjs, 12 hits) needs each one justified separately,
 *     not silenced wholesale by one marker anywhere in the file.
 *
 * Heuristic raw-text scan, not AST-aware: skips lines that are JSDoc/comment
 * continuations (trimmed line starts with `*` or `//`) so prose mentioning
 * the pattern in a docstring (e.g. backfill-show-category.js's header,
 * explaining the very divergence this guard exists to prevent) doesn't
 * false-positive. False positives/negatives on trickier code shapes are
 * expected and acceptable for an advisory scan — consistent with
 * audit-direct-provider-calls.js and friends.
 *
 * Usage:
 *   node scripts/audit-broadway-category-predicate.js               report only (always exits 0)
 *   node scripts/audit-broadway-category-predicate.js --json         machine-readable output
 *   node scripts/audit-broadway-category-predicate.js --strict       exit 1 on new (non-baselined) violators
 *   node scripts/audit-broadway-category-predicate.js --update-baseline  regenerate the baseline from current scan
 *
 * Baseline-diff (task #1665), same posture as audit-direct-provider-calls.js:
 * pre-existing debt is frozen in data/audit/broadway-category-predicate-baseline.json
 * and never fails CI. Only a NEW (file, snippet) hit not in the baseline fails
 * under --strict. Diffing is identity-based (file+snippet), not a raw count —
 * a plain count ceiling would miss a same-day swap (one baselined hit gets
 * hand-fixed, a different new one gets added elsewhere in the same file: count
 * stays flat) — see scripts/lib/broadway-category-predicate-baseline.js and
 * audit-sibling-title-misroute.js, which hit this exact failure mode first.
 * Default mode (no flags) always exits 0 — report only, matching the sibling
 * gate's advisory-first convention now that test.yml calls --strict directly.
 *
 * Wired into .github/workflows/test.yml with --strict, no continue-on-error.
 */
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { baselineKeySet, computeNewViolators } = require('./lib/broadway-category-predicate-baseline.js');

const USAGE = `audit-broadway-category-predicate.js — flag scripts reimplementing category === 'broadway' instead of calling isBroadwayCategory().

Usage:
  node scripts/audit-broadway-category-predicate.js [--json]
  node scripts/audit-broadway-category-predicate.js --strict
  node scripts/audit-broadway-category-predicate.js --update-baseline
  node scripts/audit-broadway-category-predicate.js --help, -h    print this usage and exit
`;
if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }

const REPO_ROOT = path.join(__dirname, '..');
const SCRIPTS_DIR = path.join(REPO_ROOT, 'scripts');
const SELF_PATH = 'scripts/audit-broadway-category-predicate.js';
const BASELINE_PATH = path.join(REPO_ROOT, 'data', 'audit', 'broadway-category-predicate-baseline.json');

// The canonical predicate definitions themselves — nothing else belongs here.
// A file that legitimately needs the strict/raw form for a documented reason
// uses the inline `// Intentionally NOT isBroadwayCategory` marker instead.
const ALLOWLIST_FILES = new Set([
  'scripts/lib/venue-classification.js',
  'scripts/lib/commercial-scope.js',
]);

const INLINE_MARKER = 'Intentionally NOT isBroadwayCategory';

// Matches `category === 'broadway'` / `category == "broadway"` and the
// reversed operand order, dot-property or bare identifier on either side.
const PATTERN_RE = /(?:\bcategory\s*===?\s*["']broadway["']|["']broadway["']\s*===?\s*\bcategory)/;

const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');
const STRICT = args.includes('--strict');
const UPDATE_BASELINE = args.includes('--update-baseline');

function loadBaseline() {
  try {
    return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  } catch {
    return { hits: [] };
  }
}

function walkSourceFiles(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSourceFiles(full, out);
    } else if (/\.(js|mjs|ts)$/.test(entry.name) && !/\.test\.(js|mjs|ts)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function relPath(absPath) {
  return path.relative(REPO_ROOT, absPath).split(path.sep).join('/');
}

function isCommentLine(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('*') || trimmed.startsWith('//');
}

// How many lines above a match to look for the opt-out marker. Per-hit, not
// per-file (ship-check finding, task #1496): a file-wide exemption would let
// one documented occurrence (e.g. opening-signal.js) silently cover every
// OTHER raw literal in a multi-occurrence file like newsletter/generate.mjs
// (12 hits) without each one being individually justified.
const MARKER_LOOKBACK_LINES = 6;

function hasNearbyMarker(lines, matchIndex) {
  const start = Math.max(0, matchIndex - MARKER_LOOKBACK_LINES);
  for (let i = start; i <= matchIndex; i++) {
    if (lines[i].includes(INLINE_MARKER)) return true;
  }
  return false;
}

function scanFile(rel, source) {
  const hits = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCommentLine(line)) continue;
    if (PATTERN_RE.test(line) && !hasNearbyMarker(lines, i)) {
      hits.push({ line: i + 1, snippet: line.trim().slice(0, 160) });
    }
  }
  return hits;
}

function scanRepo() {
  const files = walkSourceFiles(SCRIPTS_DIR, []);
  const violators = [];
  for (const abs of files) {
    const rel = relPath(abs);
    if (rel === SELF_PATH) continue;
    if (ALLOWLIST_FILES.has(rel)) continue;
    const source = fs.readFileSync(abs, 'utf8');
    const hits = scanFile(rel, source);
    if (hits.length === 0) continue;
    violators.push({ file: rel, hits });
  }
  violators.sort((a, b) => a.file.localeCompare(b.file));
  return violators;
}

function main() {
  const violators = scanRepo();
  const totalHits = violators.reduce((sum, v) => sum + v.hits.length, 0);

  if (UPDATE_BASELINE) {
    const baseline = {
      generatedAt: new Date().toISOString().slice(0, 10),
      hits: violators.flatMap(v => v.hits.map(h => ({ file: v.file, snippet: h.snippet }))),
    };
    fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
    console.log(`✅ Baseline updated: ${baseline.hits.length} known raw-literal hit(s) across ${violators.length} file(s) (${BASELINE_PATH})`);
    return;
  }

  const baselineKeys = baselineKeySet(loadBaseline().hits);
  const newViolators = computeNewViolators(violators, baselineKeys);
  const newHits = newViolators.reduce((sum, v) => sum + v.hits.length, 0);

  if (JSON_OUT) {
    console.log(JSON.stringify({ violatorCount: violators.length, totalHits, violators, newViolators, newHits }, null, 2));
  } else if (violators.length === 0) {
    console.log('✅ audit-broadway-category-predicate: no un-allowlisted raw `category === \'broadway\'` literals in scripts/');
  } else {
    console.log(`Broadway-category predicate audit: ${totalHits} raw literal(s) across ${violators.length} file(s) (baselined: ${totalHits - newHits}, new: ${newHits}):\n`);
    for (const v of violators) {
      for (const h of v.hits) {
        console.log(`  ${v.file}:${h.line}  ${h.snippet}`);
      }
    }
    console.log(`\nUse isBroadwayCategory(show) from scripts/lib/venue-classification.js instead.`);
    console.log(`If the strict/raw form is genuinely intentional here, document why with a`);
    console.log(`\`// Intentionally NOT isBroadwayCategory\` comment (see scripts/lib/opening-signal.js).`);
    if (newViolators.length > 0) {
      console.log(`\n⚠️  NEW raw literal(s) not in the baseline (${BASELINE_PATH}):`);
      for (const v of newViolators) {
        for (const h of v.hits) console.log(`  ${v.file}:${h.line}  ${h.snippet}`);
      }
      console.log(`\nIf this is deliberate progress (an intentional carve-out), refresh the baseline:`);
      console.log(`  node scripts/audit-broadway-category-predicate.js --update-baseline`);
    }
  }

  if (STRICT && newViolators.length > 0) {
    process.exit(1);
  }
  process.exit(0); // advisory-first: default mode never fails the build
}

main();
