#!/usr/bin/env node
/**
 * CI guard against future sanitizeVenueForWrite() cousins (card #1923,
 * follow-up to card #994). See scripts/lib/venue-write-guard-detector.js for
 * the detection heuristic and why it exists.
 *
 * Advisory-first, same pattern as audit-direct-provider-calls.js: pre-existing
 * unguarded sites are frozen in data/audit/venue-write-guard-baseline.json and
 * never fail CI on their own — as of this writing that baseline includes both
 * genuine pending debt (card #1922: promote-ob-historical.js,
 * promote-historical-we.js, enrich-west-end-shows.js) and known false
 * positives (a `venue:`/`.venue =` site that only ever PROPAGATES an
 * already-sanitized value — e.g. `logEntry({ ..., venue: entry.venue })` after
 * `entry` was built by a guarded buildShowEntry() — which this regex-level
 * heuristic cannot distinguish from a raw write without a real type-flow
 * analysis; per the card, the tradeoff is intentional). Only a NEW site (not
 * in the baseline) fails CI under --strict — that is the actual guarantee
 * this script gives: nothing NEW can skip sanitizeVenueForWrite() unnoticed.
 *
 * Usage:
 *   node scripts/audit-venue-write-guard.js                 report all findings (exit 0)
 *   node scripts/audit-venue-write-guard.js --strict         exit 1 on any NEW (non-baselined) unguarded site
 *   node scripts/audit-venue-write-guard.js --update-baseline   regenerate the baseline from the current scan
 *   node scripts/audit-venue-write-guard.js --json           machine-readable findings
 *   node scripts/audit-venue-write-guard.js --help, -h        print this usage and exit
 *
 * False positive? Either route the RHS through sanitizeVenueForWrite(...), or
 * if it's a genuine non-write propagation, add
 * `// venue-write-guard-ok: <reason>` anywhere in the file to exempt it
 * (whole-file — same shape as audit-fetch-timeouts.js's exemption).
 */
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `audit-venue-write-guard.js — flag scripts/** venue: / .venue = writes that skip sanitizeVenueForWrite().

Usage:
  node scripts/audit-venue-write-guard.js                report all findings (exit 0)
  node scripts/audit-venue-write-guard.js --strict        exit 1 on any NEW (non-baselined) unguarded site
  node scripts/audit-venue-write-guard.js --update-baseline   regenerate the baseline from the current scan
  node scripts/audit-venue-write-guard.js --json          machine-readable findings
  node scripts/audit-venue-write-guard.js --help, -h       print this usage and exit
`;
if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }

const { scanVenueWrites } = require('./lib/venue-write-guard-detector.js');

const REPO_ROOT = path.join(__dirname, '..');
const SCRIPTS_DIR = path.join(REPO_ROOT, 'scripts');
const BASELINE_PATH = path.join(REPO_ROOT, 'data', 'audit', 'venue-write-guard-baseline.json');
const SELF_PATHS = new Set(['scripts/audit-venue-write-guard.js', 'scripts/lib/venue-write-guard-detector.js']);

const SCANNABLE_EXT_RE = /\.(js|mjs|ts)$/;
const TEST_FILE_RE = /\.(test|spec)\.(js|mjs|ts)$/;
const EXCLUDE_DIRS = new Set(['node_modules', '__pycache__', '.git']);

function listScannableFiles(dir) {
  let out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      out = out.concat(listScannableFiles(path.join(dir, entry.name)));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SCANNABLE_EXT_RE.test(entry.name)) continue;
    if (TEST_FILE_RE.test(entry.name)) continue;
    if (entry.name.endsWith('.d.ts')) continue;
    out.push(path.join(dir, entry.name));
  }
  return out;
}

/** @returns {Array<{file: string, line: number, kind: string, snippet: string}>} */
function scanRepo() {
  const findings = [];
  for (const absPath of listScannableFiles(SCRIPTS_DIR)) {
    const relPath = path.relative(REPO_ROOT, absPath).split(path.sep).join('/');
    if (SELF_PATHS.has(relPath)) continue;
    const source = fs.readFileSync(absPath, 'utf8');
    for (const f of scanVenueWrites(source)) {
      if (f.guarded) continue;
      findings.push({ file: relPath, line: f.line, kind: f.kind, snippet: f.snippet });
    }
  }
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return findings;
}

function loadBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) return { generatedAt: null, sites: {} };
  return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
}

// Keyed by file + the site's own snippet text — NOT file:line. An earlier
// version keyed on file:line, which adversarial review caught as fragile:
// any unrelated edit earlier in the file that shifts line numbers makes a
// genuinely-unchanged baselined site look "new" (forcing a spurious
// --update-baseline), while moving a NEW raw write to land on an old
// baselined site's exact line+snippet would (in the file:line scheme)
// silently inherit its pass — the same failure mode either way, since line
// number carries no real identity here. Keying on snippet text alone is
// stable across line drift and only collides when two DIFFERENT sites in
// the same file happen to be byte-identical text, an accepted heuristic
// tradeoff (same class as every other audit-*.js in this repo).
function siteKey(f) {
  return `${f.file}::${f.snippet}`;
}

/** A finding is "new" (not baselined) if its file+snippet key is absent from the baseline. */
function computeNewFindings(findings, baseline) {
  const sites = baseline.sites || {};
  return findings.filter((f) => !sites[siteKey(f)]);
}

function writeBaseline(findings) {
  const sites = {};
  for (const f of findings) {
    sites[siteKey(f)] = { file: f.file, line: f.line, kind: f.kind, snippet: f.snippet };
  }
  const baseline = { generatedAt: new Date().toISOString().slice(0, 10), sites };
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
  return baseline;
}

function main() {
  const args = process.argv.slice(2);
  const jsonOut = args.includes('--json');
  const strict = args.includes('--strict');
  const updateBaseline = args.includes('--update-baseline');

  const findings = scanRepo();

  if (updateBaseline) {
    const baseline = writeBaseline(findings);
    console.log(`Wrote ${Object.keys(baseline.sites).length} site(s) to ${path.relative(REPO_ROOT, BASELINE_PATH)}`);
    return;
  }

  const baseline = loadBaseline();
  const newFindings = computeNewFindings(findings, baseline);

  if (jsonOut) {
    console.log(JSON.stringify({ total: findings.length, new: newFindings.length, findings, newFindings }, null, 2));
    process.exitCode = strict && newFindings.length > 0 ? 1 : 0;
    return;
  }

  console.log(`venue-write-guard: ${findings.length} unguarded site(s) total, ${newFindings.length} NOT in baseline.`);
  if (newFindings.length > 0) {
    console.log(`\nNew unguarded venue write(s) — route the RHS through sanitizeVenueForWrite(...):\n`);
    for (const f of newFindings) console.log(`  ${f.file}:${f.line} [${f.kind}] ${f.snippet}`);
    console.log(`\nFalse positive (genuine non-write propagation)? Add  // ${'venue-write-guard-ok'}: <reason>  anywhere in the file.`);
    console.log(`Genuine new debt you're deliberately deferring? node scripts/audit-venue-write-guard.js --update-baseline`);
  } else {
    console.log('No new unguarded sites beyond the baseline.');
  }

  if (strict && newFindings.length > 0) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { scanRepo, listScannableFiles, loadBaseline, computeNewFindings, writeBaseline, siteKey, BASELINE_PATH };
