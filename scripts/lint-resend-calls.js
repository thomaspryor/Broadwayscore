#!/usr/bin/env node
/**
 * Lint: no NEW direct api.resend.com callers outside the allowlist.
 *
 * Enforces the design principle in
 * ~/Documents/claude-outputs/email-consolidation-plan-2026-07-21.md: every
 * owner-facing alert must go through scripts/lib/owner-alert-router.js (or,
 * for the small set of owner-confirmed product emails, one of the existing
 * KEEP senders) instead of hitting Resend directly. Without this gate,
 * "route new alerts through the router" is a convention a future session can
 * silently forget — this makes forgetting impossible instead of unlikely.
 *
 * ALLOWLIST is the full inventory of files that called api.resend.com as of
 * 2026-07-22 (Sprint 1 of the email-consolidation plan) — grandfathered so
 * this gate doesn't red CI on day one. Sprints 2/3 migrate most of these onto
 * the router; as each one is migrated, remove it from ALLOWLIST so it can
 * never silently regain a direct call. Do NOT add a new file to ALLOWLIST to
 * unblock a failing PR — route through owner-alert-router.js instead (or, for
 * a genuine new product email, get explicit owner sign-off and note why here).
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const NEEDLE = 'api.resend.com';

const ALLOWLIST = new Set([
  // Router + base send lib
  'scripts/lib/discord-notify.js', // sendAlert() — the shared human-disposition email path
  // KEEP — owner-confirmed product emails (email-consolidation-plan-2026-07-21.md)
  'scripts/send-morning-digest.js', // the ONE scheduled owner email/day (loop retired 2026-07-27)
  'scripts/send-daily-digest.js',
  'scripts/send-opening-digest.js',
  'scripts/reddit-engagement-digest.js',
  'scripts/fantasy-weekly-email.js',
  'scripts/generate-remediation-plan.js',
  'scripts/lib/brand-mention-email.js',
  'scripts/autonomous-email.js',
  // Grandfathered — not yet migrated (Sprint 2/3 targets). Remove each line as
  // it's migrated onto owner-alert-router.js.
  'scripts/sync-followers.js',
  'scripts/execute-approved-fix.js',
  'scripts/send-opening-night-broadcast.js',
  'scripts/send-btc-results.js',
  'scripts/reconcile-broadcast-state.js',
  'scripts/health-check.js',
  'scripts/check-opening-night-readiness.js',
  'scripts/autonomous-merge.js',
  'scripts/process-feedback.js',
  'scripts/autonomous-deadman.js',
  'scripts/check-secrets-health.js', // GET /domains key-validity probe, not an alert send
  'scripts/newsletter/check-drafts-status.mjs', // GET /broadcasts read-only status probe, never touches /send
  'scripts/monitor-scheduled-email-count.js', // GET /emails read-only monitor (card #510) — routeAlert() for the actual alert, this is just data collection
  // GET /broadcasts + GET /broadcasts/{id} only. Its ONE fetch (resendGet, ~line 55)
  // passes no `method`, so it cannot POST/PATCH, and its only write target is the
  // local data/newsletter-state.json — it sends nothing. Same read-only class as the
  // three entries above, not a sender added to unblock a red build. If a future edit
  // adds a `method:` or a /send|/emails call here, this comment is falsified and the
  // entry must come back out.
  'scripts/newsletter/verify-sent-vs-state.mjs',
  'scripts/send-follow-notifications.js',
  'scripts/newsletter/create-broadcast-draft.mjs',
  'scripts/newsletter/send-test.mjs',
  '.github/workflows/btc-results-preview.yml',
  '.github/workflows/scraper-cost-report.yml',
  '.github/workflows/weekly-stubhub-validate.yml',
  '.github/workflows/weekly-affiliate-report.yml',
  '.github/workflows/investigate-alert.yml',
  '.github/workflows/process-review-submission.yml',
  '.github/workflows/auto-fix-feedback-bug.yml',
  'src/app/api/beat-the-critics/send-picks/route.ts',
]);

const SCAN_DIRS = ['scripts', '.github/workflows', 'src'];
const SCAN_EXTENSIONS = new Set(['.js', '.mjs', '.ts', '.tsx', '.yml', '.yaml']);
const SKIP_DIR_NAMES = new Set(['node_modules', '.git', '.next', 'dist', 'build']);

function walk(dir, files) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, files);
    } else if (SCAN_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(full);
    }
  }
}

function main() {
  const files = [];
  for (const dir of SCAN_DIRS) walk(path.join(REPO_ROOT, dir), files);

  const violations = [];
  for (const absPath of files) {
    const relPath = path.relative(REPO_ROOT, absPath).split(path.sep).join('/');
    if (relPath === 'scripts/lint-resend-calls.js') continue; // this file's own NEEDLE reference
    if (relPath.endsWith('.test.mjs') || relPath.endsWith('.test.js')) continue; // tests stub the network, never call out for real
    let content;
    try {
      content = fs.readFileSync(absPath, 'utf8');
    } catch {
      continue;
    }
    if (content.includes(NEEDLE) && !ALLOWLIST.has(relPath)) {
      violations.push(relPath);
    }
  }

  if (violations.length > 0) {
    console.error(`::error::${violations.length} file(s) call ${NEEDLE} directly outside the alert-router allowlist:`);
    for (const v of violations) console.error(`  - ${v}`);
    console.error(
      '\nRoute owner-facing alerts through scripts/lib/owner-alert-router.js (routeAlert) instead of ' +
      'hitting Resend directly. If this is a genuine new owner-confirmed product email, add it to ' +
      'ALLOWLIST in scripts/lint-resend-calls.js with a one-line justification.'
    );
    process.exit(1);
  }

  console.log(`OK — no direct ${NEEDLE} callers outside the allowlist (${ALLOWLIST.size} grandfathered/kept files).`);
}

main();
