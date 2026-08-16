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
 * Two ways to opt a file out of the guard:
 *   - Explicit allowlist below (the canonical predicate definitions
 *     themselves — nothing else belongs here)
 *   - A `// Intentionally NOT isBroadwayCategory` comment anywhere in the
 *     file, documenting why THIS file needs the strict/raw form (established
 *     convention, see scripts/lib/opening-signal.js and
 *     scripts/lib/commercial-queue.js)
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
 *   node scripts/audit-broadway-category-predicate.js            report + exit 1 if any violation
 *   node scripts/audit-broadway-category-predicate.js --json      machine-readable output
 *
 * Exit codes:
 *   0 — no un-allowlisted raw `category === 'broadway'` literals found
 *   1 — one or more found (detail in stdout)
 *
 * Wired into .github/workflows/test.yml as non-blocking (continue-on-error),
 * like audit-regex-patterns.js — promote to blocking once the backlog
 * (reported by this script today) is drained file-by-file.
 */
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `audit-broadway-category-predicate.js — flag scripts reimplementing category === 'broadway' instead of calling isBroadwayCategory().

Usage:
  node scripts/audit-broadway-category-predicate.js [--json]
  node scripts/audit-broadway-category-predicate.js --help, -h    print this usage and exit
`;
if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }

const REPO_ROOT = path.join(__dirname, '..');
const SCRIPTS_DIR = path.join(REPO_ROOT, 'scripts');
const SELF_PATH = 'scripts/audit-broadway-category-predicate.js';

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

function scanFile(rel, source) {
  const hits = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCommentLine(line)) continue;
    if (PATTERN_RE.test(line)) {
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
    if (source.includes(INLINE_MARKER)) continue;
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

  if (JSON_OUT) {
    console.log(JSON.stringify({ violatorCount: violators.length, totalHits, violators }, null, 2));
  } else if (violators.length === 0) {
    console.log('✅ audit-broadway-category-predicate: no un-allowlisted raw `category === \'broadway\'` literals in scripts/');
  } else {
    console.log(`⚠️  audit-broadway-category-predicate: ${totalHits} raw literal(s) across ${violators.length} file(s):\n`);
    for (const v of violators) {
      for (const h of v.hits) {
        console.log(`  ${v.file}:${h.line}  ${h.snippet}`);
      }
    }
    console.log(`\nUse isBroadwayCategory(show) from scripts/lib/venue-classification.js instead.`);
    console.log(`If the strict/raw form is genuinely intentional here, document why with a`);
    console.log(`\`// Intentionally NOT isBroadwayCategory\` comment (see scripts/lib/opening-signal.js).`);
  }

  process.exit(violators.length > 0 ? 1 : 0);
}

main();
