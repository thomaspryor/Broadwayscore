'use strict';
/**
 * BRO-4807 (epic BRO-4210, BRO-4782 wiring C): which scripts can SET an exclusion flag on a review, and which of
 * them are deliberately exempt from the opening-night lane's trust model.
 *
 * Rule (trust-model.js): a guard stands down for a review ONLY when laneBypasses(review, guardName) is true. A
 * script that sets wrongProduction / wrongShow / isNonReview / isRoundupArticle = true must therefore either
 * reference laneBypasses (it is wired) or appear in LANE_EXEMPT below with the reason it cannot see a lane review.
 * tests/unit/opening-night-lane-flaggers.test.mjs fails on any other file, so a NEW flagger cannot land unwired.
 *
 * An in-file `lane-exempt: <reason>` comment is accepted instead of a registry entry.
 */
const fs = require('fs');
const path = require('path');

const FLAGS = ['wrongProduction', 'wrongShow', 'isNonReview', 'isRoundupArticle'];
const SKIP_DIRS = new Set(['node_modules', '.git']);

// Reasons. 'unscheduled' entries are machine-checked: the test fails if a workflow starts running the script.
const R = {
  unscheduled: { kind: 'unscheduled', reason: 'operator-run; no workflow or dispatcher runs it, so it only sees the files the operator points it at' },
  oneOff: { kind: 'unscheduled', reason: 'one-off or migration run by hand over an explicit list of files' },
  verdict: { kind: 'verdict-only', reason: 'builds a verdict/report object or fixture text; writes no flag onto a review file' },
  clears: { kind: 'clears-flags', reason: 'clears or audits existing flags; the matched text is a count, log line or comparison, not a new exclusion' },
  candidate: { kind: 'ingest-candidate', reason: 'flags freshly extracted in-memory candidates from an aggregator page; the lane writer is the only emitter of the lane stamp, so a candidate never carries one' },
  lint: { kind: 'lint', reason: 'lint that scans source text for flag writers; writes nothing' },
  videoRecords: { kind: 'other-corpus', reason: 'flags video-review records (data/video-reviews), a separate corpus the lane never writes to' },
  operatorTarget: { kind: 'operator-target', reason: 'refuses to flag without an explicit operator-supplied file list and throws on any human decision' },
};

const LANE_EXEMPT = Object.freeze({
  'scripts/apply-cross-production-llm-flags.js': R.unscheduled,
  'scripts/audit-corpus-contamination.js': R.operatorTarget,
  'scripts/audit-cross-show-excerpt-contamination.js': R.unscheduled,
  'scripts/audit-non-reviews.js': R.verdict,
  'scripts/auto-triage-cross-production.js': R.unscheduled,
  'scripts/cleanup-known-issues.js': R.unscheduled,
  'scripts/cleanup-review-sources.js': R.unscheduled,
  'scripts/extract-bww-reviews.js': R.candidate,
  'scripts/fix-aggregator-gap-override-contamination.js': R.oneOff,
  'scripts/fix-bro-3482-wrong-url-reviews.js': R.oneOff,
  'scripts/fix-timeout-we-attribution.js': R.oneOff,
  'scripts/fix-wrong-production-reviews.js': R.oneOff,
  'scripts/fix-wrong-reviews.js': R.oneOff,
  'scripts/lib/cv-promoted-nonreview-selector.js': R.verdict,
  'scripts/lib/non-review-patterns.js': R.verdict,
  'scripts/repair-noteless-wrongprod-autoclear.js': R.unscheduled,
  'scripts/resolve-remaining-collisions.js': R.unscheduled,
  'scripts/shadow-autoclear-report.js': R.verdict,
  'scripts/sweep-named-non-review-urls.js': R.unscheduled,
  'scripts/video-reviews/verify-productions.js': R.videoRecords,
});

// Blank out quoted/backticked text so a flag name in a log line or usage string is not read as a setter.
function stripStrings(line) {
  return line.replace(/`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, '""');
}

/** 1-based line numbers where `src` assigns or literal-sets one of FLAGS to true (comments and strings ignored). */
function flagWriteLines(src) {
  const out = [];
  const setter = new RegExp(`(?:\\.\\s*|\\b)(?:${FLAGS.join('|')})\\s*(?:=(?!=)|:)\\s*true\\b`);
  let inBlock = false;
  let inTemplate = false;
  src.split('\n').forEach((raw, i) => {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) return;
      inBlock = false;
      line = line.slice(end + 2);
    }
    if (inTemplate) {
      const close = line.search(/(?<!\\)`/);
      if (close === -1) return;
      inTemplate = false;
      line = line.slice(close + 1);
    }
    line = stripStrings(line);
    const tick = line.search(/(?<!\\)`/); // an unterminated template literal opens here and runs onto later lines
    if (tick !== -1) { inTemplate = true; line = line.slice(0, tick); }
    line = line.replace(/\/\*.*?\*\//g, '');
    const open = line.indexOf('/*');
    if (open !== -1) { inBlock = true; line = line.slice(0, open); }
    line = line.replace(/\/\/.*$/, '');
    if (setter.test(line)) out.push(i + 1);
  });
  return out;
}

// A write site is guarded when a lane call (or the rebuild's skipStaleFlagWrite, which calls one) appears within
// SITE_WINDOW lines above it, or a `lane-guarded: <where>` comment sits on the line or the two above it.
const SITE_WINDOW = 60;
const LANE_CALL = /\blane(?:Bypasses|Holds|Held|Ok)\(|\bskipStaleFlagWrite\(/;
function unguardedSites(src) {
  const lines = src.split('\n');
  return flagWriteLines(src).filter((n) => {
    const near = lines.slice(Math.max(0, n - 3), n).join('\n');
    if (/lane-guarded:\s*\S/.test(near)) return false;
    return !LANE_CALL.test(lines.slice(Math.max(0, n - 1 - SITE_WINDOW), n).join('\n'));
  });
}

const isTestFile = (rel) => /\.test\.|(^|\/)tests?\//.test(rel) || path.basename(rel).startsWith('test-');

/** Every scripts/ file that writes a flag: [{ file, lines, wired, exemptComment }]. */
function findFlagWriters(root) {
  const found = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!/\.(js|mjs|ts)$/.test(e.name)) continue;
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (isTestFile(rel) || rel === 'scripts/lib/opening-night-lane/flagger-registry.js') continue;
      const src = fs.readFileSync(full, 'utf8');
      const lines = flagWriteLines(src);
      if (lines.length) found.push({ file: rel, lines, wired: /\blaneBypasses\b/.test(src), exemptComment: /lane-exempt:\s*\S/.test(src), unguarded: unguardedSites(src) });
    }
  };
  walk(path.join(root, 'scripts'));
  return found.sort((a, b) => a.file.localeCompare(b.file));
}

module.exports = { FLAGS, LANE_EXEMPT, SITE_WINDOW, flagWriteLines, unguardedSites, findFlagWriters };
