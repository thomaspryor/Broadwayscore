#!/usr/bin/env node
/**
 * Linear sweep — surface recouped-claim pending entries for human review.
 *
 * Replaces scripts/notify-pending-commercial-notion.js (BRO-3487), which
 * filed one Notion card PER recouped-claim entry onto the retired board via
 * commercial-weekly.yml's Saturday cron (CLAUDE.md §6: "Linear is the source
 * of truth — do NOT create Notion cards"). commercial-pending-review-
 * notify.yml's own header comment (added by the earlier BRO-3431 fix
 * session) explicitly called this "Not the same mechanism as
 * scripts/notify-pending-commercial-notion.js" — that session was aware of
 * it and deliberately left it out of scope; BRO-3487 closes the gap.
 *
 * Consumes the report JSON written by scripts/sweep-pending-commercial.js
 * (--report-json), then for each entry uses scripts/linear-brain.js (the one
 * Linear issue-creation chokepoint, CLAUDE.md §6/task #1310) to:
 *   - find() an existing OPEN issue whose title/body contains the stable key
 *     `commercial-pending-{slug}` (idempotent key, same as the Notion
 *     version's search --text=stableKey);
 *   - if found, post the current digest as a comment — linear-brain.js has
 *     no --notes UPDATE verb (unlike notion-brain's --notes), so unlike the
 *     Notion version this does not rewrite one card's body in place; instead
 *     it leaves an audit trail of how the entry's state changed over time.
 *     Same tradeoff scripts/sync-pending-review-to-linear.js (BRO-3431)
 *     already made — see that file's header;
 *   - else create a new issue, parked (never auto-dispatched — this is a
 *     standing human-review queue, not actionable engineering work).
 *
 * Usage:
 *   node scripts/notify-pending-commercial-linear.js \
 *     --report-json=/tmp/sweep-report.json [--cap=25] [--dry-run]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { buildNotes, buildTitle } = require('./lib/commercial-claim-card');

const USAGE = `notify-pending-commercial-linear.js — file recouped-claim pending entries as Linear issues.

Usage:
  node scripts/notify-pending-commercial-linear.js --report-json=PATH [--cap=25] [--dry-run]
  node scripts/notify-pending-commercial-linear.js --help
`;

if (hasHelpFlag(process.argv.slice(2))) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const args = process.argv.slice(2);
const flags = {};
for (const a of args) {
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    flags[k] = v === undefined ? true : v;
  }
}

const REPORT_JSON = flags['report-json'];
const DRY_RUN = flags['dry-run'] === true;
const CAP = parseInt(flags.cap, 10) || 25;
const LINEAR_BRAIN = path.join(__dirname, 'linear-brain.js');

if (!REPORT_JSON && require.main === module) {
  console.error('FATAL: --report-json=PATH required');
  process.exit(1);
}

function runLinearBrain(subargs) {
  const res = spawnSync('node', [LINEAR_BRAIN, ...subargs], {
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status };
}

// Exact-title match (linear-brain.js's --exact-title mode), not a substring
// search on `stableKey` — a slug like "hamlet" would otherwise substring-
// match an unrelated "hamlet-revival" issue's title (ship-check finding).
// buildTitle() is a pure function of item.slug, so it's a stable, unique key.
function findExistingIssue(title) {
  const res = runLinearBrain(['find', title, '--exact-title']);
  if (res.status !== 0) {
    throw new Error(`linear-brain find failed (exit ${res.status}): ${res.stderr.slice(0, 500)}`);
  }
  const out = res.stdout.trim();
  if (!out || out === 'null') return null;
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`linear-brain find returned non-JSON stdout: ${out.slice(0, 300)}`);
  }
}

function notifyOne(item) {
  const stableKey = `commercial-pending-${item.slug}`;
  const title = buildTitle(item.slug);
  const notes = buildNotes(item);

  if (DRY_RUN) {
    console.log(`[dry-run] ${stableKey} — would find + upsert`);
    return { slug: item.slug, action: 'dry-run' };
  }

  let issue;
  try {
    issue = findExistingIssue(title);
  } catch (err) {
    console.error(`  ✗ ${item.slug}: find failed — ${err.message.slice(0, 200)}`);
    return { slug: item.slug, action: 'error', error: 'find-failed' };
  }

  if (issue) {
    const update = runLinearBrain(['update', issue.identifier, '--comment', notes]);
    if (update.status !== 0) {
      console.error(`  ✗ ${item.slug}: comment failed — ${update.stderr.slice(0, 200)}`);
      return { slug: item.slug, action: 'error', error: 'comment-failed' };
    }
    console.log(`  ↻ ${item.slug}: commented on existing issue ${issue.identifier}`);
    return { slug: item.slug, action: 'updated', identifier: issue.identifier };
  }

  const create = runLinearBrain([
    'create', title,
    '--notes', notes,
    '--priority', '3', // Medium — visible human-review queue, never auto-dispatched (--park below)
    '--park', `Auto-filed by notify-pending-commercial-linear for pending commercial data review (${stableKey}); awaiting owner's manual look.`,
  ]);
  if (create.status !== 0) {
    console.error(`  ✗ ${item.slug}: create failed — ${create.stderr.slice(0, 200)}`);
    return { slug: item.slug, action: 'error', error: 'create-failed' };
  }
  const m = create.stdout.match(/"identifier":\s*"([A-Z]+-\d+)"/);
  const identifier = m ? m[1] : null;
  console.log(`  + ${item.slug}: created ${identifier || '(see linear-brain output above)'}`);
  return { slug: item.slug, action: 'created', identifier };
}

function main() {
  if (!fs.existsSync(REPORT_JSON)) {
    console.error(`FATAL: report file not found: ${REPORT_JSON}`);
    process.exit(1);
  }
  const report = JSON.parse(fs.readFileSync(REPORT_JSON, 'utf8'));
  const allClaims = report.recoupedClaims || [];
  const claims = allClaims.slice(0, CAP);
  const overflow = allClaims.length - claims.length;
  console.log(`Linear sweep — ${claims.length} recouped-claim entries (cap ${CAP}, dry-run=${DRY_RUN})`);
  if (overflow > 0) {
    // Loud warning so the overflow doesn't disappear silently — mirrors the
    // Notion version's identical guard (ship-check P1 finding there).
    console.log(`::warning::Linear cap=${CAP} hit — ${overflow} recouped-claim entries deferred to next run`);
  }
  if (claims.length === 0) return;

  const results = { created: 0, updated: 0, error: 0, 'dry-run': 0 };
  for (const item of claims) {
    const { action } = notifyOne(item);
    results[action] = (results[action] || 0) + 1;
  }
  console.log(`\nSweep summary: created=${results.created} updated=${results.updated} errors=${results.error}` +
              (overflow > 0 ? ` overflow=${overflow}` : ''));
  // A batch that's all errors used to still exit 0 (ship-check finding) —
  // the workflow step wraps this in continue-on-error, so a nonzero exit
  // doesn't fail the job, but it does mark the step red in the Actions UI
  // instead of masking every failure behind a green checkmark.
  if (results.error > 0) process.exit(1);
}

if (require.main === module) main();

