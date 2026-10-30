#!/usr/bin/env node
/**
 * BRO-2420: flag scripts that write data/audit/<file> inside a workflow whose
 * commit step never `git add`s it (the write is discarded at job end; BRO-182).
 *
 *   node scripts/audit-orphaned-audit-writes.js           report, exit 0 (advisory)
 *   node scripts/audit-orphaned-audit-writes.js --strict  exit 1 on any orphan
 *   node scripts/audit-orphaned-audit-writes.js --check   exit 1 only on orphans not in the baseline
 *   node scripts/audit-orphaned-audit-writes.js --update-baseline   rewrite the baseline (review the diff)
 *   node scripts/audit-orphaned-audit-writes.js --json
 *
 * Heuristic limits: paths held only in a lib constant/registry (e.g. the
 * ob-venue-candidates entry in core-data-merge-registry.js) are not followed;
 * composite-action staging is not read. a script is matched to a workflow by basename; writes made
 * by a child script or a lib constant are not followed. Documented false
 * positives go in EXEMPT with a reason.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { findOrphanedWrites } = require('./lib/orphaned-audit-writes');
const { hasHelpFlag } = require('./lib/cli-help.js');

// "script|data/audit/file": reason. BRO-5316 reviewed the live source and
// workflow for each exemption. Retained gaps and evidence are documented in
// scripts/orphaned-audit-writes-triage.md. Do not exempt an unstaged durable write.
const EXEMPT = {
  "scripts/audit-coverage-holes.js|data/audit/coverage-holes-decisions.json":
    "read-only: LEDGER is the human decisions input; data-health-check.yml passes --counts=data/audit/coverage-holes.json, not the decisions path",
  "scripts/audit-critic-coverage-bucket.js|data/audit/critic-coverage-audit.json":
    "read-only: readFileSync loads the audit produced by audit-critic-coverage.js; bucket output uses separate paths",
  "scripts/audit-critic-coverage-bucket.js|data/audit/critic-coverage-buckets.json":
    "staged: audit-critic-coverage.yml lists this file in its for-f loop and git adds \"$f\"",
  "scripts/audit-critic-coverage-bucket.js|data/audit/critic-coverage-buckets.md":
    "ephemeral: .gitignore excludes audit Markdown; audit-critic-coverage.yml explicitly skips buckets.md and prints it in the run summary",
  "scripts/audit-critic-coverage.js|data/audit/outlet-heartbeat-state.json":
    "staged: audit-critic-coverage.yml lists this file in its for-f loop and git adds \"$f\"",
  "scripts/audit-critic-coverage.js|data/audit/outlet-heartbeat.json":
    "staged: audit-critic-coverage.yml lists this file in its for-f loop and git adds \"$f\"",
  "scripts/audit-deployed-coverage.js|data/audit/deployed-coverage-diff.json":
    "staged: audit-aggregator-gap.yml lists this file in its audit-state for-f loop and git adds \"$f\"",
  "scripts/audit-notion-schedule-coupling.js|data/audit/dispatch-ledger.jsonl":
    "not a write: path occurs inside a NOTION_COUPLING_ALLOWLIST explanation; this script writes notion-schedule-coupling.json",
  "scripts/audit-opening-night-coverage.js|data/audit/t1-coverage-digest-state.json":
    "staged: audit-aggregator-gap.yml lists this file in its audit-state for-f loop and git adds \"$f\"",
  "scripts/audit-opening-night-coverage.js|data/audit/t1-coverage-ledger.json":
    "staged: audit-aggregator-gap.yml lists this file in its audit-state for-f loop and git adds \"$f\"",
  "scripts/audit-opening-night-coverage.js|data/audit/t1-coverage-signals.json":
    "staged: audit-aggregator-gap.yml lists this file in its audit-state for-f loop and git adds \"$f\"",
  "scripts/audit-opening-night-coverage.js|data/audit/t1-coverage-stats.json":
    "staged: audit-aggregator-gap.yml lists this file in its audit-state for-f loop and git adds \"$f\"",
  "scripts/audit-outlet-ground-truth.js|data/audit/outlet-ground-truth.json":
    "staged: audit-aggregator-gap.yml lists this file in its audit-state for-f loop and git adds \"$f\"",
  "scripts/codex-trust-ladder.js|data/audit/codex-trust-ladder-owner.json":
    "human-only file: the ladder script only reads it (BRO-6263); the bot never writes or stages it, so a bot commit cannot erase an owner edit",
  "scripts/audit-stale-announced-shows.js|data/audit/stale-announced-shows-ack.json":
    "manual mode only: the ack file is rewritten only by --prune-orphan-acks (BRO-5263); data-health-check.yml runs the audit without that flag, and a human commits the pruned file",
  "scripts/produce-press-night-grade-snapshot.js|data/audit/reddit-post-drafts.json":
    "read-only input: the producer only reads the Reddit draft tracker (readJson); its writes are the grade snapshot and card ledger, both staged in press-night-grade.yml",
  "scripts/audit-score-vs-models.js|data/audit/score-vs-models-baseline.json":
    "manual mode only: baseline writes require --write-baseline or --renew-baseline; weekly-integrity.yml invokes neither",
  "scripts/audit-show-review-gap.js|data/audit/gap-audit-checkpoint.json":
    "staged: audit-aggregator-gap.yml lists this file in its audit-state for-f loop and git adds \"$f\"",
  "scripts/audit-show-review-gap.js|data/audit/show-review-gap.json":
    "staged: audit-aggregator-gap.yml lists this file in its audit-state for-f loop and git adds \"$f\"",
  "scripts/audit-show-review-gap.js|data/audit/unknown-aggregator-outlets.json":
    "staged: audit-aggregator-gap.yml lists this file in its audit-state for-f loop and git adds \"$f\"",
  "scripts/audit-show-review-gap.js|data/audit/we-gate-proving.json":
    "staged: audit-aggregator-gap.yml lists this file in its audit-state for-f loop and git adds \"$f\"",
  "scripts/audit-t1-silent-gaps.js|data/audit/autoclear-shadow.jsonl":
    "staged: audit-aggregator-gap.yml lists this file in its audit-state for-f loop and git adds \"$f\"",
  "scripts/audit-t1-silent-gaps.js|data/audit/t1-recovery-state.json":
    "staged: audit-aggregator-gap.yml lists this file in its audit-state for-f loop and git adds \"$f\"",
  "scripts/audit-t1-silent-gaps.js|data/audit/t1-silent-gap-alerts.json":
    "staged: audit-aggregator-gap.yml lists this file in its audit-state for-f loop and git adds \"$f\"",
  "scripts/audit-t1-silent-gaps.js|data/audit/t1-silent-gaps.json":
    "staged: audit-aggregator-gap.yml lists this file in its audit-state for-f loop and git adds \"$f\"",
  "scripts/audit-tour-pages.js|data/audit/tour-audit-last-codes.json":
    "staged: audit-tour-pages.yml lists this file in its for-f loop and git adds \"$f\"",
  "scripts/audit-uncollected-live-reviews.js|data/audit/uncollected-live-reviews.json":
    "staged: audit-aggregator-gap.yml lists this file in its audit-state for-f loop and git adds \"$f\"",
  "scripts/audit-wrong-article.js|data/audit/wrong-article-verified.json":
    "manual mode only: --record-verified/--verify-file write VERIFIED_PATH; data-health-check.yml runs --adjudicate and the default check, which do not",
  "scripts/check-opening-night-drift.js|data/audit/drift-detector-allowlist.json":
    "read-only: ALLOWLIST_FILE is an input; saveState writes the separate drift-state.json, already staged by check-opening-night-drift.yml",
  "scripts/check-provider-spend.js|data/audit/scraper-spend-ledger.jsonl":
    "not a write: this path is alert-description text for missing attribution; outputs are provider-spend-daily.jsonl, provider-spend-snapshot.json and scraper-spend-daily-agg.jsonl",
  "scripts/check-review-count-drift.js|data/audit/rebuild-exclusions-SHOWID.json":
    "not a write: SHOWID is a placeholder in an offender-summary hint; the exclusion report is produced by the rebuild",
  "scripts/check-review-count-drift.js|data/audit/review-suppression-baseline.json":
    "manual mode only: writeSuppressionBaseline runs only with --update-baseline; neither check-review-count-drift.yml nor opening-night-broadcast.yml passes it",
  "scripts/check-score-integrity.js|data/audit/score-integrity.json":
    "ephemeral: .gitignore explicitly excludes this regenerated report; weekly-integrity.yml reads its totalIssues in the same step",
  "scripts/close-stuck-verified-cards.js|data/audit/landings.jsonl":
    "read-only: LANDINGS supplies landing evidence; the writer output is stuck-card-closer.json, already staged by data-health-check.yml",
  "scripts/coverage-adversarial-probe.js|data/audit/coverage-adversarial-probe-status.json":
    "staged: coverage-adversarial-probe.yml lists this file in its for-f loop and git adds \"$f\"",
  "scripts/coverage-adversarial-probe.js|data/audit/coverage-adversarial-probe-trend.jsonl":
    "staged: coverage-adversarial-probe.yml lists this file in its for-f loop and git adds \"$f\"",
  "scripts/coverage-adversarial-probe.js|data/audit/coverage-adversarial-probe.json":
    "staged: coverage-adversarial-probe.yml lists this file in its for-f loop and git adds \"$f\"",
  "scripts/detect-show-changes.js|data/audit/show-changes-digest.json":
    "staged: send-follow-notifications.yml lists this file in its for-f loop and git adds \"$f\"",
  "scripts/disposition-misroute.js|data/audit/slug-misroute-dispositioned.json":
    "manual mode only: cmdAdd writes DISP; audit-cross-production-weekly.yml calls report --email, which only reads dispositions",
  "scripts/health-check.js|data/audit/autofix-canary-ledger.jsonl":
    "read-only: health-check consumes this detector report/ledger or mentions it in a hint; its own write targets are history, digest, triage, workflow coverage and the two local caches documented separately",
  "scripts/health-check.js|data/audit/backlog-drain-ledger.jsonl":
    "read-only: health-check consumes this detector report/ledger or mentions it in a hint; its own write targets are history, digest, triage, workflow coverage and the two local caches documented separately",
  "scripts/health-check.js|data/audit/backlog-drain-metric.json":
    "read-only: health-check consumes this detector report/ledger or mentions it in a hint; its own write targets are history, digest, triage, workflow coverage and the two local caches documented separately",
  "scripts/health-check.js|data/audit/bww-roundup-miss-ledger.jsonl":
    "read-only: health-check consumes this detector report/ledger or mentions it in a hint; its own write targets are history, digest, triage, workflow coverage and the two local caches documented separately",
  "scripts/health-check.js|data/audit/card-verifiability-linear.json":
    "read-only: health-check consumes this detector report/ledger or mentions it in a hint; its own write targets are history, digest, triage, workflow coverage and the two local caches documented separately",
  "scripts/health-check.js|data/audit/census-recall-status.json":
    "read-only: health-check consumes this detector report/ledger or mentions it in a hint; its own write targets are history, digest, triage, workflow coverage and the two local caches documented separately",
  "scripts/health-check.js|data/audit/cloud-memory-drift.json":
    "read-only: health-check consumes this detector report/ledger or mentions it in a hint; its own write targets are history, digest, triage, workflow coverage and the two local caches documented separately",
  "scripts/health-check.js|data/audit/commercial-data-history.json":
    "read-only: health-check consumes this detector report/ledger or mentions it in a hint; its own write targets are history, digest, triage, workflow coverage and the two local caches documented separately",
  "scripts/health-check.js|data/audit/corpus-drift.json":
    "read-only: health-check consumes this detector report/ledger or mentions it in a hint; its own write targets are history, digest, triage, workflow coverage and the two local caches documented separately",
  "scripts/health-check.js|data/audit/coverage-adversarial-probe-status.json":
    "read-only: health-check consumes this detector report/ledger or mentions it in a hint; its own write targets are history, digest, triage, workflow coverage and the two local caches documented separately",
  "scripts/health-check.js|data/audit/coverage-adversarial-probe.json":
    "read-only: health-check consumes this detector report/ledger or mentions it in a hint; its own write targets are history, digest, triage, workflow coverage and the two local caches documented separately",
  "scripts/health-check.js|data/audit/cwv-results.json":
    "read-only: health-check consumes this detector report/ledger or mentions it in a hint; its own write targets are history, digest, triage, workflow coverage and the two local caches documented separately",
  "scripts/health-check.js|data/audit/digest-autofix-ledger.jsonl":
    "read-only: health-check consumes this detector report/ledger or mentions it in a hint; its own write targets are history, digest, triage, workflow coverage and the two local caches documented separately",
  "scripts/health-check.js|data/audit/digest-invariant-fail-ledger.jsonl":
    "read-only: health-check consumes this detector report/ledger or mentions it in a hint; its own write targets are history, digest, triage, workflow coverage and the two local caches documented separately",
  "scripts/health-check.js|data/audit/dispatch-ledger.jsonl":
    "read-only: health-check consumes this detector report/ledger or mentions it in a hint; its own write targets are history, digest, triage, workflow coverage and the two local caches documented separately",
  "scripts/health-check.js|data/audit/dispatch-outcome-digest-state.json":
    "local mode only: checkDispatchOutcomes returns before the state write when gitignored per-machine dispatch-ledger.jsonl is absent, as on a fresh data-health-check.yml runner",
  "scripts/health-check.js|data/audit/dmarc-summary.json":
    "read-only: health-check consumes this detector report/ledger or mentions it in a hint; its own write targets are history, digest, triage, workflow coverage and the two local caches documented separately",
  "scripts/health-check.js|data/audit/exclusion-summary-yesterday.json":
    "local cache: ignored exclusion-log counts; buildExclusionSummaryHtml returns from its committed daily-totals fallback in CI before this write when local exclusions JSONL is absent",
  "scripts/health-check.js|data/audit/infra-review-gate.jsonl":
    "read-only: health-check consumes this detector report/ledger or mentions it in a hint; its own write targets are history, digest, triage, workflow coverage and the two local caches documented separately",
  "scripts/health-check.js|data/audit/mezzanine-coverage.json":
    "read-only: health-check consumes this detector report/ledger or mentions it in a hint; its own write targets are history, digest, triage, workflow coverage and the two local caches documented separately",
  "scripts/health-check.js|data/audit/ob-aggregator-rejections.json":
    "read-only: health-check consumes this detector report/ledger or mentions it in a hint; its own write targets are history, digest, triage, workflow coverage and the two local caches documented separately",
  "scripts/health-check.js|data/audit/ob-closing-candidates.json":
    "read-only: health-check consumes this detector report/ledger or mentions it in a hint; its own write targets are history, digest, triage, workflow coverage and the two local caches documented separately",
  "scripts/health-check.js|data/audit/ob-venue-candidates.json":
    "read-only: health-check consumes this detector report/ledger or mentions it in a hint; its own write targets are history, digest, triage, workflow coverage and the two local caches documented separately",
  "scripts/health-check.js|data/audit/opening-night-history.json":
    "read-only: health-check consumes this detector report/ledger or mentions it in a hint; its own write targets are history, digest, triage, workflow coverage and the two local caches documented separately",
  "scripts/health-check.js|data/audit/progress-watch-state.json":
    "read-only: health-check consumes this detector report/ledger or mentions it in a hint; its own write targets are history, digest, triage, workflow coverage and the two local caches documented separately",
  "scripts/health-check.js|data/audit/reverse-discovery-candidates.json":
    "read-only: health-check consumes this detector report/ledger or mentions it in a hint; its own write targets are history, digest, triage, workflow coverage and the two local caches documented separately",
  "scripts/health-check.js|data/audit/reverse-discovery-state.json":
    "read-only: health-check consumes this detector report/ledger or mentions it in a hint; its own write targets are history, digest, triage, workflow coverage and the two local caches documented separately",
  "scripts/health-check.js|data/audit/seo-health.json":
    "read-only: health-check consumes this detector report/ledger or mentions it in a hint; its own write targets are history, digest, triage, workflow coverage and the two local caches documented separately",
  "scripts/health-check.js|data/audit/star-score-mismatch-baseline.json":
    "read-only: health-check consumes this detector report/ledger or mentions it in a hint; its own write targets are history, digest, triage, workflow coverage and the two local caches documented separately",
  "scripts/health-check.js|data/audit/t1-silent-gaps.json":
    "read-only: health-check consumes this detector report/ledger or mentions it in a hint; its own write targets are history, digest, triage, workflow coverage and the two local caches documented separately",
  "scripts/health-check.js|data/audit/tour-autocreate.json":
    "read-only: health-check consumes this detector report/ledger or mentions it in a hint; its own write targets are history, digest, triage, workflow coverage and the two local caches documented separately",
  "scripts/health-check.js|data/audit/tour-dates.json":
    "read-only: health-check consumes this detector report/ledger or mentions it in a hint; its own write targets are history, digest, triage, workflow coverage and the two local caches documented separately",
  "scripts/health-check.js|data/audit/uncollected-live-reviews.json":
    "read-only: health-check consumes this detector report/ledger or mentions it in a hint; its own write targets are history, digest, triage, workflow coverage and the two local caches documented separately",
  "scripts/health-check.js|data/audit/unknown-aggregator-outlets.json":
    "read-only: health-check consumes this detector report/ledger or mentions it in a hint; its own write targets are history, digest, triage, workflow coverage and the two local caches documented separately",
  "scripts/health-check.js|data/audit/validation-baseline.json":
    "read-only: health-check consumes this detector report/ledger or mentions it in a hint; its own write targets are history, digest, triage, workflow coverage and the two local caches documented separately",
  "scripts/health-check.js|data/audit/waltz-model-fit.json":
    "read-only: health-check consumes this detector report/ledger or mentions it in a hint; its own write targets are history, digest, triage, workflow coverage and the two local caches documented separately",
  "scripts/newsletter/generate.mjs|data/audit/score-public-since.json":
    "read-only: newTourScoresSection reads score stamps; generate writes newsletter HTML and newsletter-state.json, not score stamps",
  "scripts/newsletter/pre-send-check.mjs|data/audit/gap-audit-checkpoint.json":
    "read-only: coverage freshness inputs; pre-send-check rewrites only the newsletter HTML",
  "scripts/newsletter/pre-send-check.mjs|data/audit/show-review-gap.json":
    "read-only: coverage freshness inputs; pre-send-check rewrites only the newsletter HTML",
  "scripts/opening-night-checklist.js|data/audit/drift-state.json":
    "read-only: loadDriftState supplies checklist input; drift state is written by check-opening-night-drift.js",
  "scripts/outlet-feed-reconcile.js|data/audit/outlet-feed-reconcile.json":
    "staged: audit-aggregator-gap.yml lists this file in its audit-state for-f loop and git adds \"$f\"",
  "scripts/outlet-feed-reconcile.js|data/audit/outlet-poller-rejected-urls.json":
    "read-only: REJECTED_PATH is the poller cache input; reconciliation writes OUT_PATH (outlet-feed-reconcile.json)",
  "scripts/process-feedback.js|data/audit/feedback-run-report.json":
    "private ephemeral: report contains reader names, emails and messages; .gitignore forbids publishing it; process-feedback.yml enriches it and notify-feedback-outcomes.js consumes it in the same run",
  "scripts/produce-coverage-digest-snapshot.js|data/audit/coverage-digest-snapshot.json":
    "staged: audit-aggregator-gap.yml lists this file in its audit-state for-f loop and git adds \"$f\"",
  "scripts/produce-coverage-digest-snapshot.js|data/audit/outlet-feed-reconcile.json":
    "read-only: GAP_AUDIT_PATH and FEED_RECONCILE_PATH are inputs; the only output is coverage-digest-snapshot.json",
  "scripts/produce-coverage-digest-snapshot.js|data/audit/show-review-gap.json":
    "read-only: GAP_AUDIT_PATH and FEED_RECONCILE_PATH are inputs; the only output is coverage-digest-snapshot.json",
  "scripts/promote-owe-venue-candidates.js|data/audit/reverse-discovery-candidates.json":
    "read-only: stageGuardianRows reads reverseDiscoveryPath and writes candidates to the separate owe-venue-candidates staging file",
  "scripts/record-arm-yield.js|data/audit/arm-yield-ledger.jsonl":
    "staged: check-arm-yield.yml lists this file in its for-f loop and git adds \"$f\"",
  "scripts/scrape-tony-nominees.js|data/audit/tony-coverage-gaps.json":
    "not invoked: update-tony-awards.yml mentions this command only inside the quoted ISSUE_EOF issue-body heredoc; its executable scraper is scrape-tony-awards.js",
  "scripts/send-follow-notifications.js|data/audit/follow-send-checkpoint.json":
    "staged: send-follow-notifications.yml lists this file in its for-f loop and git adds \"$f\"",
  "scripts/send-follow-notifications.js|data/audit/show-changes-digest.json":
    "staged: send-follow-notifications.yml lists this file in its for-f loop and git adds \"$f\"",
  "scripts/shadow-autoclear-report.js|data/audit/autoclear-shadow-report.json":
    "staged: audit-aggregator-gap.yml lists this file in its audit-state for-f loop and git adds \"$f\"",
  "scripts/shadow-autoclear-report.js|data/audit/autoclear-shadow.jsonl":
    "read-only: SHADOW_LOG is the input appended by audit-t1-silent-gaps.js; this script writes autoclear-shadow-report.json",
  "scripts/sweep-open-backlog-acceptance.js|data/audit/landings.jsonl":
    "read-only: BRO-3034 reads land.yml's landing ledger to report shipped-but-open cards; never writes it",
  "scripts/time-to-publish-sla.js|data/audit/stage-latency.jsonl":
    "read-only: DEFAULT_LOG is the stage-event input; this script writes time-to-publish-sla.json, already staged by data-health-check.yml",
  "scripts/update-cron-health-state.js|data/audit/cron-health-state.json":
    "staged: check-cron-health.yml lists this file in its for-f loop and git adds \"$f\"",
};

// Remaining reviewed persistence gaps (BRO-5316). --check fails on NEW
// orphans; --update-baseline must remove resolved gaps in the same change.
const BASELINE_PATH = path.join(__dirname, '.orphaned-audit-writes-baseline.json');
const keyOf = (o) => `${o.script}|${o.file}`;

function loadBaseline() {
  try { return new Set(JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))); } catch { return new Set(); }
}

function readTree(dir, exts, rootRel) {
  const out = {};
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      if (name === 'node_modules') continue;
      Object.assign(out, readTree(full, exts, `${rootRel}/${name}`));
    } else if (exts.some((e) => name.endsWith(e))) {
      out[`${rootRel}/${name}`] = fs.readFileSync(full, 'utf8');
    }
  }
  return out;
}

function run(root = path.join(__dirname, '..')) {
  const all = readTree(path.join(root, 'scripts'), ['.js', '.mjs', '.ts'], 'scripts');
  const scripts = {};
  for (const [k, v] of Object.entries(all)) if (!/\/(lib|codex)\//.test(k) && !/\.test\./.test(k)) scripts[k] = v;
  const workflows = readTree(path.join(root, '.github/workflows'), ['.yml', '.yaml'], '.github/workflows');
  return findOrphanedWrites(scripts, workflows, EXEMPT);
}

if (require.main === module) {
  if (hasHelpFlag(process.argv.slice(2))) {
    console.log('usage: node scripts/audit-orphaned-audit-writes.js [--json] [--check] [--strict] [--update-baseline]');
    process.exit(0);
  }
  const orphans = run();
  if (process.argv.includes('--json')) console.log(JSON.stringify(orphans, null, 2));
  else {
    console.log(`[audit-orphaned-audit-writes] ${orphans.length} orphaned audit write(s)`);
    for (const o of orphans) console.log(`  ${o.script} writes ${o.file}; never staged by ${o.workflows.join(', ')}`);
  }
  if (process.argv.includes('--update-baseline')) {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(orphans.map(keyOf), null, 2) + '\n');
    console.log(`baseline written: ${orphans.length} entries`);
  }
  if (process.argv.includes('--check')) {
    const base = loadBaseline();
    const fresh = orphans.filter((o) => !base.has(keyOf(o)));
    for (const o of fresh) console.error(`NEW orphan: ${o.script} writes ${o.file} but ${o.workflows.join(', ')} never git-adds it`);
    if (fresh.length) process.exit(1);
  }
  if (process.argv.includes('--strict') && orphans.length) process.exit(1);
}

module.exports = { run, EXEMPT, keyOf, loadBaseline };
