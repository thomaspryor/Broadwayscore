/**
 * Detector for the "raw mean of assignedScore" bug class (BRO-4313).
 *
 * A show's Critic Score is a tier-weighted, critic-deduped average computed by
 * scripts/lib/compute-critic-score.js (the slim files' `cs`, read by
 * scripts/lib/canonical-critic-scores.ts getCriticScore()). Averaging
 * reviews' `assignedScore` directly gives a different number (no tier weights,
 * no outlet share, no designation floors, flat review minimum). Three scripts
 * shipped that way (detect-show-changes #784, generate-guide-editorials #956,
 * reddit-engagement-digest #957), then related-shows-scores and
 * validate-consensus (fixed with this detector). CLAUDE.md §3 forbids it;
 * this makes the rule checkable.
 *
 * Heuristic (comments ignored; multi-line statements joined), any of:
 *   1. one line both reads `assignedScore` and averages (`/ x.length`, mean(...),
 *      getAverage(...)), or lodash `meanBy(rs, 'assignedScore')` / `sumBy(...) / n`
 *   2. `rs.reduce((a, r) => a + r.assignedScore, 0) / rs.length`, even across lines
 *   3. a variable built from assignedScore (`const xs = rs.filter(…).map(r => r.assignedScore)`)
 *      averaged within WINDOW lines (`mean(xs)`, `xs.reduce(...) / xs.length`)
 *   4. an accumulator (`sum += r.assignedScore`) divided within WINDOW lines (`sum / n`)
 * Not caught: averages hidden behind a helper that takes the reviews array
 * (e.g. averageOf(rs)) — the canonical-parity test and review cover those. Files that may legitimately average per-review scores
 * (internal diagnostics that never publish a show score) go in ALLOWLIST with
 * a reason. Pure: no fs; scripts/audit-raw-mean-scores.js does the I/O.
 */

'use strict';

const WINDOW = 6;
// An averaging call: mean(…), avg(…), getAverage(…), arithmeticMean(…), lodash meanBy(…).
const AVG_CALL = String.raw`[\w$.]*(?:[Mm]ean|[Aa]vg|[Aa]verage)[\w$]*\s*\(`;
// Division by a length: `/ rs.length`, `/ (xs.length)`.
const DIV_LENGTH = String.raw`\/\s*\(?\s*[\w$.\[\]()]*\.length\b`;
const AVERAGE_RE = new RegExp(`${DIV_LENGTH}|(?<![\\w$])${AVG_CALL}`);
const SCORE_RE = /\bassignedScore\b/;
// Statement-level shapes, matched on the WINDOW of lines joined with spaces so
// multi-line reduce/map chains (the house style) are seen whole.
const REDUCE_DIV_RE = new RegExp(String.raw`\.reduce\(\s*\(?[^)]*\)?\s*=>[^;]{0,300}?\bassignedScore\b[^;]{0,300}?\)\s*` + DIV_LENGTH);
const LODASH_RE = /\b(?:meanBy\s*\([^)]*assignedScore|sumBy\s*\([^)]*assignedScore[^)]*\)\s*\/)/;
const MAPPED_VAR_RE = /\b(?:const|let|var)\s+([\w$]+)\s*=(?![=>])[^;]*?\.map\(\s*\(?[^)]*\)?\s*=>[^;]*?\bassignedScore\b/;
const ACCUMULATOR_RE = /([\w$]+)\s*\+=\s*[^;]*?\bassignedScore\b/;

function escapeVar(v) { return v.replace(/\$/g, '\\$'); }
function varRe(v) { return `(?<![\\w$])${escapeVar(v)}(?![\\w$])`; }

/** repo-relative path → why averaging assignedScore is acceptable there. */
const ALLOWLIST = {
  'scripts/analyze-qov.js': 'manual one-off diagnostic of per-review score spread; prints, never publishes a show score',
  'scripts/audit-scores.js': 'manual per-review calibration audit (raw average vs target band is the metric it studies)',
  'scripts/fix-scores.js': 'manual per-review calibration fixer; average is a sanity print, not a published score',
  'scripts/reconcile-scores.js': 'manual per-review reconciliation diagnostic; average is a sanity print',
  'scripts/tune-stereophonic.js': 'historical one-off tuning script (Stereophonic calibration); not run by any workflow',
  'scripts/ob-expansion-final-report.js': 'one-off 2026 Off-Broadway expansion report, not run by any workflow; its composite is a report column',
};

/**
 * Strip // line comments and block comments, keeping line count. A `//` only
 * starts a comment at line start or after whitespace/punctuation, so URLs
 * ('https://…') and strings like 'a//b' survive.
 * @param {string} source
 * @returns {string[]}
 */
function codeLines(source) {
  const noBlock = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return noBlock.split('\n').map((l) => l.replace(/(^|[\s;{}(),])\/\/.*$/, '$1'));
}

/**
 * @param {string} source - file contents
 * @returns {number[]} 1-based line numbers of assignedScore lines that feed an average
 */
function findRawMeanLines(source) {
  const lines = codeLines(source);
  const hits = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (!SCORE_RE.test(lines[i])) continue;
    const before = lines.slice(Math.max(0, i - WINDOW), i + 1).join(' ');
    const around = lines.slice(Math.max(0, i - WINDOW), i + WINDOW + 1).join(' ');
    // 1. the line itself averages, or a lodash meanBy/sumBy over assignedScore
    if (AVERAGE_RE.test(lines[i]) || LODASH_RE.test(around)) { hits.add(i + 1); continue; }
    // 2. a reduce over assignedScore divided by a length (possibly multi-line)
    if (REDUCE_DIV_RE.test(around) && REDUCE_DIV_RE.test(lines.slice(Math.max(0, i - 3), i + WINDOW + 1).join(' '))) { hits.add(i + 1); continue; }
    // 3. scores mapped into a variable (possibly a multi-line chain), then averaged
    const mapped = before.match(MAPPED_VAR_RE) || around.match(MAPPED_VAR_RE);
    if (mapped) {
      const v = varRe(mapped[1]);
      const usesVar = new RegExp(`(?<![\\w$])${AVG_CALL}\\s*${v}|${v}\\s*\\.reduce\\(|\\/\\s*${v}\\s*\\.length\\b`);
      if (usesVar.test(around)) { hits.add(i + 1); continue; }
    }
    // 4. an accumulator (`sum += r.assignedScore`) divided within the window
    const acc = lines[i].match(ACCUMULATOR_RE);
    if (acc && new RegExp(`${varRe(acc[1])}\\s*\\/`).test(around)) hits.add(i + 1);
  }
  return [...hits].sort((a, b) => a - b);
}

/**
 * @param {Array<{ path: string, source: string }>} files - repo-relative paths
 * @param {Record<string, string>} [allowlist]
 * @returns {{ violations: Array<{ path: string, lines: number[] }>, allowed: Array<{ path: string, lines: number[], reason: string }>, staleAllowlist: string[] }}
 */
function auditRawMeanScores(files, allowlist = ALLOWLIST) {
  const violations = [];
  const allowed = [];
  const seen = new Set();
  for (const { path, source } of files) {
    const lines = findRawMeanLines(source);
    if (lines.length === 0) continue;
    seen.add(path);
    if (allowlist[path]) allowed.push({ path, lines, reason: allowlist[path] });
    else violations.push({ path, lines });
  }
  const staleAllowlist = Object.keys(allowlist).filter((p) => !seen.has(p));
  return { violations, allowed, staleAllowlist };
}

/** Test, fixture and vendored paths are not scanned. */
function isScannable(relPath) {
  if (!/\.(?:js|mjs|cjs|ts|tsx)$/.test(relPath)) return false;
  if (/(?:^|\/)(?:node_modules|\.next|tests?|__tests__|fixtures?)\//.test(relPath)) return false;
  if (/\.(?:test|spec)\.[a-z]+$/.test(relPath)) return false;
  return true;
}

module.exports = { findRawMeanLines, auditRawMeanScores, isScannable, ALLOWLIST, WINDOW };
