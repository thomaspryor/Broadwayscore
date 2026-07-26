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
 * Not a lint gate (yet) — this is the inventory snapshot the card's
 * acceptance criteria asks for. Re-run any time to see what's drifted:
 *   node scripts/audit-alert-senders.js [--json]
 */

'use strict';

const fs = require('fs');
const path = require('path');

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

function main() {
  const files = [];
  for (const dir of SCAN_DIRS) walk(path.join(REPO_ROOT, dir), files);

  let all = [];
  for (const absPath of files) {
    const relPath = path.relative(REPO_ROOT, absPath).split(path.sep).join('/');
    if (relPath.endsWith('.test.mjs') || relPath.endsWith('.test.js')) continue;
    all = all.concat(scanFile(absPath, relPath));
  }

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

main();
