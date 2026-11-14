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
 *     Same tradeoff the retired sync-pending-review-to-linear.js (BRO-3431)
 *     made;
 *   - else create a new issue, parked (never auto-dispatched — this is a
 *     standing human-review queue, not actionable engineering work).
 *
 * BRO-3490: the same report path also carries `staleClosureReviews` rows
 * written by scripts/classify-stale-closures.js --report-json (closed shows
 * its classifier escalated to human review). Each gets one parked issue,
 * deduped on a stable exact title; an issue that already exists is left
 * alone (the row is static, so a daily comment would only be noise).
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
const { buildClosureReviewTitle, buildClosureReviewNotes } = require('./lib/stale-closure-review-card');

const USAGE = `notify-pending-commercial-linear.js — file recouped-claim pending entries and stale-closure reviews as Linear issues.

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

/**
 * Pure: turn a report into the issues to upsert, capped (BRO-3490).
 * Recouped claims come first so a burst of closure reviews never pushes
 * them past the cap.
 * @returns {{ specs: object[], overflow: number }}
 */
function planReportItems(report, cap) {
  const claims = ((report && report.recoupedClaims) || []).map((item) => ({
    kind: 'recouped-claim',
    slug: item.slug,
    stableKey: `commercial-pending-${item.slug}`,
    title: buildTitle(item.slug),
    notes: buildNotes(item),
    commentOnExisting: true,
  }));
  const closures = ((report && report.staleClosureReviews) || []).map((item) => ({
    kind: 'stale-closure-review',
    slug: item.slug,
    stableKey: `stale-closure-review-${item.slug}-${item.kind || 'review'}`,
    title: buildClosureReviewTitle(item.slug, item.kind),
    notes: buildClosureReviewNotes(item),
    commentOnExisting: false,
  }));
  const all = [...claims, ...closures];
  const specs = all.slice(0, cap);
  return { specs, overflow: all.length - specs.length };
}

/**
 * Identifier of a CLOSED (completed/canceled/duplicate) issue with exactly
 * this title, archived ones included (Linear auto-archives closed issues), or null. Runs linear-client in a child so this script stays
 * synchronous like its linear-brain calls.
 */
function findClosedIssueByTitle(title) {
  const code = `
    const lc = require(${JSON.stringify(path.join(__dirname, 'lib', 'linear-client.js'))});
    const { TERMINAL_STATE_TYPES } = require(${JSON.stringify(path.join(__dirname, 'lib', 'linear-state-types.js'))});
    lc.graphql('query($t: String!, $k: String!, $s: [String!]) { issues(first: 1, includeArchived: true, filter: { title: { eq: $t }, team: { key: { eq: $k } }, state: { type: { in: $s } } }) { nodes { identifier } } }',
      { t: process.argv[1], k: lc.TEAM_KEY, s: TERMINAL_STATE_TYPES }, { timeoutMs: 15000, maxAttempts: 2 })
      .then(d => { const n = d && d.issues && d.issues.nodes[0]; process.stdout.write(n ? n.identifier : 'null'); })
      .catch(e => { process.stderr.write(String(e && e.message || e)); process.exit(1); });`;
  const res = spawnSync('node', ['-e', code, title], { encoding: 'utf8', timeout: 45000 });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(res.stderr || `exit ${res.status}`);
  const out = (res.stdout || '').trim();
  return out && out !== 'null' ? out : null;
}

// Injectable for tests.
const DEPS = { findClosedIssueByTitle };

function notifyOne(spec) {
  const { slug, stableKey, title, notes } = spec;

  if (DRY_RUN) {
    console.log(`[dry-run] ${stableKey} — would find + upsert`);
    return { slug, action: 'dry-run' };
  }

  let issue;
  try {
    issue = findExistingIssue(title);
  } catch (err) {
    console.error(`  ✗ ${slug}: find failed — ${err.message.slice(0, 200)}`);
    return { slug, action: 'error', error: 'find-failed' };
  }

  // A stale-closure card someone already closed means the owner looked and
  // decided; re-filing it every day while the show stays escalated would be
  // noise (find --exact-title only sees OPEN issues).
  if (!issue && !spec.commentOnExisting) {
    let closed;
    try {
      closed = DEPS.findClosedIssueByTitle(spec.title);
    } catch (err) {
      console.error(`  ✗ ${slug}: closed-issue lookup failed — ${String(err.message).slice(0, 200)}`);
      return { slug, action: 'error', error: 'find-failed' };
    }
    if (closed) {
      console.log(`  = ${slug}: already handled in closed issue ${closed}`);
      return { slug, action: 'unchanged', identifier: closed };
    }
  }

  if (issue && !spec.commentOnExisting) {
    console.log(`  = ${slug}: already filed as ${issue.identifier}`);
    return { slug, action: 'unchanged', identifier: issue.identifier };
  }

  if (issue) {
    const update = runLinearBrain(['update', issue.identifier, '--comment', notes]);
    if (update.status !== 0) {
      console.error(`  ✗ ${slug}: comment failed — ${update.stderr.slice(0, 200)}`);
      return { slug, action: 'error', error: 'comment-failed' };
    }
    console.log(`  ↻ ${slug}: commented on existing issue ${issue.identifier}`);
    return { slug, action: 'updated', identifier: issue.identifier };
  }

  // BRO-5371: a worker takes these (the card carries a runnable VERIFY); parking them "for the owner" reached nobody.
  const create = runLinearBrain([
    'create', title,
    '--notes', notes,
    '--priority', '3', // Medium
    '--dispatch',
    '--new-anyway', 'one card per show; the exact-title lookup above already ran',
    '--source', 'workflow:notify-pending-commercial-linear',
  ]);
  if (create.status !== 0) {
    console.error(`  ✗ ${slug}: create failed — ${create.stderr.slice(0, 200)}`);
    return { slug, action: 'error', error: 'create-failed' };
  }
  const m = create.stdout.match(/"identifier":\s*"([A-Z]+-\d+)"/);
  const identifier = m ? m[1] : null;
  console.log(`  + ${slug}: created ${identifier || '(see linear-brain output above)'}`);
  return { slug, action: 'created', identifier };
}

function main() {
  if (!fs.existsSync(REPORT_JSON)) {
    console.error(`FATAL: report file not found: ${REPORT_JSON}`);
    process.exit(1);
  }
  const report = JSON.parse(fs.readFileSync(REPORT_JSON, 'utf8'));
  const { specs, overflow } = planReportItems(report, CAP);
  const nClaims = specs.filter((x) => x.kind === 'recouped-claim').length;
  console.log(`Linear sweep — ${nClaims} recouped-claim + ${specs.length - nClaims} stale-closure entries (cap ${CAP}, dry-run=${DRY_RUN})`);
  if (overflow > 0) {
    // Loud warning so the overflow doesn't disappear silently — mirrors the
    // Notion version's identical guard (ship-check P1 finding there).
    console.log(`::warning::Linear cap=${CAP} hit — ${overflow} entries deferred to next run`);
  }
  if (specs.length === 0) return;

  const results = { created: 0, updated: 0, unchanged: 0, error: 0, 'dry-run': 0 };
  for (const spec of specs) {
    const { action } = notifyOne(spec);
    results[action] = (results[action] || 0) + 1;
  }
  console.log(`\nSweep summary: created=${results.created} updated=${results.updated} unchanged=${results.unchanged} errors=${results.error}` +
              (overflow > 0 ? ` overflow=${overflow}` : ''));
  // A batch that's all errors used to still exit 0 (ship-check finding) —
  // the workflow step wraps this in continue-on-error, so a nonzero exit
  // doesn't fail the job, but it does mark the step red in the Actions UI
  // instead of masking every failure behind a green checkmark.
  if (results.error > 0) process.exit(1);
}

if (require.main === module) main();

module.exports = { planReportItems, findClosedIssueByTitle, DEPS };

