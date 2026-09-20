#!/usr/bin/env node
/**
 * audit-card-verifiability.js — sweep pending/in-progress Notion backlog
 * cards for the SAME verify-gate bsc-next.js enforces at dispatch time
 * (scripts/lib/verify-gate.js), so the count of undispatchable cards is
 * visible before a human hand-enriches them one at a time (task #646).
 *
 * Cards written before "acceptance criteria must name a runnable command"
 * became a rule are silently stuck: bsc-next refuses to dispatch them
 * (correctly), but nothing surfaces how many are stuck or fixes them. This
 * script is read-only w.r.t. Notion/Linear — it never writes to either — and
 * writes a report consumed by health-check.js's warn row and by
 * enrich-card-acceptance.js. BRO-2977/BRO-3076: when any card names a
 * `node --test`/`npx tsx --test`/`test -f` path, it also does a local,
 * depth-bound `git fetch origin main` (never a Notion/Linear write) to check
 * that path's existence — see card-premises-auditor.js's header for why it
 * must check origin/main and not this process's own checkout.
 *
 * task #1830: --source linear adds a second, independent sweep over open
 * Linear (BRO-*) issues (the same verify gate linear-next.js enforces at
 * dispatch time), writing to its OWN report path
 * (data/audit/card-verifiability-linear.json) rather than the shared Notion
 * report — health-check.js's warn row and backlog-drain.js both read the
 * Notion report's exact schema/id-space today, so this stays additive: the
 * zero-arg / --source notion (default) behavior and REPORT_PATH's contents
 * are byte-for-byte unchanged.
 *
 * Usage:
 *   node scripts/audit-card-verifiability.js [--status "Not started,In progress"] [--limit N] [--source notion|linear]
 *
 *   --status   comma-separated Notion Status values to sweep (default: both
 *              backlog statuses — Done cards are irrelevant, Paused cards are
 *              deliberately parked and excluded from the undispatchable count)
 *              — notion source only.
 *   --limit    max cards/issues to fetch (default 300)
 *   --source   notion | linear (default: notion — unchanged from before #1830)
 *   --help/-h  show this message, do nothing else
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { evaluateVerifiability } = require('./lib/verify-gate.js');
const { redactEmails } = require('./lib/pii-scan.js');
// findCardsWithMissingCheckPaths is deliberately NOT imported: findCardCheckPathDefects
// supersedes it here (both buckets, one fetch). The wrapper stays exported from the lib
// for any other caller.
const { findCardCheckPathDefects, isCheckPathCommand, auditCardCheckPaths, auditVacuousChecks, pathExistsOnOriginMain } = require('./lib/card-premises-auditor.js');
const { sortedCommentBodies } = require('./lib/linear-dispatch.js');
// Lazy-safe to require unconditionally — same reasoning as
// enrich-card-acceptance.js: getApiKey() is only called inside an actual
// graphql() call, so a Notion-only sweep never needs LINEAR_API_KEY set.
const linear = require('./lib/linear-client.js');

const REPO = path.join(__dirname, '..');
const REPORT_PATH = path.join(REPO, 'data', 'audit', 'card-verifiability.json');
const LINEAR_REPORT_PATH = path.join(REPO, 'data', 'audit', 'card-verifiability-linear.json');
const DEFAULT_STATUS = 'Not started,In progress';
const DEFAULT_LIMIT = 300;

const USAGE = `audit-card-verifiability.js — count backlog cards bsc-next/linear-next would refuse to dispatch.

Usage:
  node scripts/audit-card-verifiability.js [--status "Not started,In progress"] [--limit N] [--source notion|linear]

Writes ${path.relative(REPO, REPORT_PATH)} for --source notion (default; consumed by
health-check.js's warn row and by enrich-card-acceptance.js) or
${path.relative(REPO, LINEAR_REPORT_PATH)} for --source linear. Read-only w.r.t.
Notion/Linear (never writes to either) — but does a local git fetch of origin/main
when a card names a node --test path, to check the path actually exists.
`;

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const k = t.slice(2);
      const n = argv[i + 1];
      if (n === undefined || n.startsWith('--')) a[k] = true;
      else { a[k] = n; i++; }
    } else a._.push(t);
  }
  return a;
}

function notionBrain(args) {
  const out = execFileSync('node', [path.join(__dirname, 'notion-brain.js'), ...args], {
    cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
  });
  return JSON.parse(out);
}

// List-endpoint rows carry no notes (health-digest-sized table), so every
// card needs its own `get` to see the acceptance-criteria body. Best-effort:
// a single fetch failure (Notion blip) is logged and skipped, never fatal to
// the whole sweep — same posture as autonomous-triage.js's card fetch.
function fetchCard(id) {
  try { return notionBrain(['get', id]); } catch (e) {
    console.error(`[audit-card-verifiability] WARN fetch failed for ${id}: ${e.message.slice(0, 160)}`);
    return null;
  }
}

function fetchPendingCardIds(status, limit) {
  const table = notionBrain(['list', '--status', status, '--limit', String(limit)]);
  return table.map(row => row.id);
}

// Pure — the actual per-card verdict, exported so enrich-card-acceptance.js
// (and its test) share the exact same shape instead of re-deriving it.
function evaluateCard(card) {
  const gate = evaluateVerifiability(card.notes || '');
  return {
    id: card.id,
    name: card.name,
    url: card.url,
    priority: card.priority,
    status: card.status,
    category: card.category,
    tags: card.tags || [],
    notes: card.notes || '',
    armed: gate.armed,
    ownerJudgment: gate.ownerJudgment,
    reason: gate.reason,
    kind: gate.kind,
    cmd: gate.cmd,
  };
}

// BRO-2570: refused cards used to carry only gate.reason — one opaque
// sentence collapsing "wrong directory", "wrong shape", a traversal attempt,
// and a phantom path into the same unreadable bucket. gate.kind (threaded
// from explainUnsafeCheckCommand via evaluateVerifiability) is the same
// machine-readable cause enrich-card-acceptance.js already branches on
// (BRO-2546) — byKind turns "N cards refused" into "N cards are one
// directory away from armed" board-wide.
function tallyByKind(refused) {
  const byKind = {};
  for (const c of refused) {
    const k = c.kind || 'unknown';
    byKind[k] = (byKind[k] || 0) + 1;
  }
  return byKind;
}

function buildReport(evaluated, now = new Date()) {
  const refused = evaluated.filter(c => !c.armed);
  return {
    generatedAt: now.toISOString(),
    total: evaluated.length,
    armedCount: evaluated.length - refused.length,
    refusedCount: refused.length,
    byKind: tallyByKind(refused),
    // name: redacted (BRO-3866 ship-check, Codex adversarial finding) — this
    // report is data/audit/card-verifiability.json, committed to the PUBLIC
    // repo, and a card title can be pasted straight from an email subject
    // line (the same escalation-card shape that leaked into
    // card-enrichment-log.jsonl).
    refused: refused.map(c => ({
      id: c.id, name: redactEmails(c.name || ''), priority: c.priority, url: c.url, reason: c.reason, kind: c.kind || 'unknown',
    })),
  };
}

function writeReport(report, reportPath = REPORT_PATH) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(`${reportPath}.tmp`, JSON.stringify(report, null, 2) + '\n');
  fs.renameSync(`${reportPath}.tmp`, reportPath);
}

// Pure (task #1830) — same evaluated shape evaluateCard() produces for a
// Notion card ({id, name, url, priority, armed, ownerJudgment, reason, ...}),
// so buildReport() works unchanged across both providers. priority/status are
// null: Linear's priority is a raw int with its own remap
// (linear-dispatch.js's priorityRank), not the Notion "P0 Now" string this
// report's consumers print — not needed for the refused-count metric this
// report exists to surface.
function evaluateLinearIssue(issue) {
  const gate = evaluateVerifiability(issue.description || '');
  return {
    id: issue.identifier,
    name: issue.title,
    url: issue.url,
    priority: null,
    status: (issue.state && issue.state.name) || null,
    category: null,
    tags: [],
    notes: issue.description || '',
    armed: gate.armed,
    ownerJudgment: gate.ownerJudgment,
    reason: gate.reason,
    kind: gate.kind,
    cmd: gate.cmd,
  };
}

async function fetchLinearOpenIssuesWithDescriptions() {
  return linear.listOpenIssuesWithDescriptions();
}

// BRO-2977/BRO-3076: an armed card's `node --test`/`npx tsx --test`/`test -f`
// command can still name a file that does not exist anywhere —
// isSafeCheckCommand only checks SHAPE, never existence — which permanently
// starves the card at linear-brain.js's Done gate. Checked against
// origin/main (not this process's local checkout — see
// card-premises-auditor.js's header for why), so it's additive on top of
// buildReport rather than folded into armed/refused: a card with a
// confirmed-missing check path is still "armed" by the dispatch gate's own
// definition, just unable to ever pass its own acceptance check.
// BRO-3378 attaches the opposite-polarity bucket in the same pass: a card whose
// check path is PRESENT can be just as undispatchable-in-spirit as one whose
// path is absent, because a `test -f` on an existing file is green before the
// work starts and therefore proves nothing when re-run at Done time. The two
// are mutually exclusive per card (see the auditor's own complementary-buckets
// test), so a reader can always tell which case they are looking at. One call,
// one origin/main fetch, one existence cache — never two sweeps that could
// disagree about a path that landed upstream between them.
function attachMissingCheckPaths(report, evaluated, opts) {
  const { missing, vacuous } = findCardCheckPathDefects(evaluated, opts);
  report.missingCheckPaths = missing;
  report.vacuousChecks = vacuous;
  return report;
}

// BRO-2977 round 2: the bulk fetch above (buildOpenIssuesWithDescriptionsQuery)
// deliberately carries no comments, to keep a ~1000-issue sweep cheap — but
// BRO-2796 established that a Linear issue's description can never be edited
// after filing, so a comment naming a corrected `VERIFY: <cmd>` is the ONLY
// way a wrong verifyCmd is ever fixed. Without this reconciliation pass, a
// card corrected exactly the way this audit's own report asks for would stay
// listed forever, because the bulk gate never saw the correction. Scoped to
// just the already-flagged subset — the same one-round-trip-per-card cost
// runNotionAudit's fetchCard() loop already pays for its ENTIRE sweep, not
// just a flagged subset — so this is comparatively cheap.
// BRO-3378: the re-fetch loop is identical for both check-path buckets — only
// the classifier applied to the corrected command differs — so it is
// parameterized here rather than copy-pasted. `auditFn` is any
// (cards, existsFn) => flagged[] from card-premises-auditor.js. Copying the
// loop instead would be exactly the drift CLAUDE.md §15 exists to prevent: a
// fix to the fail-toward-reporting contract below would have to be made twice.
async function reconcileCheckDefectsWithComments(flagged, auditFn, opts = {}) {
  // Injectable (opts.getIssue) so tests never make a live Linear API call —
  // same DI convention linear-next.js's tests rely on (noopLinearDeps()).
  const getIssue = opts.getIssue || require('./lib/linear-client.js').getIssue;
  const existsOnOriginMain = opts.pathExistsOnOriginMain || pathExistsOnOriginMain;
  const log = opts.log || (() => {});
  const cache = new Map();
  const existsFn = (p) => {
    if (!cache.has(p)) cache.set(p, existsOnOriginMain(p, opts));
    return cache.get(p);
  };
  const stillFlagged = [];
  for (const card of flagged) {
    let issue;
    try {
      issue = await getIssue(card.id);
    } catch (err) {
      log(`[audit-card-verifiability] WARN could not re-fetch ${card.id} with comments: ${String(err.message).slice(0, 120)}`);
      stillFlagged.push(card); // fail toward reporting, never toward silently clearing
      continue;
    }
    if (!issue) { stillFlagged.push(card); continue; }
    const gate = evaluateVerifiability(issue.description || '', sortedCommentBodies(issue));
    if (!gate.armed || !isCheckPathCommand(gate.cmd)) continue; // corrected away from a file-naming claim entirely
    const recheck = auditFn([{ id: card.id, name: card.name, url: card.url, cmd: gate.cmd }], existsFn);
    if (recheck.length) stillFlagged.push(recheck[0]);
  }
  return stillFlagged;
}

// The two public reconcilers. Signatures unchanged from before BRO-3378 for
// the missing-path one (five existing tests pin it).
function reconcileMissingCheckPathsWithComments(flagged, opts = {}) {
  return reconcileCheckDefectsWithComments(flagged, auditCardCheckPaths, opts);
}

// BRO-3378: a vacuous command gets the same correction path. The bulk sweep
// evaluates descriptions ONLY (evaluateLinearIssue passes no comments, to keep
// a ~1000-issue fetch cheap), so without this a card whose weak `test -f` was
// already corrected by a later comment — the only way a Linear description's
// command can be fixed after filing, per BRO-2796 — would be reported as
// vacuous forever, and any repair sweep would act on a card that is already fine.
function reconcileVacuousChecksWithComments(flagged, opts = {}) {
  return reconcileCheckDefectsWithComments(flagged, auditVacuousChecks, opts);
}

/**
 * Reconcile BOTH buckets in one pass over the union of flagged cards.
 *
 * Running the two reconcilers independently loses defects that MOVE between
 * buckets (ship-check finding): a card flagged missing-path whose comment
 * corrects it to `test -f <file that exists>` clears the missing check and is
 * never offered to the vacuous classifier, so it vanishes from both reports
 * while being exactly the defect this card was filed about. The two initial
 * buckets are disjoint, so the union is just a concatenation, and each card is
 * re-fetched once — the same one-round-trip-per-flagged-card cost as before,
 * not twice.
 */
async function reconcileCheckDefectsBothBuckets({ missing, vacuous }, opts = {}) {
  const union = [...missing, ...vacuous];
  if (!union.length) return { missing: [], vacuous: [] };
  // Memoize getIssue across BOTH passes so the union costs one round trip per
  // card in total, not one per bucket. Rejections are memoized too — a card
  // whose re-fetch failed must fail the same way for both classifiers, or the
  // two reports would disagree about the same card in the same run.
  const baseGetIssue = opts.getIssue || require('./lib/linear-client.js').getIssue;
  const issueCache = new Map();
  const getIssue = (id) => {
    if (!issueCache.has(id)) issueCache.set(id, Promise.resolve().then(() => baseGetIssue(id)));
    return issueCache.get(id);
  };
  const sharedOpts = { ...opts, getIssue };
  const stillMissing = await reconcileCheckDefectsWithComments(union, auditCardCheckPaths, sharedOpts);
  const stillVacuous = await reconcileCheckDefectsWithComments(union, auditVacuousChecks, sharedOpts);
  return { missing: stillMissing, vacuous: stillVacuous };
}

async function runLinearAudit(limit) {
  const issues = await fetchLinearOpenIssuesWithDescriptions();
  console.error(`[audit-card-verifiability] linear: ${issues.length} open issue(s) fetched`);
  const evaluated = issues.slice(0, limit).map(evaluateLinearIssue);
  const report = buildReport(evaluated);
  const initial = findCardCheckPathDefects(evaluated, { log: console.error });
  const flaggedCount = initial.missing.length + initial.vacuous.length;
  if (flaggedCount) {
    console.error(`[audit-card-verifiability] linear: re-checking ${flaggedCount} flagged card(s) against their own comments (BRO-2796 correction path; ${initial.missing.length} missing-path, ${initial.vacuous.length} vacuous)`);
  }
  const reconciled = await reconcileCheckDefectsBothBuckets(initial, { log: console.error });
  report.missingCheckPaths = reconciled.missing;
  report.vacuousChecks = reconciled.vacuous;
  writeReport(report, LINEAR_REPORT_PATH);
  return report;
}

function runNotionAudit(status, limit) {
  const ids = fetchPendingCardIds(status, limit);
  console.error(`[audit-card-verifiability] notion: ${ids.length} card(s) fetched (status=${status})`);

  const evaluated = [];
  for (const [i, id] of ids.entries()) {
    const card = fetchCard(id);
    if (!card) continue;
    evaluated.push(evaluateCard(card));
    if ((i + 1) % 25 === 0) console.error(`[audit-card-verifiability] ${i + 1}/${ids.length} checked`);
  }

  const report = buildReport(evaluated);
  attachMissingCheckPaths(report, evaluated, { log: console.error });
  writeReport(report, REPORT_PATH);
  return report;
}

function printReport(label, report, reportPath) {
  console.log(`${label} total checked: ${report.total}`);
  console.log(`${label} armed (dispatchable):    ${report.armedCount}`);
  console.log(`${label} refused (undispatchable): ${report.refusedCount}`);
  const kindEntries = Object.entries(report.byKind || {}).sort((a, b) => b[1] - a[1]);
  if (kindEntries.length) {
    console.log(`\n${label} refused by kind:`);
    kindEntries.forEach(([kind, count]) => console.log(`  ${kind}: ${count}`));
  }
  if (report.refused.length) {
    console.log(`\nFirst 15 ${label.toLowerCase()} refused:`);
    report.refused.slice(0, 15).forEach(c => console.log(`  ${c.id} [${c.priority || '?'}] [${c.kind || 'unknown'}] ${c.name} — ${c.reason}`));
  }
  const missingCheckPaths = report.missingCheckPaths || [];
  console.log(`${label} armed but naming a check path (node --test/npx tsx --test/test -f) absent from origin/main: ${missingCheckPaths.length}`);
  if (missingCheckPaths.length) {
    console.log(`\n${label} cards naming a nonexistent check path — evidence, not proof: some are simply a card`);
    console.log(`whose file hasn't been written yet; a reader should judge each before acting:`);
    missingCheckPaths.forEach(c => console.log(`  ${c.id} ${c.name} — ${c.cmd} (missing: ${c.missingPaths.join(', ')})`));
  }
  // BRO-3378. Worded to be unmistakable from the bucket above: that one is
  // "the check can never PASS", this one is "the check can never FAIL". Both
  // can be true of a `test -f` card and only one ever is, so saying which
  // is what makes the pair readable instead of looking like two scoldings of
  // every test -f card.
  const vacuousChecks = report.vacuousChecks || [];
  // Split by polarity in the OUTPUT too, not just in the data: an arity error
  // can never PASS, so printing it under a "cannot fail" heading would state
  // the opposite of the truth about that card (ship-check finding).
  const cannotFail = vacuousChecks.filter(c => c.polarity === 'never-fails');
  const cannotPass = vacuousChecks.filter(c => c.polarity === 'never-passes');
  console.log(`${label} armed but carrying a check that cannot fail (test -f on a file already on origin/main): ${cannotFail.length}`);
  if (cannotFail.length) {
    console.log(`\n${label} cards whose acceptance check is already green before the work starts — re-running it`);
    console.log(`at Done time cannot tell finished work from untouched work (the BRO-423 false-Done class):`);
    cannotFail.forEach(c => console.log(`  ${c.id} [${c.kind}] ${c.name} — ${c.cmd}`));
  }
  if (cannotPass.length) {
    console.log(`\n${label} cards whose acceptance check is malformed and can never pass: ${cannotPass.length}`);
    cannotPass.forEach(c => console.log(`  ${c.id} [${c.kind}] ${c.name} — ${c.cmd} (${c.reason})`));
  }
  console.log(`Report written: ${path.relative(REPO, reportPath)}\n`);
}

async function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const args = parseArgs(process.argv.slice(2));
  const status = typeof args.status === 'string' ? args.status : DEFAULT_STATUS;
  const limit = args.limit ? parseInt(args.limit, 10) : DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) {
    console.error(`--limit must be a positive integer, got ${JSON.stringify(args.limit)}`);
    process.exit(1);
  }
  const source = typeof args.source === 'string' ? args.source.trim().toLowerCase() : 'notion';
  if (!['notion', 'linear'].includes(source)) {
    console.error(`--source must be one of notion, linear — got ${JSON.stringify(args.source)}`);
    process.exit(1);
  }

  const report = source === 'linear' ? await runLinearAudit(limit) : runNotionAudit(status, limit);
  const reportPath = source === 'linear' ? LINEAR_REPORT_PATH : REPORT_PATH;
  printReport(source === 'linear' ? 'Linear' : 'Notion', report, reportPath);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const kindEntries = Object.entries(report.byKind || {}).sort((a, b) => b[1] - a[1]);
    const summary = [
      `## Card Verifiability Audit (${source})`,
      '',
      `| Metric | Count |`,
      `|--------|-------|`,
      `| Total checked | ${report.total} |`,
      `| Armed (dispatchable) | ${report.armedCount} |`,
      `| Refused (undispatchable) | ${report.refusedCount} |`,
      `| Armed but check path absent from origin/main (can never pass) | ${(report.missingCheckPaths || []).length} |`,
      `| Armed but check cannot fail (vacuous \`test -f\`) | ${(report.vacuousChecks || []).length} |`,
      '',
      ...(kindEntries.length ? [
        '### Refused by kind',
        '',
        `| Kind | Count |`,
        `|------|-------|`,
        ...kindEntries.map(([kind, count]) => `| ${kind} | ${count} |`),
        '',
      ] : []),
    ].join('\n');
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
}

if (require.main === module) main().catch(err => { console.error(`[audit-card-verifiability] fatal: ${err.message}`); process.exit(1); });

module.exports = {
  parseArgs, notionBrain, fetchCard, fetchPendingCardIds, evaluateCard, buildReport, writeReport,
  REPORT_PATH, DEFAULT_STATUS, DEFAULT_LIMIT, USAGE,
  // task #1830: Linear audit path — exported for unit coverage.
  evaluateLinearIssue, fetchLinearOpenIssuesWithDescriptions, runLinearAudit, LINEAR_REPORT_PATH,
  // BRO-2977/BRO-3076: exported for unit coverage.
  attachMissingCheckPaths, reconcileMissingCheckPathsWithComments,
  // BRO-3378: vacuous-check bucket — exported for unit coverage.
  reconcileVacuousChecksWithComments, reconcileCheckDefectsWithComments, reconcileCheckDefectsBothBuckets,
};
