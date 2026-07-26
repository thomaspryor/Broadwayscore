#!/usr/bin/env node
/**
 * Lint guard for the "cousin --help bug" class (#498): CLI scripts that
 * execute real side effects (network calls, corpus writes, child_process
 * dispatches) when invoked with `--help`/`-h` instead of printing usage.
 *
 * Fixed one-off nine times before this guard existed: autonomous-run.js +
 * autonomous-probe.js (#260/#263), autonomous-merge.js (#264),
 * audit-show-review-gap.js (#266), bsc-conductor.js + bsc-prune.js (#185),
 * and — the incident that triggered this card — collect-review-texts.js,
 * rebuild-all-reviews.js, fetch-show-images-auto.js (task #477 session log,
 * 2026-07-26: all three ran real network/filesystem work under --help before
 * being pkilled mid-execution).
 *
 * Two rules, both heuristic (regex + brace-matching, consistent with
 * audit-run-budget-coverage.js — false positives/negatives expected):
 *
 * RULE A (position bug, always blocking): a script that already ATTEMPTS a
 * --help/-h check (hasHelpFlag(...) or a literal '--help'/'-h' comparison)
 * but whose check sits textually AFTER a risky call (execSync/spawn/
 * child_process, saveShows/safeWriteReview, or a raw fs write/delete) that
 * runs unconditionally before it. This catches regressions in the 18 scripts
 * that already use the scripts/lib/cli-help.js convention.
 *
 * RULE B (missing entirely): a script that takes CLI args (references
 * process.argv) and does risky work, but has NO --help/-h check anywhere.
 * This is the actual shape of all nine prior incidents. The full corpus has
 * pre-existing debt here (~26 scripts as of 2026-07-26) — retrofitting all of
 * them is out of scope for this card. Pre-existing offenders are frozen in
 * scripts/.help-flag-safety-baseline.json and reported as tracked debt
 * (non-blocking); anything NOT in the baseline is a new regression and fails.
 *
 * Exemption (reviewed false positive, e.g. a "risky" call that's actually
 * read-only, or a script whose default behavior is genuinely harmless to
 * run twice): add  // hygiene-help-flag-ok: <reason>  anywhere in the file.
 *
 * Usage:
 *   node scripts/audit-help-flag-safety.js            check + report
 *   node scripts/audit-help-flag-safety.js --update-baseline
 *                                                      regenerate the baseline
 *                                                      from CURRENT missing-check
 *                                                      offenders (review the diff!)
 *   node scripts/audit-help-flag-safety.js --help, -h  print this usage and exit
 */
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `audit-help-flag-safety.js — lint guard for scripts that do real work on --help.

Usage:
  node scripts/audit-help-flag-safety.js              check scripts/, report violations
  node scripts/audit-help-flag-safety.js --update-baseline
                                                       regenerate the pre-existing-debt
                                                       baseline from current findings
  node scripts/audit-help-flag-safety.js --help, -h    print this usage and exit
`;

if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }

const SCRIPTS_DIR = __dirname;
const BASELINE_PATH = path.join(SCRIPTS_DIR, '.help-flag-safety-baseline.json');
const EXEMPTION = 'hygiene-help-flag-ok';

const HELP_CHECK_RE = /hasHelpFlag\s*\(|(['"])--help\1|(['"])-h\2(?=\s*[),;]|\s*===|\.includes)/;
// Real, consequential side effects only (execSync/child_process, and the two
// corpus-write guards) — NOT generic fs.writeFileSync, which is also used for
// harmless audit/cache/report output all over scripts/ and would swamp this
// check with false positives (calibrated against the real corpus: including
// it inflated Rule B from ~145 to 400+ hits, mostly on report-only scripts).
const RISKY_CALL_RE = /\b(?:execSync|spawnSync|spawn|execFile(?:Sync)?)\s*\(|require\(\s*['"]child_process['"]\s*\)|\bsaveShows\s*\(|\bsafeWriteReview\s*\(/g;
const ARGV_RE = /process\.argv/;
// A literal `--flag`-style comparison is the signal that a script has a real
// CLI flag surface (vs. one that only reads env vars / a bare positional id)
// — the shape every one of the nine prior --help incidents had.
const FLAG_STYLE_RE = /\.startsWith\(\s*['"]--|\.includes\(\s*['"]--|===\s*['"]--/;
const MAIN_FN_RE = /(?:async\s+)?function\s+main\s*\(/;

function loadBaseline() {
  try {
    return new Set(JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')));
  } catch {
    return new Set();
  }
}

function firstIndex(re, src) {
  re.lastIndex = 0;
  const m = re.exec(src);
  return m ? m.index : -1;
}

/**
 * Rule A checks ordering only WITHIN the window a human actually reads as
 * "runs before the gate" — from the start of main() (or file start, for
 * main()-less top-level-pipeline scripts like rebuild-all-reviews.js) up to
 * the help check itself. Scanning the WHOLE file for the first risky-call
 * regex hit (as an earlier draft of this script did) produced false
 * positives on every one of the 18 already-fixed scripts: a risky call
 * textually appearing in a LATER helper function (defined lexically before
 * main() but only invoked from within main() AFTER the --help gate) is not
 * actually reachable before the gate — source order isn't execution order.
 */
function checkOrdering(src) {
  const helpIdx = firstIndex(new RegExp(HELP_CHECK_RE, 'g'), src);
  if (helpIdx === -1) return { hasHelpCheck: false };

  const mainMatch = MAIN_FN_RE.exec(src);
  const windowStart = mainMatch ? mainMatch.index : 0;
  if (helpIdx < windowStart) return { hasHelpCheck: true, riskyBeforeHelp: false };

  const window = src.slice(windowStart, helpIdx);
  const riskyIdx = firstIndex(RISKY_CALL_RE, window);
  return { hasHelpCheck: true, riskyBeforeHelp: riskyIdx !== -1, riskyIdx: riskyIdx === -1 ? -1 : windowStart + riskyIdx };
}

function checkFile(file, src) {
  if (src.includes(EXEMPTION)) return null;

  const takesCliArgs = ARGV_RE.test(src) && FLAG_STYLE_RE.test(src);
  const hasRiskyOp = RISKY_CALL_RE.test(src);
  RISKY_CALL_RE.lastIndex = 0;

  const ordering = checkOrdering(src);

  if (ordering.hasHelpCheck && ordering.riskyBeforeHelp) {
    return {
      file,
      rule: 'A',
      blocking: true,
      detail: `--help check exists but a risky call runs unconditionally before it (char ${ordering.riskyIdx})`,
    };
  }

  if (!ordering.hasHelpCheck && takesCliArgs && hasRiskyOp) {
    return { file, rule: 'B', blocking: true, detail: 'takes flagged CLI args + performs risky work (execSync/child_process/saveShows/safeWriteReview) with no --help/-h check anywhere' };
  }

  return null;
}

function main() {
  const updateBaseline = process.argv.includes('--update-baseline');
  const files = fs
    .readdirSync(SCRIPTS_DIR)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => f !== path.basename(__filename))
    .sort();

  const baseline = loadBaseline();
  const findings = [];
  for (const file of files) {
    const src = fs.readFileSync(path.join(SCRIPTS_DIR, file), 'utf8');
    const finding = checkFile(file, src);
    if (finding) findings.push(finding);
  }

  const ruleA = findings.filter((f) => f.rule === 'A');
  const ruleBAll = findings.filter((f) => f.rule === 'B');
  const ruleBNew = ruleBAll.filter((f) => !baseline.has(f.file));
  const ruleBBaselined = ruleBAll.filter((f) => baseline.has(f.file));

  if (updateBaseline) {
    const newBaseline = ruleBAll.map((f) => f.file).sort();
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(newBaseline, null, 2) + '\n');
    console.log(`Wrote ${newBaseline.length} entries to ${path.relative(process.cwd(), BASELINE_PATH)}`);
    return;
  }

  const blocking = [...ruleA, ...ruleBNew];
  const staleBaselineEntries = [...baseline].filter((f) => !ruleBAll.some((finding) => finding.file === f)).sort();

  if (ruleBBaselined.length > 0) {
    console.log(`ℹ️  ${ruleBBaselined.length} pre-existing script(s) tracked in ${path.basename(BASELINE_PATH)} (no --help check, not blocking) — fix opportunistically.`);
  }
  if (staleBaselineEntries.length > 0) {
    console.log(`ℹ️  ${staleBaselineEntries.length} baseline entr${staleBaselineEntries.length === 1 ? 'y' : 'ies'} already fixed — re-run with --update-baseline to shrink the list: ${staleBaselineEntries.join(', ')}`);
  }

  if (blocking.length === 0) {
    console.log(`✅ Help-flag safety guard: no violations (${files.length} scripts checked, ${ruleBBaselined.length} baselined).`);
    return;
  }

  console.log(`🚨 Help-flag safety guard: ${blocking.length} violation(s):\n`);
  for (const f of blocking) {
    console.log(`  [Rule ${f.rule}] ${f.file}`);
    console.log(`      ${f.detail}`);
  }
  console.log(`\nFix: check hasHelpFlag(argv) from scripts/lib/cli-help.js BEFORE any real work runs (print`);
  console.log(`usage + return/exit). See collect-review-texts.js / rebuild-all-reviews.js / fetch-show-images-auto.js`);
  console.log(`for the established pattern (task #498).`);
  console.log(`False positive? Add  // ${EXEMPTION}: <reason>  anywhere in the file.\n`);
  process.exitCode = 1;
}

main();
