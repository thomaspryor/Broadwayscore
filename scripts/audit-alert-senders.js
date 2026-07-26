#!/usr/bin/env node
/**
 * Sender inventory for the alert-noise regression audit (card #475).
 *
 * Mechanically scans scripts/ + .github/workflows/ for every call site that
 * can page the owner by email, and classifies each one:
 *   - 'router'  — goes through scripts/lib/owner-alert-router.js (routeAlert),
 *                 which enforces the ACTION-only bar + per-condition dedup.
 *   - 'digest'  — an owner-confirmed scheduled digest that hits Resend
 *                 directly (send-daily-digest.js, autonomous-email.js, etc.
 *                 — the KEEP list in lint-resend-calls.js's ALLOWLIST).
 *   - 'direct'  — calls sendAlert(...) with an emailable severity directly,
 *                 bypassing the router's dedup/actionability gate. This is
 *                 the bypass class the card is about — each one needs either
 *                 migration onto routeAlert() or an explicit reviewed
 *                 justification (the 4 real-time-critical workflows named in
 *                 CLAUDE.md: vercel-deploy, opening-night-broadcast,
 *                 opening-night-poller, data-health-check use their own
 *                 notify-failure severity:'critical' path, tracked
 *                 separately, not scanned here).
 *
 * Modes:
 *   node scripts/audit-alert-senders.js            inventory snapshot (writes
 *                                                  data/audit/alert-sender-inventory.json)
 *   node scripts/audit-alert-senders.js --json     same, JSON to stdout
 *   node scripts/audit-alert-senders.js --check    CI lint gate (read-only):
 *                                                  fail on any direct sender in a file
 *                                                  not in scripts/.alert-sender-baseline.json,
 *                                                  or a baselined file's count growing.
 *                                                  Shrinking counts warn (run
 *                                                  --update-baseline), never fail.
 *   node scripts/audit-alert-senders.js --update-baseline
 *                                                  regenerate the baseline from current
 *                                                  direct findings (review the diff!)
 *
 * The baseline is a {relPath: directCallCount} map, NOT a flat file list (its
 * sibling gate, audit-help-flag-safety.js's baseline, is per-file boolean; this
 * one needs counts because audit-t1-silent-gaps.js has 2 sites and a new bypass
 * added to an already-baselined file must still fail). Never stores line
 * numbers — they churn. Baselined debt is tracked: audit-t1-silent-gaps.js
 * drain is card #531; opening-night-broadcast.yml + opening-night-poller.js are
 * the two permanent real-time-critical senders (CLAUDE.md rule 14's critical
 * workflows) and stay in the baseline deliberately.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `audit-alert-senders.js — inventory + CI gate for direct sendAlert(email:true) bypasses.

Usage:
  node scripts/audit-alert-senders.js                    inventory snapshot (writes data/audit/)
  node scripts/audit-alert-senders.js --json             same, JSON to stdout
  node scripts/audit-alert-senders.js --check            CI gate: fail on new/grown direct senders
  node scripts/audit-alert-senders.js --update-baseline  regenerate scripts/.alert-sender-baseline.json
  node scripts/audit-alert-senders.js --help, -h         print this usage and exit
`;

const REPO_ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['scripts', '.github/workflows'];
const SCAN_EXTENSIONS = new Set(['.js', '.mjs', '.yml', '.yaml']);
const SKIP_DIR_NAMES = new Set(['node_modules', '.git', '.next', 'dist', 'build']);

// Scheduled digests + already-reviewed direct Resend callers (owner
// email-consolidation plan 2026-07-21/22) — not part of the ad-hoc-alert
// bypass class this audit targets. Mirrors the KEEP + grandfathered sections
// of lint-resend-calls.js's ALLOWLIST; kept as a separate list here (rather
// than importing it) so this script's classification doesn't silently change
// if that lint's allowlist is edited for an unrelated reason.
const DIGEST_OR_REVIEWED = new Set([
  'scripts/send-daily-digest.js',
  'scripts/send-opening-digest.js',
  'scripts/reddit-engagement-digest.js',
  'scripts/fantasy-weekly-email.js',
  'scripts/generate-remediation-plan.js',
  'scripts/lib/brand-mention-email.js',
  'scripts/autonomous-email.js',
  'scripts/lib/discord-notify.js',
  'scripts/lib/owner-alert-router.js',
]);

function walk(dir, files) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (SCAN_EXTENSIONS.has(path.extname(entry.name))) files.push(full);
  }
}

// Best-effort: does this sendAlert(...) call site's surrounding ~8 lines
// carry an emailable disposition (email: true, or severity 'error'/'critical'
// alongside email logic)? Regex-based, not an AST parse — good enough for an
// inventory snapshot; false positives/negatives get corrected by hand as
// senders are migrated (this script re-runs cheaply to re-check).
function scanFile(absPath, relPath) {
  const findings = [];
  let content;
  try { content = fs.readFileSync(absPath, 'utf8'); } catch { return findings; }
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    // Skip comment lines (this file, opening-night-sla.js, and ux-walkthrough.yml
    // all have prose referencing "sendAlert(" inside // // # or * comments
    // describing PAST bugs or migrations — real matches, not real call sites).
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) continue;
    if (/\brouteAlert\s*\(/.test(lines[i])) {
      const window = lines.slice(i, i + 12).join('\n');
      const dispositionMatch = window.match(/disposition:\s*'(\w+)'/);
      findings.push({
        file: relPath, line: i + 1, kind: 'routeAlert',
        classification: 'router',
        disposition: dispositionMatch ? dispositionMatch[1] : 'unknown',
      });
    }
    if (/\bsendAlert\s*\(/.test(lines[i]) && !/function sendAlert/.test(lines[i])) {
      const window = lines.slice(i, i + 10).join('\n');
      const hasEmailTrue = /email:\s*true/.test(window);
      const severityMatch = window.match(/severity:\s*'(\w+)'/);
      const severity = severityMatch ? severityMatch[1] : null;
      const emailable = hasEmailTrue && (severity === 'error' || severity === 'critical' || severity === null);
      if (!emailable) continue; // warning/info-only sendAlert calls are log-only, not owner-facing email
      findings.push({
        file: relPath, line: i + 1, kind: 'sendAlert-direct',
        classification: DIGEST_OR_REVIEWED.has(relPath) ? 'digest' : 'direct',
        severity,
      });
    }
  }
  return findings;
}

const BASELINE_PATH = path.join(__dirname, '.alert-sender-baseline.json');

function collectFindings() {
  const files = [];
  for (const dir of SCAN_DIRS) walk(path.join(REPO_ROOT, dir), files);

  let all = [];
  for (const absPath of files) {
    const relPath = path.relative(REPO_ROOT, absPath).split(path.sep).join('/');
    if (relPath.endsWith('.test.mjs') || relPath.endsWith('.test.js')) continue;
    // Self-exclude: this script's usage text and gate messages quote the
    // "sendAlert(email:true)" pattern verbatim in non-comment lines, which the
    // regex scanner would flag as 4 phantom direct senders (same reason
    // audit-help-flag-safety.js filters out its own basename).
    if (relPath === 'scripts/' + path.basename(__filename)) continue;
    all = all.concat(scanFile(absPath, relPath));
  }
  return all;
}

/** {relPath: count} of direct-classified findings, keys sorted. */
function buildDirectCounts(findings) {
  const counts = {};
  for (const f of findings) {
    if (f.classification !== 'direct') continue;
    counts[f.file] = (counts[f.file] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Pure baseline comparison. `newFiles` and `grown` are regressions (blocking);
 * `shrunk` and `stale` mean the baseline is behind reality (warn: run
 * --update-baseline so the frozen debt keeps shrinking with the drain cards).
 */
function compareToBaseline(counts, baseline) {
  const newFiles = Object.keys(counts).filter((f) => !(f in baseline));
  const grown = Object.keys(counts)
    .filter((f) => f in baseline && counts[f] > baseline[f])
    .map((f) => ({ file: f, baseline: baseline[f], current: counts[f] }));
  const shrunk = Object.keys(counts)
    .filter((f) => f in baseline && counts[f] < baseline[f])
    .map((f) => ({ file: f, baseline: baseline[f], current: counts[f] }));
  const stale = Object.keys(baseline).filter((f) => !(f in counts));
  return { newFiles, grown, shrunk, stale, ok: newFiles.length === 0 && grown.length === 0 };
}

function loadBaseline() {
  try { return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')); } catch { return {}; }
}

function runCheck() {
  const counts = buildDirectCounts(collectFindings());
  const result = compareToBaseline(counts, loadBaseline());

  for (const f of result.stale) {
    console.log(`ℹ️  baseline entry already drained (no direct senders left): ${f} — run --update-baseline to shrink the list.`);
  }
  for (const s of result.shrunk) {
    console.log(`ℹ️  ${s.file}: direct senders shrank ${s.baseline} → ${s.current} — run --update-baseline to lock in the improvement.`);
  }

  if (result.ok) {
    const debt = Object.values(counts).reduce((a, b) => a + b, 0);
    console.log(`✅ Alert-sender gate: no new direct sendAlert(email:true) bypasses (${debt} baselined call site(s) remain — drain tracked in #531 etc.).`);
    return;
  }

  console.log(`🚨 Alert-sender gate: new direct sendAlert(email:true) bypass(es) of owner-alert-router:\n`);
  for (const f of result.newFiles) {
    console.log(`  ${f} (${counts[f]} call site(s)) — not in ${path.basename(BASELINE_PATH)}`);
  }
  for (const g of result.grown) {
    console.log(`  ${g.file} — direct call sites grew ${g.baseline} → ${g.current}`);
  }
  console.log(`\nFix: route the alert through routeAlert() from scripts/lib/owner-alert-router.js`);
  console.log(`(ACTION-only bar + per-condition dedup) instead of calling sendAlert(email:true)`);
  console.log(`directly. If the sender is genuinely real-time-critical (opening-night class,`);
  console.log(`CLAUDE.md rule 14), get it reviewed and freeze it via --update-baseline.\n`);
  process.exitCode = 1;
}

function updateBaseline() {
  const counts = buildDirectCounts(collectFindings());
  const old = loadBaseline();
  const added = Object.keys(counts).filter((f) => !(f in old));
  const removed = Object.keys(old).filter((f) => !(f in counts));
  const changed = Object.keys(counts).filter((f) => f in old && old[f] !== counts[f]);
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(counts, null, 2) + '\n');
  console.log(`Wrote ${Object.keys(counts).length} file entr${Object.keys(counts).length === 1 ? 'y' : 'ies'} to ${path.relative(process.cwd(), BASELINE_PATH)} (was ${Object.keys(old).length}). Review the diff!`);
  if (added.length) console.log(`  + added: ${added.join(', ')}`);
  if (removed.length) console.log(`  - removed: ${removed.join(', ')}`);
  for (const f of changed) console.log(`  ~ ${f}: ${old[f]} → ${counts[f]}`);
}

function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  if (process.argv.includes('--check')) return runCheck();
  if (process.argv.includes('--update-baseline')) return updateBaseline();

  const all = collectFindings();

  const summary = {
    generatedAt: new Date().toISOString(),
    counts: {
      router: all.filter(f => f.classification === 'router').length,
      digest: all.filter(f => f.classification === 'digest').length,
      direct: all.filter(f => f.classification === 'direct').length,
    },
    senders: all.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
  };

  const outPath = path.join(REPO_ROOT, 'data', 'audit', 'alert-sender-inventory.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n');

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`=== Alert Sender Inventory (${summary.senders.length} call site(s)) ===\n`);
  console.log(`router (owner-alert-router, ACTION-only + dedup):  ${summary.counts.router}`);
  console.log(`digest (reviewed scheduled email, direct Resend):  ${summary.counts.digest}`);
  console.log(`direct (bypasses router — migration candidates):  ${summary.counts.direct}\n`);

  const direct = summary.senders.filter(f => f.classification === 'direct');
  if (direct.length) {
    console.log('Direct-bypass call sites (candidates for routeAlert migration):');
    for (const f of direct) console.log(`  - ${f.file}:${f.line} (severity: ${f.severity || 'unknown'})`);
  }
  console.log(`\nWritten to data/audit/alert-sender-inventory.json`);
}

module.exports = { scanFile, buildDirectCounts, compareToBaseline, DIGEST_OR_REVIEWED };

if (require.main === module) main();
