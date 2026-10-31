#!/usr/bin/env node
/**
 * Daily Data Health Check
 *
 * Monitors all automated pipelines for silent failures.
 * Checks across 9 categories:
 *   A. Data Freshness (7) — are data files up to date?
 *   B. Data Sync (4) — do derived files match source files?
 *   C. Pipeline Health (6) — did critical workflows run recently? (warn only)
 *   D. Content Quality (1) — is scored review percentage healthy?
 *   E. Cookie Expiration (1) — are paywall cookies still valid?
 *   F. Core Web Vitals (1) — Lighthouse performance regressions
 *   G. SEO Health (1) — index coverage and traffic anomalies
 *   H. Cron Health (6) — are critical scheduled workflows running?
 *   I. Secrets Health (1) — last check-secrets-health run status
 *   J. API Credits (1) — ScrapingBee credit balance
 *
 * Progressive alerting:
 *   - Digest snapshot: always (data/audit/health-digest-snapshot.json — card #364,
 *     folded into the autonomous loop's single scheduled morning email instead
 *     of sending its own "BSC Daily"/"BSC URGENT" email via Resend)
 *   - #weekly-reports: always (Discord daily summary)
 *   - #alerts: only after 2+ consecutive error days
 *
 * Triage state: writes per-system files to data/audit/triage/ for auto-triage pipeline.
 * Auto-triage issue: creates GitHub issue with 'auto-triage' label for persistent errors.
 *
 * Exit codes: 0 = pass/warn or first-day errors, 1 = persistent errors (2+ days)
 */

const { isReviewTextFile } = require('./lib/review-text-sidecars');
const fs = require('fs');
const { readWorkflowFilesOrFailClosed } = require('./lib/workflow-glob-guard.js');
const path = require('path');
const crypto = require('crypto');
const { execSync, execFileSync } = require('child_process');
const { getTodayJsonlPath } = require('./lib/exclusion-logger');
const { classifyHealthCheck } = require('./lib/digest-audience');
const { computeCommercialModelDriftStatus } = require('./lib/commercial-model-drift');
const { checkBizOgCoverage, RENDER_HINT: BIZ_OG_RENDER_HINT } = require('./lib/audit-biz-og-coverage');
const { fitCheckStatus: waltzFitCheckStatus } = require('./lib/waltz-model-fit');
const { revisitBarStatus } = require('./lib/recoupment-timing-report');
const { summarizeMissedForHealth } = require('./lib/missed-broadcasts');
const { selectUnroutedVisitorRows } = require('./lib/start-now-filing.js');
const { playbookWorkerHint, hasPlaybookAction, ownerDigestInstruction } = require('./lib/playbook-copy.js');
const { untrackedPersistentRowsResult, ROW_NAME: UNTRACKED_ROWS_ROW_NAME } = require('./lib/untracked-persistent-rows.js');
// BRO-5168: card filings per run for failing rows with no playbook route.
const MAX_UNROUTED_FILINGS_PER_RUN = 4;
const { routeAlert, resolveQuietConditions, resolveAbsentConditions, readDispatchAttempts, peekDigestQueue, clearDigestQueue, toSnapshotQueuedRow } = require('./lib/owner-alert-router.js');
const { clearedHealthCheckKeys } = require('./lib/health-row-check-cmd.js');
const { summarizeFailureStreak, deadmanShouldPage } = require('./lib/alert-dispatch-streak.js');
const { readOwnerEmailLog } = require('./lib/discord-notify.js');
const { SCRAPINGBEE_ACKNOWLEDGED_EXHAUSTION, isScrapingBeeExhaustionAcknowledged } = require('./lib/scrapingbee-ack');
const { evaluateScrapingdogCredits } = require('./lib/scrapingdog-ack');
const { cachedShell, cachedFetch, hasLowHeadroom } = require('./lib/gh-api-cache.js');
const { fetchGitHubJSON } = require('./lib/gh-api-client.js');
const { summarizeRepeatFailures, enrichRepeatFailureSteps, repeatFailureLabel, isRepeatFailureSelfHealed, isGateWorkflowBroken, GATE_WORKFLOWS } = require('./lib/workflow-repeat-failures.js');
const { assessAutofixEffectiveness, CHECK_NAME: AUTOFIX_EFFECTIVENESS_CHECK_NAME } = require('./lib/autofix-effectiveness');
const { listShowDirs } = require('./lib/list-show-dirs');
const { isBroadwayCategory } = require('./lib/venue-classification');
const { assessMainRedStreak } = require('./lib/main-red-streak.js');

// BRO-2767: run history is read through the Actions REST endpoint, NEVER through
// `gh run list --limit=N`. On this repo (6,600+ test.yml runs on main) the gh
// CLI's paginated run listing returns arbitrary, sometimes months-stale result
// SETS, not merely a mis-ordered page: three identical invocations about a
// minute apart on 2026-09-04 returned Sep 3-4 runs, then Aug 26-29 runs, then
// Aug 5 runs, with core rate limit at 5000/5000 and the documented full
// workflow path in use. Every consumer here assumes newest-first, so a stale
// page silently produces a wrong verdict (see checkMainRedStreak's firstRedSha).
// The REST endpoint the CLI wraps is stable and correctly ordered.
// gh expands the literal {owner}/{repo} placeholder from the current checkout,
// which is how the `gh run list` calls this replaced resolved their repository.
// Deliberately NOT process.env.GITHUB_REPOSITORY with a hardcoded fallback: in a
// fork, a reusable workflow, or a leaked CI env that silently queries the wrong
// repository and reports plausible green/red health for it (codex review).
const GH_REPO_PLACEHOLDER = '{owner}/{repo}';

// Bump when the SHAPE of a cached run-history payload changes. cachedShell()
// (scripts/lib/gh-api-cache.js) keys purely on the string it is handed and
// stores results in an OS-temp file SHARED by every concurrent process on this
// Mac — including sessions still running an older health-check.js. Without a
// version in the key, this change (bare timestamp -> JSON array for
// push-verify, gh-run-list-derived -> REST-derived rows for the others) would
// let old-shape and new-shape values be served to each other's parsers for a
// TTL at a time, in both directions, which is also what makes rollback unsafe.
const RUN_CACHE_VERSION = 'v2';

/**
 * Version-scoped cache key for a run-history read.
 * @param {string} suffix - stable per-call-site suffix, e.g. 'cron:test.yml'
 * @returns {string} cache key carrying RUN_CACHE_VERSION
 */
function runCacheKey(suffix) {
  return `${suffix}:${RUN_CACHE_VERSION}`;
}

/**
 * Build the gh invocation that lists runs for one workflow, newest-first.
 * Deliberately `gh api`, not `gh run list` — see the BRO-2767 note above.
 *
 * @param {string} workflowFile - workflow filename, e.g. 'test.yml'
 * @param {object} [opts]
 * @param {number} [opts.limit=1] - per_page
 * @param {string} [opts.branch] - restrict to a branch
 * @param {string} [opts.status] - restrict to a run status, e.g. 'success'
 * @param {string} [opts.event] - restrict to a trigger event, e.g. 'schedule'
 * @returns {string} shell command emitting a JSON array of
 *   {databaseId, headSha, createdAt, conclusion}
 */
function ghRunsQuery(workflowFile, opts = {}) {
  const { limit = 1, branch, status, event } = opts;
  // `gh run list --limit` paginated past 100; the REST endpoint silently caps
  // per_page at 100 and returns a SHORTER window than asked for, which for a
  // streak scan reads as "the streak ended here". Fail loudly instead.
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error(`ghRunsQuery: limit must be an integer 1-100 (per_page cap), got ${limit}`);
  }
  const params = [`per_page=${limit}`];
  if (branch) params.push(`branch=${branch}`);
  if (status) params.push(`status=${status}`);
  if (event) params.push(`event=${event}`);
  const jq = '[.workflow_runs[] | {databaseId: .id, headSha: .head_sha, createdAt: .created_at, conclusion: .conclusion}]';
  return `gh api "repos/${GH_REPO_PLACEHOLDER}/actions/workflows/${workflowFile}/runs?${params.join('&')}" --jq '${jq}'`;
}

/**
 * createdAt of the newest run in a ghRunsQuery() payload, or '' when there are
 * none. Replaces the old `-q '.[0].createdAt'`, which trusted the transport's
 * first row; this sorts before taking the head.
 *
 * @param {string} raw - stdout of a ghRunsQuery() invocation
 * @returns {string} ISO timestamp, or '' when no run matched
 */
function firstRunCreatedAt(raw) {
  if (!raw) return '';
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return ''; }
  const sorted = sortRunsNewestFirst(parsed);
  return (sorted[0] && sorted[0].createdAt) || '';
}

/**
 * Newest-first by createdAt. Called at every parse site rather than trusting
 * the transport's ordering, so the assumption lives where it is depended on.
 * Unparseable/missing createdAt sorts last instead of throwing.
 *
 * @param {Array<object>} runs
 * @returns {Array<object>} new array, newest first
 */
function sortRunsNewestFirst(runs) {
  if (!Array.isArray(runs)) return [];
  return runs.slice().sort((a, b) => {
    const ta = Date.parse(a && a.createdAt);
    const tb = Date.parse(b && b.createdAt);
    if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
    if (Number.isNaN(ta)) return 1;
    if (Number.isNaN(tb)) return -1;
    return tb - ta;
  });
}
// BRO-2603: makes the BRO-385 ledger freeze (data/audit/BRO-385-ledger-freeze.json,
// 2026-08-26 -> 2026-09-25) actually suppress card filing for the checks below
// that are sourced from a frozen ledger, instead of the record just sitting
// unread. See AUTO_FIX_PLAYBOOK entries with a `ledger` field.
const { FROZEN_LEDGERS, isLedgerFrozenNow, freezeSkipMessage } = require('./freeze-ledgers.js');
// Reused (never re-typed) by the two AUTO_FIX_PLAYBOOK entries below — a
// literal string here that drifted from FROZEN_LEDGERS would silently defeat
// suppression (code-review finding, BRO-2603).
const DISPATCH_LEDGER_NAME = FROZEN_LEDGERS.find((l) => l.endsWith('dispatch-ledger.jsonl'));
// Discord daily reports removed — email digest is the single notification channel.

// Generate a signed one-tap approve URL for a fix workflow.
// Returns '' if ALERT_TOKEN_SECRET is not set.
function generateApproveUrl(workflowFile, alertTitle) {
  const secret = process.env.ALERT_TOKEN_SECRET;
  if (!secret || !workflowFile) return '';
  const payload = { fixId: workflowFile, alertTitle, expiry: Date.now() + 86400000 };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(encoded).digest('hex');
  return `https://broadwayscorecard.com/api/dispatch-alert-fix?token=${encodeURIComponent(`${encoded}.${sig}`)}`;
}
// Critical workflow failures still alert via notify-failure composite action.

// BRO-3349: the ONE definition of "is the provider-spend ledger stale?" —
// shared with its producer (scripts/check-provider-spend.js, which
// re-exports these). Imported from provider-spend-core.js rather than from
// the CLI: the CLI has top-level side effects (hasHelpFlag/process.exit,
// argv-derived DAY) that would fire on require. provider-spend-core.js does
// pull in provider-telemetry/browserbase-caps, but neither does I/O, reads
// env, or cycles at require time (verified, ship-check/Codex).
const { ledgerFreshnessHours, lastLedgerDay, STALE_HOURS_THRESHOLD: PROVIDER_SPEND_STALE_HOURS } = require('./lib/provider-spend-core');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { sbUsageFields } = require('./lib/provider-billing'); // BRO-3010: SB /usage field names live in one place

// --help must print usage and exit BEFORE any side effect (BRO-1711).
if (require.main === module && hasHelpFlag(process.argv.slice(2))) {
  console.log('Usage: node scripts/health-check.js [options]\nSee the header comment of this script for options. --help/-h prints this and exits without side effects.');
  process.exit(0);
}
const DATA_DIR = path.join(__dirname, '..', 'data');
const AUDIT_DIR = path.join(DATA_DIR, 'audit');
const PIPELINE_DIR = path.join(AUDIT_DIR, 'pipeline-health');
const TRIAGE_DIR = path.join(AUDIT_DIR, 'triage');
const HISTORY_FILE = path.join(AUDIT_DIR, 'health-check-history.json');
// Card #364 (owner merge decision 2026-07-26): health-check.js no longer emails
// its own "BSC Daily"/"BSC URGENT" digest. It writes results here instead;
// autonomous-email.js reads this snapshot and folds it into the single
// scheduled morning email — one email/day, not two.
const HEALTH_DIGEST_SNAPSHOT_FILE = path.join(AUDIT_DIR, 'health-digest-snapshot.json');

// --- Auto-Fix Playbook ---
// Maps health check names (regex) to automated fixes or human-readable instructions.
// `workflow`: dispatched automatically via `gh workflow run` (user sees "Auto-fixed").
// `humanAction`: legacy single text shown to the owner AND used as the card hint.
// `ownerText` + `workerInstruction` (BRO-5543, preferred): ownerText is what
//   the owner reads (what broke, what the automation does; an owner action
//   only for a login, a payment or a decision; plain English, no em dashes).
//   workerInstruction is the filed card's hint and never reaches the owner.
//   Read both through scripts/lib/playbook-copy.js, never the raw fields.
// `urgency`: 'fix-now' (red), 'this-week' (yellow), 'low' (gray).

const AUTO_FIX_PLAYBOOK = [
  // Card #1199. A check with NO playbook entry defaults to urgency 'low'
  // (~L3271), which drops it out of `actionable` entirely: it never reaches
  // routeAlert, and renders as an anonymous "+N low-priority items monitoring
  // themselves (no action needed)" line — no name, no rate, no hint. For a
  // check whose entire purpose is to end a chronic failure's invisibility,
  // that would have shipped the measurement invisible, which is the exact
  // defect the card exists to close (caught by the ship-check reviewer).
  // 'this-week', not 'fix-now': the retry layer recovers the WORK, so a high
  // dead rate is expensive and worth chasing but never data loss.
  // `ledger`: BRO-2603 — this check is sourced from dispatch-ledger.jsonl, one
  // of the 7 ledgers BRO-385 froze. The actionable-dispatch loop below skips
  // filing a card for it while that ledger is frozen (falls back to the same
  // "no card, show the raw instruction" path already used when
  // MAX_CARD_DISPATCHES_PER_RUN caps out).
  { match: /^Dispatch health: dead-launch rate$/, urgency: 'this-week', ledger: DISPATCH_LEDGER_NAME,
    ownerText: "More than 1 in 10 automatic work launches start but never run their command. The retry layer redoes the work, so nothing is lost, but each failure wastes a launch. Nothing is needed from you.",
    workerInstruction: "Run `node scripts/audit-dispatch-dead-rate.js` for the per-day/per-lane breakdown, then investigate the dispatch dead-launch rate (card #1199). Judge any fix by this rate over a week, never by one clean dispatch." },
  // Card #1714, same #1199 trap: an unregistered check name defaults to
  // urgency 'low' and never files a card even on 'error'. 'this-week' to
  // match its sibling dead-launch row — a low headless success rate is
  // expensive (burned launches, stuck tasks) but the retry/reconcile layer
  // means nothing is silently lost.
  // `ledger`: same BRO-2603 note as the dead-launch-rate entry above — also
  // sourced from dispatch-ledger.jsonl.
  { match: /^Headless dispatch: success rate$/, urgency: 'this-week', ledger: DISPATCH_LEDGER_NAME,
    ownerText: "Background work sessions are succeeding less than 80% of the time. Unfinished work is retried, so nothing is lost. Nothing is needed from you.",
    workerInstruction: "Run `node scripts/audit-headless-outcome-rate.js` for the per-task breakdown, then investigate the headless dispatch success rate (card #1714). Judge any fix by this rate over the window, never by one clean dispatch." },
  // Task #1648, same #1199 trap: without an explicit entry this row defaults
  // to urgency 'low' and renders as an anonymous count instead of a named
  // FAIL — for a check whose whole purpose is ending a silent digest-content
  // regression, that would ship the exact invisibility the card exists to
  // close. 'fix-now': a tripped invariant means the LIVE owner-facing email
  // already shipped wrong content, not a risk of it.
  { match: /^Digest: content-invariant check$/, urgency: 'fix-now',
    ownerText: "The morning email broke one of its own content rules (for example, a section that should be gone came back). The email still went out. Nothing is needed from you.",
    workerInstruction: "Find the digest content-invariant FAIL named in this check: run `node scripts/send-morning-digest.js --dry-run`, compare data/audit/morning-digest-preview.html against scripts/lib/digest-content-invariants.js, and fix the regression." },
  // Freshness — all auto-fixable via workflow dispatch
  { match: /^Freshness: reviews\.json$/, urgency: 'fix-now', workflow: 'rebuild-reviews.yml',
    humanFallback: 'The review scores database is out of date. This usually fixes itself overnight.' },
  { match: /^Freshness: shows\.json$/, urgency: 'fix-now', workflow: 'update-show-status.yml',
    humanFallback: 'The show database is out of date. This usually fixes itself overnight.' },
  { match: /^Freshness: grosses\.json$/, urgency: 'this-week', workflow: 'weekly-grosses.yml',
    humanFallback: 'Box office data is out of date. Updated weekly — may just be a slow week.' },
  { match: /^Freshness: audience-buzz\.json$/, urgency: 'this-week', workflow: 'update-show-score.yml',
    humanFallback: 'Audience scores are out of date.' },
  { match: /^Audience coverage: open-show gaps$/, urgency: 'this-week',
    ownerText: "A running show has audience ratings on another site that are not linked to it yet, usually because the title or theater name does not match. Nothing is needed from you.",
    workerInstruction: "The check message names the source(s) and the override knob (MEZZANINE_OVERRIDES in scrape-mezzanine-audience.js, or THEATR_OVERRIDES in scrape-theatr-audience.js; they are separate). Add the override for the flagged show and re-run that source's scraper. Details in data/audit/mezzanine-coverage.json / theatr-coverage.json." },
  // BRO-6336: 180 deep-research results sat unreviewed for four months. The verified auto-apply pass
  // (commercial-pending-daily.yml) should keep the queue near empty; this fires when it does not.
  { match: /^Commercial pending-review queue$/, urgency: 'fix-now', workflow: 'commercial-pending-daily.yml',
    humanFallback: 'Profitability Scorecard research results are piling up unreviewed. The daily automatic check, which applies what a source page confirms, is being re-run. Nothing is needed from you.' },
  // BRO-6471: the owner does not read Linear, so a held row is a worker's job. workerFixable files the card
  // START-NOW instead of parked. Keep the decision wording mid-sentence (headless-dispatchability.js refuses a
  // card whose own line starts with it).
  { match: /^Commercial: rows held for a person$/, urgency: 'this-week', workerFixable: true,
    ownerText: 'Some Profitability Scorecard research results need a closer look than the automatic check can give. A worker is settling them. Nothing is needed from you.',
    workerInstruction: 'Settle every row named in the message (data/commercial-pending-review.json). Check each claim against public sources only, never private investor figures. A confirmed figure goes in through a data/pending-fixes plan (node scripts/new-fix-plan.js) or node scripts/apply-commercial-pending.js --release-held=SLUG for a figures-only row; a reader tip (detectedBy github-tip) needs its own independent source first. Then record the outcome with node scripts/review-pending-commercial.js --decisions=FILE (applied, rejected, duplicate or unverifiable, with a reason). Only if a row is truly the owner\'s call, file a separate card that opens with a plain-English DECISION NEEDED question, options and a recommendation, which emails the owner; never leave a row waiting on the owner in Linear.' },
  // BRO-6478: catch-all for cards that wait on a person with nobody told. A worker settles each one (the
  // owner does not read Linear). Wording avoids the stop-sign phrases headless-dispatchability.js reads, so the
  // card files START-NOW; start-now-filing.js lets a workerFixable entry through the internal-category check.
  { match: /^Dispatch: owner-judgment cards without owner notification$/, urgency: 'this-week', workerFixable: true,
    ownerText: 'Some board cards were waiting on a person without anyone being told. A worker is settling them. Nothing is needed from you.',
    workerInstruction: 'Work the cards named in the message, one at a time (list: data/audit/card-verifiability-linear.json, ownerJudgmentLimbo.cards). For each, first check its premise against live state: run the commands, read the code, use this session\'s tools and keys, and never write "no access" before trying them. Doable work: add a safe-form check line as a comment and do the work, or cancel the card with the evidence. If a real choice remains for the person who runs the site, add a plain-English question on its own line (the word DECISION NEEDED and a colon), with the options and your recommendation, to the card description (docs/owner-email-guidelines.md; run node scripts/lib/owner-decision-recall.js "<topic>" first in case they already answered). A question a check or a worker can settle is never theirs to answer.' },
  { match: /^Freshness: commercial\.json$/, urgency: 'low', workflow: 'commercial-weekly.yml',
    humanFallback: 'Commercial data is out of date.' },
  // BRO-6159: advisory only; persistent gaps use the existing alert router.
  { match: /^Commercial: season share cards$/, urgency: 'this-week',
    humanAction: BIZ_OG_RENDER_HINT },
  { match: /^Freshness: critic-consensus\.json$/, urgency: 'low', workflow: 'update-critic-consensus.yml',
    humanFallback: 'Critic consensus summaries are out of date.' },
  { match: /^Freshness: lottery-rush\.json$/, urgency: 'fix-now', workflow: 'update-lottery-rush.yml',
    humanFallback: 'Lottery/rush data is out of date. Workflow runs hourly — stale >48h means it is failing silently, or running without producing output.' },
  { match: /^Freshness: cast-changes\.json$/, urgency: 'this-week', workflow: 'update-cast-changes.yml',
    humanFallback: 'Cast change tracking is out of date. Runs Wednesday and Saturday — stale >5 days means the workflow is failing.' },
  { match: /^Freshness: nyt-critics-picks\.json$/, urgency: 'this-week', workflow: 'weekly-nyt-critics-picks.yml',
    humanFallback: 'NYT Critics Picks list is out of date. Runs Mon/Wed/Fri — stale >3 days means the workflow is failing.' },
  { match: /^Freshness: video-reviews\.json$/, urgency: 'this-week', workflow: 'weekly-video-reviews.yml',
    humanFallback: 'Video reviews data is out of date. Runs Mondays — stale >2 weeks means the workflow is failing.' },
  // BRO-2476: one entry per data/audit freshness row ("Freshness: audit/<file>"),
  // generated from AUDIT_FRESHNESS_CHECKS so a new row can never ship without
  // its playbook entry (asserted in tests/unit/audit-freshness-checks.test.mjs).
  ...require('./lib/audit-freshness-checks').auditFreshnessPlaybookEntries(),
  // No `workflow` — there's no automated fix, this just needs a human to look
  // at the scoring workflow's polling. 'this-week' (not fix-now): a batch
  // between 12-48h in flight is within the vendor's normal turnaround, not an
  // emergency by itself — only worth paging once it recurs (see task #547).
  { match: /^Scoring: batch state$/, urgency: 'this-week',
    humanFallback: 'The nightly review-scoring batch is taking longer than expected to come back from the AI vendor. It usually resolves on its own within a day — this needs attention if it keeps recurring.' },

  // Sync — some auto-fixable
  { match: /^Sync: review-texts vs reviews\.json$/, urgency: 'fix-now', workflow: 'rebuild-reviews.yml',
    humanFallback: 'Review database is out of sync with source files.' },
  { match: /^Sync: cast coverage$/, urgency: 'this-week',
    ownerText: "Some open Broadway shows are missing their cast lists. Nothing is needed from you.",
    workerInstruction: "Run `node scripts/backfill-cast.js` to repopulate cast data for open shows, then confirm the Sync: cast coverage row clears." },
  { match: /^Sync: open show coverage$/, urgency: 'this-week',
    ownerText: "Some open shows are missing reviews or box office numbers. Nothing is needed from you.",
    workerInstruction: "Find which open shows are missing reviews or grosses data and collect reviews for them." },
  { match: /^Sync: baseline drift$/, urgency: 'this-week',
    ownerText: "The overall data counts have moved away from the last known good snapshot. Nothing is needed from you.",
    workerInstruction: "Run `node scripts/validate-data.js`, confirm the drift is legitimate, and update the validation baseline." },

  // Pipeline — warn-only, no auto-fix needed (they run on schedule)
  { match: /^Pipeline:/, urgency: 'low',
    humanAction: "A scheduled pipeline hasn't run recently. It may just be delayed — check again tomorrow." },

  // Quality — needs investigation
  { match: /^Quality: standingCoverage drift$/, urgency: 'this-week',
    ownerText: "Some critic outlets may need to be added to or removed from the list of outlets that review every Broadway opening, based on what they actually cover. Nothing is needed from you.",
    workerInstruction: "Check the standingCoverage drift and update outlet-registry.json." },
  { match: /^Quality: outlet feed staleness$/, urgency: 'this-week',
    ownerText: "A critic outlet's news feed stopped updating while the outlet keeps publishing reviews, so new reviews from it may arrive late. Nothing is needed from you.",
    workerInstruction: "Open the outlet-listing poller feed-health snapshot (OUTLET_FEED_HEALTH_REL in scripts/lib/outlet-listing-helpers.js), take each outlet in stale[] or failing[], probe a replacement with `node scripts/probe-outlet-feeds.js --outlets <id>` and update its OUTLET_STRATEGY_CONFIG entry in scripts/outlet-listing-poller.js (BRO-6352; BRO-6340 fixed thewrap/observer this way)." },
  { match: /^Quality: coverageExpectation drift$/, urgency: 'this-week',
    ownerText: "A critic outlet marked as not reviewing theater has been reviewing shows anyway, or the reverse. Nothing is needed from you.",
    workerInstruction: "Check the coverageExpectation drift and re-decide the flagged outlets in outlet-registry.json." },
  { match: /^Quality: outlet-heartbeat red flags$/, urgency: 'this-week',
    ownerText: "One or more critic outlets have had no reviews picked up for 2 or more weekly checks in a row. Nothing is needed from you.",
    workerInstruction: "Check the outlet-heartbeat red flags and find out whether the outlet stopped reviewing or an extractor broke." },

  // Silent-exclusion detectors (#1147 tracker, card #1188, ship-check
  // finding). Without explicit entries these fall through to the generic
  // /^Quality:/ route below and get described as a scored-review-percentage
  // problem, which is not what either measures — same trap the SERP census
  // recall entry above exists to avoid.
  { match: /^Quality: missing contentTier$/, urgency: 'this-week',
    ownerText: "A complete review is not showing on the site because a label it needs is missing. Nothing is needed from you.",
    workerInstruction: "Find the review-text file named in this check (fullText, a real byline, no rejection flags, but no contentTier) and restore contentTier so it reaches reviews.json." },
  { match: /^Quality: outlet domain moves$/, urgency: 'this-week',
    ownerText: "A critic outlet looks like it moved to a new web address (for example, a critic switching to Substack), so its new reviews are being missed. Nothing is needed from you.",
    workerInstruction: "Confirm the probable outlet domain move named in this check and add the new host to that outlet's domainAliases." },
  { match: /^Quality: outlet stub rate$/, urgency: 'this-week',
    ownerText: "Reviews from one outlet are suddenly coming in empty, which usually means the outlet redesigned its website. Nothing is needed from you.",
    workerInstruction: "Check the outlet stub-rate flag named in this check (a spike in stub-tier, 0-char extractions over the last 30 days), confirm the extractor is broken, and fix the article-extractor.js pattern for that outlet. TheaterMania broke this way in 2026." },

  // BRO-5027. Advisory: only stale/missing/drift warns reach the digest.
  { match: /^Commercial model: Boring Waltz fit$/, urgency: 'this-week',
    ownerText: "Boring Waltz is a Reddit user who posts weekly profit estimates for each show. Our profit model now agrees with his estimates much less often than usual, or this weekly comparison stopped updating. Nothing on the site changes by itself. Nothing is needed from you.",
    workerInstruction: "Check the Boring Waltz fit warning in the health digest and find out what changed." },

  // BRO-5073. Warns only when the revisit bar is met.
  { match: /^Commercial model: running-show bar revisit$/, urgency: 'this-week',
    ownerText: "The \"% returned\" bar for shows still running was kept off because the model was not accurate enough. Enough shows have now announced recoupment, and the model got enough of them right, to look at turning it on. Nothing on the site changes by itself. Turning it on is your decision; a worker will bring you the numbers and a recommendation first.",
    workerInstruction: "The running-show bar revisit check passed. Review the numbers and write a recommendation on whether to turn on RUNNING_MODEL_BAR_ENABLED; turning it on is the owner's decision, so ask it as a plain-English DECISION NEEDED." },

  // BRO-5004. Without an entry this falls to urgency 'low' and never shows.
  { match: /^Commercial model: stored vs fresh run$/, urgency: 'this-week',
    ownerText: "Some recoupment percentages on the site were computed before a cost or capital figure changed, so they are out of date until the model re-runs. Nothing is needed from you.",
    workerInstruction: "Check the stored-vs-fresh model drift and re-run the recoupment model." },

  // BRO-5156. Before the generic /^Quality:/ route, which would describe this
  // as a scored-review-percentage drop.
  { match: /^Quality: opening date vs review dates$/, urgency: 'this-week',
    ownerText: "Some shows have a stored opening date later than the date critics reviewed them, which hides real first-night reviews from the score. Nothing is needed from you.",
    workerInstruction: "Check the opening date vs review dates warning and fix the stored opening dates." },

  { match: /^Quality:/, urgency: 'this-week',
    ownerText: "The share of reviews that have a score has dropped. Nothing is needed from you.",
    workerInstruction: "Find why the scored review percentage dropped and fix it." },

  // Coverage Verdict S1 (#872/#898). Without an explicit entry this would fall
  // through to the generic route and be described as a scored-review-percentage
  // problem, which is not what it measures.
  { match: /^Coverage: SERP census recall$/, urgency: 'this-week',
    ownerText: "The review census is finding fewer published reviews than it recently did, so new shows may be going live with reviews missing. Nothing is needed from you.",
    workerInstruction: "Run `node scripts/audit-serp-census-recall.js`, find which census arm dropped, and fix it." },

  // Affiliate revenue monitor (affiliate hardening 2026-08-03). fix-now: this
  // is the site's only revenue stream, and check-affiliate-health.js already
  // filtered out Poisson noise before writing anything non-pass.
  { match: /^Revenue: affiliate health$/, urgency: 'fix-now',
    ownerText: "The ticket-sales commission monitor flagged a problem, or the monitor itself stopped running. Nothing is needed from you.",
    workerInstruction: "Run `node scripts/check-affiliate-health.js --dry-run` and investigate the failing layer; the check output names it (site clicks, Impact handoff, conversions, or payouts)." },

  // Provider spend ledger dead-man (BRO-3317). fix-now: the whole reason this
  // check exists is that the ledger froze for 11 days with nothing paging —
  // a repeat needs to surface the same day, not sit in a weekly bucket.
  { match: /^Data quality: provider spend ledger$/, urgency: 'fix-now',
    ownerText: "The daily record of what we spend on outside data services has not updated in over 2 days. Nothing is needed from you.",
    workerInstruction: "Check the 'Commit provider spend ledger (apiFallbackSafe)' and 'Provider spend reconciliation' steps in data-health-check.yml. Confirm the reconciliation step's write to data/audit/provider-spend-daily.jsonl reaches a committed push and is not wiped by an earlier commit step's push-with-retry.sh fallback." },

  // Cookies — requires human action on Mac. Urgency escalates with proximity.
  { match: /^Cookies:/, urgency: 'fix-now',
    ownerText: "A login cookie for a paywalled critic site has expired or is about to. Refreshing it needs you to log in to that site on your Mac; the countdown below shows which ones and when.",
    workerInstruction: "Find which paywall cookies are expired or near expiry and refresh every one that can be refreshed without the owner. For any that needs a fresh owner login, name the site in one plain sentence.",
    useCountdown: true },

  // CWV — needs investigation
  { match: /^CWV:/, urgency: 'this-week',
    ownerText: "The website has gotten slower. Nothing is needed from you.",
    workerInstruction: "Check the Core Web Vitals report and fix any performance regressions." },

  // SEO — needs investigation
  { match: /^SEO:/, urgency: 'this-week',
    ownerText: "Search engine health for the site has slipped. Nothing is needed from you.",
    workerInstruction: "Check the SEO health report and fix any issues." },

  // Cron staleness — low-priority; auto-dispatch for a few known-fixable ones.
  // NB: failed-last-run cases are emitted under `Cron failed:` (see below)
  // so they route to fix-now instead of being buried here.
  { match: /^Cron: Rebuild Reviews$/, urgency: 'low', workflow: 'rebuild-reviews.yml',
    humanFallback: 'The review rebuild pipeline may be stalled.' },
  { match: /^Cron: Update Show Status$/, urgency: 'low', workflow: 'update-show-status.yml',
    humanFallback: 'Show status updates may be stalled.' },
  { match: /^Cron: Collect Review Texts$/, urgency: 'low', workflow: 'collect-review-texts.yml',
    humanFallback: 'Review text collection may be stalled.' },
  { match: /^Cron: failing every scheduled run$/, urgency: 'low',
    humanAction: 'A scheduled job has failed its last 3 runs in a row and nobody is being paged about it. The row names the workflows; a fix session picks it up from the board.' },
  { match: /^Cron:/, urgency: 'low',
    ownerText: "A scheduled job has not run recently. It will likely run on its next schedule. Nothing is needed from you.",
    workerInstruction: "If the cron row persists, find why the scheduled jobs are not running and fix it." },

  // Cron failed-last-run — surfaces in the daily digest's prominent section.
  // Added 2026-04-14 so that update-lottery-rush / weekly-grosses / etc.
  // failures don't sit silently in the Actions log for a week.
  { match: /^Cron failed:/, urgency: 'fix-now',
    ownerText: "A critical scheduled job failed its most recent run. Nothing is needed from you.",
    workerInstruction: "Find what broke in the workflow this check row names and fix it." },

  // Repeat workflow failures — promoted from a passive digest body section to a
  // first-class check (2026-06-16, Notion 381637c5) so a workflow failing 2+
  // times in 24h escalates (subject line, error count, auto-triage) instead of
  // sitting silently. The check name carries the workflow, e.g.
  // "Workflow repeat-failure: update-lottery-rush.yml". Self-resolves once the
  // workflow stops failing.
  { match: /^Workflow repeat-failure:/, urgency: 'fix-now',
    ownerText: "A job failed several times in the last 24 hours, so it is likely broken rather than a one-off. The Repeat Workflow Failures section below links each failing run. Nothing is needed from you.",
    workerInstruction: "Find what broke in this workflow (the row names it and links each failing run) and fix it." },

  // Secrets — needs manual rotation
  { match: /^Secrets:/, urgency: 'fix-now',
    ownerText: "A password or API key the site uses may be expiring soon. Renewing some keys needs your login to that service; if so, you will be told which one.",
    workerInstruction: "Find which secrets need rotation and rotate them. If a rotation needs the owner's login or a payment, name the service in one plain sentence." },

  // API Credits — needs attention if low. Provider-specific entries first;
  // the generic /^Credits:/ line is the fallback for future providers
  // (ship-check 2026-07-26: the SB copy used to render for ScrapingDog too).
  { match: /^Credits: ScrapingDog/, urgency: 'this-week',
    humanAction: 'ScrapingDog credits are running low. Check usage at app.scrapingdog.com and consider upgrading or reducing scraping frequency.' },
  { match: /^Credits:/, urgency: 'this-week',
    humanAction: 'ScrapingBee credits are running low. Check usage at app.scrapingbee.com and consider upgrading or reducing scraping frequency.' },
];

function getPlaybookEntry(checkName) {
  for (const entry of AUTO_FIX_PLAYBOOK) {
    if (entry.match.test(checkName)) return entry;
  }
  return null;
}

// Attempt auto-fix by dispatching a GitHub Actions workflow.
// Returns { fixed: true/false, message: string }
async function tryAutoFix(checkResult) {
  const entry = getPlaybookEntry(checkResult.name);
  if (!entry || !entry.workflow) return { fixed: false };

  // Guard: max 2 auto-fix attempts per check per day (resets at midnight UTC)
  const checkSlug = checkResult.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
  const triageFile = path.join(TRIAGE_DIR, `autofix-${checkSlug}.json`);
  try {
    if (fs.existsSync(triageFile)) {
      const triage = readJSON(triageFile);
      const lastFixDate = triage.lastAutoFix ? new Date(triage.lastAutoFix).toISOString().slice(0, 10) : null;
      const todayDate = new Date().toISOString().slice(0, 10);
      const attemptsToday = lastFixDate === todayDate ? (triage.autoFixAttempts || 0) : 0;
      if (attemptsToday >= 2) {
        console.log(`[Auto-Fix] Skipping ${checkResult.name} — already attempted ${attemptsToday} times today`);
        return { fixed: false, message: 'Max auto-fix attempts reached for today' };
      }
    }
  } catch {}

  // Dispatch the workflow
  try {
    // dispatchInputs: -f key=value pairs, for workflows whose bare manual
    // dispatch differs from their cron (audit-aggregator-gap.yml's
    // redispatched=true; BRO-5261 retro-review).
    const fields = Object.entries(entry.dispatchInputs || {}).map(([k, v]) => ` -f ${k}=${v}`).join('');
    execSync(
      `gh workflow run "${entry.workflow}"${fields}`,
      { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    console.log(`[Auto-Fix] Dispatched ${entry.workflow} for ${checkResult.name}`);

    // Increment auto-fix attempt counter (per-check, resets daily)
    try {
      let triage = {};
      if (fs.existsSync(triageFile)) triage = readJSON(triageFile);
      const lastFixDate = triage.lastAutoFix ? new Date(triage.lastAutoFix).toISOString().slice(0, 10) : null;
      const todayDate = new Date().toISOString().slice(0, 10);
      triage.autoFixAttempts = (lastFixDate === todayDate ? (triage.autoFixAttempts || 0) : 0) + 1;
      triage.lastAutoFix = new Date().toISOString();
      triage.lastAutoFixWorkflow = entry.workflow;
      fs.mkdirSync(path.dirname(triageFile), { recursive: true });
      fs.writeFileSync(triageFile, JSON.stringify(triage, null, 2) + '\n');
    } catch {}

    return { fixed: true, workflow: entry.workflow };
  } catch (err) {
    console.error(`[Auto-Fix] Failed to dispatch ${entry.workflow}: ${err.message.substring(0, 100)}`);
    return { fixed: false, message: `Dispatch failed: ${err.message.substring(0, 80)}` };
  }
}

// --- Helpers ---

// hoursAgo()/formatAge() live in scripts/lib/hours-ago.js (BRO-2476) so the
// data/audit freshness module shares the exact same age math (BRO-3349
// bare-day rule, clamp at 0). Covered by scripts/tests/health-check-hours-ago.test.mjs.
const { hoursAgo, formatAge } = require('./lib/hours-ago');

function readJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function runCheck(name, fn) {
  try {
    return fn();
  } catch (err) {
    return { name, status: 'error', message: `Check crashed: ${err.message}` };
  }
}

// --- Category A: Data Freshness ---

const FRESHNESS_CHECKS = [
  { file: 'reviews.json', field: '_meta.lastUpdated', warnH: 48, errorH: 96, hint: 'Check rebuild-reviews workflow in Actions tab' },
  { file: 'shows.json', field: '_meta.lastUpdated', warnH: 24, errorH: 36, hint: 'Check update-show-status workflow in Actions tab' },
  { file: 'grosses.json', field: 'lastUpdated', warnH: 240, errorH: 336, hint: 'Check weekly-grosses workflow in Actions tab' },
  { file: 'audience-buzz.json', field: '_meta.lastUpdated', warnH: 240, errorH: 336, hint: 'Check audience buzz workflows in Actions tab' },
  { file: 'commercial.json', field: '_meta.lastUpdated', warnH: 336, errorH: 504, hint: 'Check commercial-weekly workflow in Actions tab' },
  { file: 'critic-consensus.json', field: '_meta.lastGenerated', warnH: 336, errorH: 504, hint: 'Check update-critic-consensus workflow in Actions tab' },
  // Mon+Thu cron (96h max gap). lastCheckedAt moves on every full check, lastUpdated only
  // when a policy changed (BRO-5261), so read lastCheckedAt first. Warn past one missed
  // run's gap, error past two missed runs.
  { file: 'lottery-rush.json', field: ['lastCheckedAt', 'lastUpdated'], warnH: 108, errorH: 192, hint: 'Check update-lottery-rush workflow in Actions tab (runs Mon+Thu)' },
  { file: 'cast-changes.json', field: 'lastUpdated', warnH: 72, errorH: 120, hint: 'Check update-cast-changes workflow in Actions tab (runs Wed+Sat)' },
  { file: 'nyt-critics-picks.json', field: '_meta.lastUpdated', warnH: 72, errorH: 120, hint: 'Check nyt-critics-picks workflow in Actions tab (runs Mon/Wed/Fri)' },
  { file: 'video-reviews.json', field: '_meta.generatedAt', warnH: 192, errorH: 336, hint: 'Check weekly-video-reviews workflow in Actions tab (runs Monday)' },
  // Tony odds — only relevant April–June. Large thresholds so stale off-season files don't false-alarm.
  { file: 'tony-win-probabilities.json', field: '_meta.lastUpdated', warnH: 36, errorH: 72, hint: 'Check update-tony-awards workflow — GoldDerby scraper may have failed', seasonMonths: [4, 5, 6] },
  { file: 'tony-polymarket-odds.json', field: '_meta.lastUpdated', warnH: 36, errorH: 72, hint: 'Check update-tony-awards workflow — Polymarket scraper may have failed or returned 0 categories', seasonMonths: [4, 5, 6] },
  { file: 'tony-kalshi-odds.json', field: '_meta.lastUpdated', warnH: 36, errorH: 72, hint: 'Check update-tony-awards workflow — Kalshi scraper may have failed or returned 0 categories', seasonMonths: [4, 5, 6] },
];

// Navigate a nested field like "_meta.lastUpdated"; an array of fields means
// the first one present wins.
function freshnessValue(data, field) {
  for (const f of [].concat(field)) {
    const v = f.split('.').reduce((obj, key) => obj && obj[key], data);
    if (v) return v;
  }
  return undefined;
}

function checkFreshness() {
  const currentMonth = new Date().getMonth() + 1; // 1-12
  return FRESHNESS_CHECKS.map(({ file, field, warnH, errorH, hint, seasonMonths }) =>
    runCheck(`Freshness: ${file}`, () => {
      if (seasonMonths && !seasonMonths.includes(currentMonth)) {
        return { name: `Freshness: ${file}`, status: 'ok', message: 'Skipped (off-season)' };
      }
      const filePath = path.join(DATA_DIR, file);
      if (!fs.existsSync(filePath)) {
        return { name: `Freshness: ${file}`, status: 'error', message: `File missing`, hint };
      }
      const data = readJSON(filePath);
      const value = freshnessValue(data, field);
      if (!value) {
        return { name: `Freshness: ${file}`, status: 'error', message: `No ${[].concat(field).join(' or ')} field`, hint };
      }
      const age = hoursAgo(value);
      if (age === Infinity) {
        return { name: `Freshness: ${file}`, status: 'error', message: `Unparseable date: ${value}`, hint };
      }
      if (age > errorH) {
        return { name: `Freshness: ${file}`, status: 'error', message: `${formatAge(age)} old (error threshold: ${formatAge(errorH)})`, hint };
      }
      if (age > warnH) {
        return { name: `Freshness: ${file}`, status: 'warn', message: `${formatAge(age)} old (warn threshold: ${formatAge(warnH)})`, hint };
      }
      return { name: `Freshness: ${file}`, status: 'pass', message: `${formatAge(age)} old` };
    })
  );
}

// --- Category A1b: data/audit detector freshness (BRO-2476) ---
// Same row shape and `Freshness:` category as checkFreshness() above (so the
// rows share its triage file and digest treatment), for the cron-written
// data/audit/*.json reports FRESHNESS_CHECKS never covered. Rows, cadence
// evidence and the pure decision live in scripts/lib/audit-freshness-checks.js.
// Missing file / missing field / unparseable date / unparseable JSON are all
// `error`, matching checkFreshness() (whose readJSON throw becomes an error
// via runCheck).
function checkAuditFreshness({ auditDir = AUDIT_DIR, now = Date.now() } = {}) {
  const { AUDIT_FRESHNESS_CHECKS, evaluateAuditFreshness, auditFreshnessRowName } = require('./lib/audit-freshness-checks');
  return AUDIT_FRESHNESS_CHECKS.map((row) => {
    const name = auditFreshnessRowName(row);
    return runCheck(name, () => {
      const filePath = path.join(auditDir, row.file);
      let data = null;
      if (fs.existsSync(filePath)) {
        try {
          data = readJSON(filePath);
        } catch (err) {
          // Only a parse failure is a data finding; anything else (EACCES,
          // EISDIR, ...) propagates to runCheck's "Check crashed" path.
          if (!(err instanceof SyntaxError)) throw err;
          return { name, status: 'error', message: `Unparseable JSON: ${err.message.split('\n')[0].slice(0, 80)}`, hint: row.hint };
        }
      }
      const { status, message } = evaluateAuditFreshness(row, data, now);
      if (status === 'ok') return { name, status: 'pass', message };
      return { name, status, message, hint: row.hint };
    });
  });
}

// --- Category A2: Push Verification ---
// Detects silent push failures: workflow succeeds but data never reaches private repo.
// Compares _meta.lastUpdated against last successful workflow run time.

const PUSH_VERIFY_CHECKS = [
  { file: 'shows.json', field: '_meta.lastUpdated', workflow: 'update-show-status.yml', name: 'Update Show Status', maxDriftH: 6 },
];

function checkPushVerification() {
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
    return [{ name: 'Push verify: shows.json', status: 'warn', message: 'Skipped — no GH_TOKEN' }];
  }

  return PUSH_VERIFY_CHECKS.map(({ file, field, workflow, name, maxDriftH }) =>
    runCheck(`Push verify: ${file}`, () => {
      try {
        // Get last successful workflow run time. Cached: 15 CRITICAL_CRONS
        // entries + this check all share ONE shared PAT/rate-limit budget
        // across every concurrently-dispatched session on this Mac — see
        // scripts/lib/gh-api-cache.js header for why.
        const result = firstRunCreatedAt(cachedShell(
          runCacheKey(`push-verify:${workflow}`),
          ghRunsQuery(workflow, { limit: 1, status: 'success' })
        ));
        if (!result) {
          return { name: `Push verify: ${file}`, status: 'warn', message: `No successful ${name} runs found` };
        }
        const workflowTime = new Date(result);

        // Get data timestamp from file
        const filePath = path.join(DATA_DIR, file);
        if (!fs.existsSync(filePath)) {
          return { name: `Push verify: ${file}`, status: 'warn', message: 'File missing' };
        }
        const data = readJSON(filePath);
        const value = field.split('.').reduce((obj, key) => obj && obj[key], data);
        if (!value) {
          return { name: `Push verify: ${file}`, status: 'warn', message: `No ${field} field` };
        }
        const dataTime = new Date(value);

        // If workflow ran successfully but data timestamp is older by more than maxDriftH,
        // the push likely failed silently
        const driftH = (workflowTime.getTime() - dataTime.getTime()) / (1000 * 60 * 60);
        if (driftH > maxDriftH) {
          return {
            name: `Push verify: ${file}`,
            status: 'error',
            message: `Data ${formatAge(hoursAgo(value))} old but ${name} succeeded ${formatAge(hoursAgo(result))} ago — push may have failed`,
            hint: `Check ${workflow} logs for "No core data changes" or push errors`,
          };
        }
        return { name: `Push verify: ${file}`, status: 'pass', message: `Data synced (${formatAge(hoursAgo(value))} old, workflow ${formatAge(hoursAgo(result))} ago)` };
      } catch (err) {
        return { name: `Push verify: ${file}`, status: 'warn', message: `Check failed: ${err.message.substring(0, 80)}` };
      }
    })
  );
}

// --- Category A2b: Opening Night History Push Verification ---
// Same drift logic as checkPushVerification() above (workflow ran
// successfully more recently than the data reflects => the write/push is
// failing silently even though the workflow itself reports green) — but
// data/audit/opening-night-history.json stores its freshness signal as the
// newest entry in a `runs[]` array, not a `_meta.lastUpdated`-style field, so
// it can't be expressed as another PUSH_VERIFY_CHECKS entry (that generic
// field-path reducer doesn't index arrays). Task #1073: this exact failure
// mode ran undetected for 100+ days — opening-night-checklist.yml stayed
// green ~5x/day while its history append silently crashed on every run from
// 2026-04-26 onward (see the diagnosis comment above appendToHistory() in
// scripts/opening-night-checklist.js). 26h (not the generic 24h) gives the
// hourly cron slack for one missed/late tick before alerting.
const OPENING_NIGHT_HISTORY_MAX_DRIFT_H = 26;

function checkOpeningNightHistoryFreshness() {
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
    return [{ name: 'Push verify: opening-night-history.json', status: 'warn', message: 'Skipped — no GH_TOKEN' }];
  }
  return [runCheck('Push verify: opening-night-history.json', () => {
    try {
      // Get last successful workflow run time (same gh invocation shape and
      // shared cache as checkPushVerification() above).
      const result = firstRunCreatedAt(cachedShell(
        runCacheKey('push-verify:opening-night-checklist.yml'),
        ghRunsQuery('opening-night-checklist.yml', { limit: 1, status: 'success' })
      ));
      if (!result) {
        return { name: 'Push verify: opening-night-history.json', status: 'warn', message: 'No successful Opening Night Checklist runs found' };
      }
      const workflowTime = new Date(result);

      const filePath = path.join(AUDIT_DIR, 'opening-night-history.json');
      if (!fs.existsSync(filePath)) {
        return { name: 'Push verify: opening-night-history.json', status: 'warn', message: 'File missing' };
      }
      const data = readJSON(filePath);
      const runs = Array.isArray(data.runs) ? data.runs : [];
      if (runs.length === 0) {
        return { name: 'Push verify: opening-night-history.json', status: 'warn', message: 'No runs[] entries in file' };
      }
      const newest = runs[runs.length - 1];
      if (!newest || !newest.at) {
        return { name: 'Push verify: opening-night-history.json', status: 'warn', message: 'Newest runs[] entry has no `at` field' };
      }
      const dataTime = new Date(newest.at);
      if (isNaN(dataTime.getTime())) {
        return { name: 'Push verify: opening-night-history.json', status: 'warn', message: `Unparseable date on newest runs[] entry: ${newest.at}` };
      }

      // If the workflow ran successfully but the newest history entry is
      // older by more than OPENING_NIGHT_HISTORY_MAX_DRIFT_H, the append is
      // likely failing silently on every run (workflow green, ledger frozen).
      const driftH = (workflowTime.getTime() - dataTime.getTime()) / (1000 * 60 * 60);
      if (driftH > OPENING_NIGHT_HISTORY_MAX_DRIFT_H) {
        return {
          name: 'Push verify: opening-night-history.json',
          status: 'error',
          message: `Newest history entry ${formatAge(hoursAgo(newest.at))} old but Opening Night Checklist succeeded ${formatAge(hoursAgo(result))} ago — history append may be failing silently`,
          hint: 'Check the "Run opening night checklist" step\'s logged exit code in opening-night-checklist.yml (0/1 expected; anything else — including exit 3 — means appendToHistory() failed). See the diagnosis comment above appendToHistory() in scripts/opening-night-checklist.js.',
        };
      }
      return { name: 'Push verify: opening-night-history.json', status: 'pass', message: `History synced (newest entry ${formatAge(hoursAgo(newest.at))} old, workflow ${formatAge(hoursAgo(result))} ago)` };
    } catch (err) {
      return { name: 'Push verify: opening-night-history.json', status: 'warn', message: `Check failed: ${err.message.substring(0, 80)}` };
    }
  })];
}

// --- Category B: Data Sync ---

function checkSync() {
  const results = [];

  // B1: review-texts count vs reviews.json count
  results.push(runCheck('Sync: review-texts vs reviews.json', () => {
    const reviewTextsDir = path.join(DATA_DIR, 'review-texts');
    let fileCount = 0;
    if (fs.existsSync(reviewTextsDir)) {
      const showDirs = listShowDirs(reviewTextsDir);
      for (const dir of showDirs) {
        const files = fs.readdirSync(path.join(reviewTextsDir, dir))
          .filter(f => isReviewTextFile(f));
        fileCount += files.length;
      }
    }
    // review-texts live in a private repo — if not checked out, skip this check
    if (fileCount === 0) {
      return { name: 'Sync: review-texts vs reviews.json', status: 'pass', message: 'Skipped — review-texts not checked out (private repo)' };
    }
    const reviews = readJSON(path.join(DATA_DIR, 'reviews.json'));
    const reviewCount = reviews._meta?.stats?.totalReviews || 0;
    // Deficit = reviews.json has MORE entries than source files (phantom reviews)
    const deficit = reviewCount - fileCount;
    if (deficit > 50) {
      return { name: 'Sync: review-texts vs reviews.json', status: 'error', message: `reviews.json has ${deficit} more entries than source files`, hint: 'Run rebuild-reviews workflow to resync' };
    }
    if (deficit > 10) {
      return { name: 'Sync: review-texts vs reviews.json', status: 'warn', message: `reviews.json has ${deficit} more entries than source files` };
    }
    return { name: 'Sync: review-texts vs reviews.json', status: 'pass', message: `${fileCount} files, ${reviewCount} reviews (surplus: ${fileCount - reviewCount})` };
  }));

  // B2: Open show coverage (reviews + grosses)
  results.push(runCheck('Sync: open show coverage', () => {
    const shows = readJSON(path.join(DATA_DIR, 'shows.json'));
    const reviews = readJSON(path.join(DATA_DIR, 'reviews.json'));
    const grosses = readJSON(path.join(DATA_DIR, 'grosses.json'));

    const showList = shows.shows || Object.values(shows).filter(s => s && s.id);
    // Only check Broadway shows — WE/OB are expected to have gaps
    const openShows = showList.filter(s => s.status === 'open' && isBroadwayCategory(s));

    // Build review lookup by showId from flat reviews array
    const reviewedShowIds = new Set();
    const reviewsList = reviews.reviews || [];
    for (const r of reviewsList) {
      if (r.showId) reviewedShowIds.add(r.showId);
    }

    const grossesSlugs = new Set(Object.keys(grosses.shows || {}));

    let missingReviews = 0;
    let missingGrosses = 0;
    const missingReviewsList = [];
    const missingGrossesList = [];

    for (const show of openShows) {
      if (!reviewedShowIds.has(show.id)) {
        missingReviews++;
        if (missingReviewsList.length < 5) missingReviewsList.push(show.title);
      }
      if (!grossesSlugs.has(show.slug)) {
        missingGrosses++;
        if (missingGrossesList.length < 5) missingGrossesList.push(show.title);
      }
    }

    const parts = [];
    let worstStatus = 'pass';

    if (missingReviews > 5) {
      worstStatus = 'error';
      parts.push(`${missingReviews} open shows missing reviews (${missingReviewsList.join(', ')})`);
    } else if (missingReviews > 3) {
      worstStatus = 'warn';
      parts.push(`${missingReviews} open shows missing reviews`);
    }

    if (missingGrosses > 5) {
      if (worstStatus !== 'error') worstStatus = 'warn';
      parts.push(`${missingGrosses} open shows missing grosses`);
    }

    if (parts.length === 0) {
      return { name: 'Sync: open show coverage', status: 'pass', message: `${openShows.length} open shows all have reviews and grosses` };
    }
    return { name: 'Sync: open show coverage', status: worstStatus, message: parts.join('; '), hint: 'Check gather-reviews and weekly-grosses workflows' };
  }));

  // Audience source coverage gaps — promotes the per-source coverage audits
  // (mezzanine-coverage.json / theatr-coverage.json) from a passive digest
  // section into a CHECK, narrowed to CURRENTLY OPEN shows. Each audit flags
  // an unmatched high-volume source-catalog entry that fuzzy-matches one of our
  // shows lacking that source — data the source has but our matcher didn't link
  // (title-drift / missing override). The 2026-06-22 Encores La Cage miss (85
  // Mezzanine ratings never linked, an "Encores!" prefix + venue-ambiguity gap)
  // WAS flagged in mezzanine-coverage.json but sat unseen among ~36 closed-
  // revival flags in the passive section. Filtering to open shows + making it a
  // check means a running show missing a source now drives the subject line.
  results.push(runCheck('Audience coverage: open-show gaps', () => {
    const { openShowCoverageGaps } = require('./lib/audience-coverage-gaps');
    const shows = readJSON(path.join(DATA_DIR, 'shows.json'));
    const showList = shows.shows || Object.values(shows).filter(s => s && s.id);
    const openIds = new Set(showList.filter(s => s.status === 'open').map(s => s.id));

    const reports = [];
    const unreadable = [];
    for (const [source, file] of [['Mezzanine', 'mezzanine-coverage.json'], ['Theatr', 'theatr-coverage.json']]) {
      const p = path.join(DATA_DIR, 'audit', file);
      if (!fs.existsSync(p)) continue;
      try {
        const audit = JSON.parse(fs.readFileSync(p, 'utf8'));
        reports.push({ source, flagged: audit.flagged || [] });
      } catch (_) {
        // An audit file that EXISTS but won't parse is a broken input, not a
        // clean bill of health — track it so we don't report 'ok' on a file we
        // couldn't actually read (that would silently re-hide the La Cage class).
        unreadable.push(file);
      }
    }

    const showsById = new Map(showList.map(s => [s.id, s]));
    const gaps = openShowCoverageGaps(reports, openIds, showsById);
    if (gaps.length === 0) {
      if (unreadable.length > 0) {
        return { name: 'Audience coverage: open-show gaps', status: 'warn', message: `Could not read coverage audit: ${unreadable.join(', ')} — gap detection blind for ${unreadable.length} source(s)`, hint: 'The scraper wrote a malformed audit file. Re-run the scraper to regenerate it.' };
      }
      return { name: 'Audience coverage: open-show gaps', status: 'ok', message: 'No open shows with unlinked audience sources' };
    }
    const top = gaps.slice(0, 5)
      .map(g => `${g.source}: ${g.ourTitle} (${g.ratingsCount} ratings ↔ ${g.sourceName || '?'})`)
      .join('; ');
    // Name the override knob per source — Mezzanine and Theatr have SEPARATE
    // override tables in different scrapers; sending a Theatr-only gap to
    // MEZZANINE_OVERRIDES is the wrong fix.
    const sources = [...new Set(gaps.map(g => g.source))];
    const knob = sources.map(s => s === 'Theatr'
      ? 'THEATR_OVERRIDES in scrape-theatr-audience.js'
      : 'MEZZANINE_OVERRIDES ({name} or {name,venue}) in scrape-mezzanine-audience.js').join(' / ');
    // ≥3 open-show gaps is a systematic matcher problem (error); 1-2 is a warn.
    const status = gaps.length >= 3 ? 'error' : 'warn';
    return {
      name: 'Audience coverage: open-show gaps',
      status,
      message: `${gaps.length} open show(s) have audience data on a source that didn't link — ${top}`,
      hint: `Add an override for the flagged show: ${knob}; then re-run that source's scraper.`,
    };
  }));

  // B3: Phantom show detection — open shows with TBA venue and no reviews
  // Auto-discover can create phantom entries when isMultiProduction() treats TBA-venue
  // shows as distinct productions. These show up as open shows with no reviews and no venue.
  results.push(runCheck('Sync: phantom show detection', () => {
    const shows = readJSON(path.join(DATA_DIR, 'shows.json'));
    const reviews = readJSON(path.join(DATA_DIR, 'reviews.json'));

    const showList = shows.shows || Object.values(shows).filter(s => s && s.id);
    const reviewedShowIds = new Set();
    for (const r of reviews.reviews || []) {
      if (r.showId) reviewedShowIds.add(r.showId);
    }

    const phantomCandidates = showList.filter(s =>
      s.status === 'open' &&
      !reviewedShowIds.has(s.id) &&
      !s.openingDate &&
      (s.venue === 'TBA' || s.venue === 'TBD' || !s.venue)
    );

    if (phantomCandidates.length === 0) {
      return { name: 'Sync: phantom show detection', status: 'pass', message: 'No phantom show candidates found' };
    }
    const names = phantomCandidates.map(s => s.id).join(', ');
    return {
      name: 'Sync: phantom show detection',
      status: 'warn',
      message: `${phantomCandidates.length} open show(s) with TBA venue, no reviews, no opening date: ${names}`,
      hint: 'These may be phantom shows created by auto-discover. Verify each is a real production, then add openingDate or real venue, or delete from shows.json.'
    };
  }));

  // B4: Cast coverage — open/previews Broadway shows missing cast data
  results.push(runCheck('Sync: cast coverage', () => {
    const shows = readJSON(path.join(DATA_DIR, 'shows.json'));
    const castDir = path.join(DATA_DIR, 'cast');
    const showList = shows.shows || Object.values(shows).filter(s => s && s.id);
    const activeShows = showList.filter(s =>
      (s.status === 'open' || s.status === 'previews') &&
      isBroadwayCategory(s)
    );

    const missing = [];
    const empty = [];
    for (const show of activeShows) {
      const castFile = path.join(castDir, `${show.id}.json`);
      if (!fs.existsSync(castFile)) {
        missing.push(show.title);
      } else {
        try {
          const cast = readJSON(castFile);
          if (!cast.openingNightCast || cast.openingNightCast.length === 0) {
            // Pre-opening previews shows are often not on IBDB yet (or only
            // under an earlier production's page, which the backfill rejects) —
            // a confirmed-empty tombstone there is expected, not a coverage gap.
            // Re-checked weekly by the backfill; counted once openingDate passes.
            const preOpening = show.status === 'previews' && show.openingDate && show.openingDate > new Date().toISOString().slice(0, 10);
            if (!preOpening) empty.push(show.title);
          }
        } catch {}
      }
    }

    const total = missing.length + empty.length;
    if (total === 0) {
      return { name: 'Sync: cast coverage', status: 'pass', message: `${activeShows.length} active Broadway shows all have cast data` };
    }
    const parts = [];
    if (missing.length) parts.push(`${missing.length} missing file${missing.length > 1 ? 's' : ''}: ${missing.slice(0, 3).join(', ')}`);
    if (empty.length) parts.push(`${empty.length} empty cast: ${empty.slice(0, 3).join(', ')}`);
    const status = total > 3 ? 'error' : 'warn';
    return { name: 'Sync: cast coverage', status, message: parts.join('; '), hint: 'Run: node scripts/backfill-cast.js to repopulate' };
  }));

  // B5: Baseline drift
  results.push(runCheck('Sync: baseline drift', () => {
    const baselinePath = path.join(AUDIT_DIR, 'validation-baseline.json');
    if (!fs.existsSync(baselinePath)) {
      return { name: 'Sync: baseline drift', status: 'warn', message: 'No baseline file found' };
    }
    const baseline = readJSON(baselinePath);
    const shows = readJSON(path.join(DATA_DIR, 'shows.json'));
    const reviews = readJSON(path.join(DATA_DIR, 'reviews.json'));

    const showList = shows.shows || Object.values(shows).filter(s => s && s.id);
    const currentTotal = showList.length;
    const currentOpen = showList.filter(s => s.status === 'open').length;
    // Must count the same way validate-data.js writes the baseline (reviews[] length).
    // _meta.stats.totalReviews counts a different population (BRO-6105).
    if (!Array.isArray(reviews.reviews)) {
      return { name: 'Sync: baseline drift', status: 'warn', message: 'reviews.json has no reviews[] array' };
    }
    const currentReviews = reviews.reviews.length;

    const issues = [];
    let worstStatus = 'pass';

    if (currentTotal < baseline.totalShows) {
      worstStatus = 'warn';
      issues.push(`Shows dropped: ${currentTotal} vs baseline ${baseline.totalShows}`);
    }
    const openDrop = baseline.openShows - currentOpen;
    if (openDrop > 5) {
      worstStatus = 'error';
      issues.push(`Open shows dropped by ${openDrop}: ${currentOpen} vs baseline ${baseline.openShows}`);
    } else if (openDrop > 2) {
      worstStatus = 'warn';
      issues.push(`Open shows dropped by ${openDrop}: ${currentOpen} vs baseline ${baseline.openShows}`);
    }
    if (currentReviews < baseline.totalReviews) {
      worstStatus = 'warn';
      issues.push(`Reviews dropped: ${currentReviews} vs baseline ${baseline.totalReviews}`);
    }

    if (issues.length === 0) {
      return { name: 'Sync: baseline drift', status: 'pass', message: `${currentTotal} shows, ${currentOpen} open, ${currentReviews} reviews (all at or above baseline)` };
    }
    return { name: 'Sync: baseline drift', status: worstStatus, message: issues.join('; '), hint: 'Run validate-data.js to update baseline' };
  }));

  // B6: Grosses weekEnding currency — guards against timestamp refreshes masking stale content.
  // The lastUpdated timestamp in grosses.json can be refreshed by rebuilds without new scrape data.
  // This check reads weekEnding directly so a 2-week-old scrape can't hide behind a fresh timestamp.
  results.push(runCheck('Sync: grosses weekEnding', () => {
    const grossesPath = path.join(DATA_DIR, 'grosses.json');
    if (!fs.existsSync(grossesPath)) {
      return { name: 'Sync: grosses weekEnding', status: 'warn', message: 'grosses.json missing' };
    }
    const grosses = readJSON(grossesPath);
    const weekEnding = grosses.weekEnding; // format "M/D/YYYY"
    if (!weekEnding) {
      return { name: 'Sync: grosses weekEnding', status: 'warn', message: 'No weekEnding field in grosses.json' };
    }
    // Parse "M/D/YYYY" → Date
    const parts = weekEnding.split('/');
    if (parts.length !== 3) {
      return { name: 'Sync: grosses weekEnding', status: 'warn', message: `Unparseable weekEnding: ${weekEnding}` };
    }
    const weekDate = new Date(`${parts[2]}-${parts[0].padStart(2,'0')}-${parts[1].padStart(2,'0')}T12:00:00Z`);
    const daysOld = (Date.now() - weekDate.getTime()) / (1000 * 60 * 60 * 24);
    if (daysOld > 21) {
      return { name: 'Sync: grosses weekEnding', status: 'error', message: `weekEnding ${weekEnding} is ${Math.round(daysOld)} days ago (3+ missed weeks)`, hint: 'weekly-grosses.yml scraper may be broken — check Actions tab' };
    }
    if (daysOld > 14) {
      return { name: 'Sync: grosses weekEnding', status: 'warn', message: `weekEnding ${weekEnding} is ${Math.round(daysOld)} days ago (2 missed weeks)`, hint: 'Run: gh workflow run "Weekly Broadway Grosses"' };
    }
    return { name: 'Sync: grosses weekEnding', status: 'pass', message: `weekEnding ${weekEnding} (${Math.round(daysOld)}d ago)` };
  }));

  return results;
}

// --- Category C: Pipeline Health (warn only) ---

// Every marker here is written by a workflow step that ends in a git push, so a
// stale marker has TWO possible causes: the workflow stopped succeeding, or it
// kept succeeding and only its marker push failed. The recording steps are
// deliberately non-fatal about that push (a lost race against a busy main must
// not redden a green run — see test.yml "Record pipeline success"), which makes
// this staleness check the durable cross-run signal for a persistently failing
// health push. The hints name both causes so a stale marker isn't misdiagnosed
// as "the workflow never ran" when the run history is in fact green.
const PIPELINE_PUSH_HINT = (wf) =>
  `Check "${wf}" in the Actions tab. If its recent runs are GREEN, the workflow succeeded and only the marker push failed — grep those runs for "All push attempts failed" / "Health recording push failed" (the recording step is non-fatal by design, so a failing push leaves a green run with a stale marker).`;

const PIPELINE_CHECKS = [
  { file: 'rebuild-reviews.last-success', label: 'rebuild-reviews', warnH: 48, hint: PIPELINE_PUSH_HINT('Rebuild Reviews') },
  { file: 'update-show-status.last-success', label: 'update-show-status', warnH: 48, hint: PIPELINE_PUSH_HINT('Update Show Status') },
  { file: 'collect-review-texts.last-success', label: 'collect-review-texts', warnH: 48, hint: PIPELINE_PUSH_HINT('Collect Review Texts') },
  { file: 'weekly-grosses.last-success', label: 'weekly-grosses', warnH: 240, hint: PIPELINE_PUSH_HINT('Weekly Broadway Grosses') },
  { file: 'weekly-integrity.last-success', label: 'weekly-integrity', warnH: 240, hint: PIPELINE_PUSH_HINT('Weekly Integrity') },
  { file: 'test.last-success', label: 'test', warnH: 48, hint: PIPELINE_PUSH_HINT('Test Suite (test.yml)') },
];

function checkPipelines() {
  return PIPELINE_CHECKS.map(({ file, label, warnH, hint }) =>
    runCheck(`Pipeline: ${label}`, () => {
      const filePath = path.join(PIPELINE_DIR, file);
      if (!fs.existsSync(filePath)) {
        return { name: `Pipeline: ${label}`, status: 'warn', message: 'No timestamp file (workflow may not have run yet)', hint };
      }
      const content = fs.readFileSync(filePath, 'utf8').trim();
      const age = hoursAgo(content);
      if (age === Infinity) {
        return { name: `Pipeline: ${label}`, status: 'warn', message: `Unparseable timestamp: ${content}` };
      }
      if (age > warnH) {
        return { name: `Pipeline: ${label}`, status: 'warn', message: `Last success ${formatAge(age)} ago (threshold: ${formatAge(warnH)})`, hint };
      }
      return { name: `Pipeline: ${label}`, status: 'pass', message: `Last success ${formatAge(age)} ago` };
    })
  );
}

// Task #547: index.ts's --batch mode (task #516) writes batchInFlight state to
// data/collection-state/scoring-batch-state.json but nothing read it — a batch
// that never finishes inside the poll budget scores zero new reviews and the
// only visible signal was `processed: 0`, indistinguishable from "nothing
// needed scoring". Vendors expire batches at 24h; BATCH_STATE_MAX_AGE_HOURS in
// index.ts discards at 48h, so an error at 24h gives a full day of lead time
// before the state is silently dropped.
// HEALTH_CHECK_BATCH_STATE_PATH override (task #1662): lets tests point
// checkBatchState() at a throwaway fixture instead of racing CI/parallel
// sessions on the real tracked data/collection-state/scoring-batch-state.json.
const SCORING_BATCH_STATE_PATH = process.env.HEALTH_CHECK_BATCH_STATE_PATH
  || path.join(DATA_DIR, 'collection-state', 'scoring-batch-state.json');

/**
 * Pure so the age thresholds are testable without touching the filesystem.
 * Requires the same shape readBatchState() in index.ts requires (submittedAt +
 * an array manifest) — a corrupt-but-parseable file (e.g. `{submittedAt}`
 * alone) is not real batch state, and index.ts's own reader would ignore it.
 */
function batchStateResult(state) {
  const name = 'Scoring: batch state';
  if (!state || !state.submittedAt || !Array.isArray(state.manifest)) {
    return { name, status: 'pass', message: 'No batch in flight' };
  }
  const age = hoursAgo(state.submittedAt);
  if (age === Infinity) {
    return { name, status: 'warn', message: `scoring-batch-state.json has an unparseable submittedAt: ${state.submittedAt}` };
  }
  const itemCount = state.itemCount || 0;
  const ageLabel = formatAge(age);
  if (age > 24) {
    // index.ts itself only discards state past BATCH_STATE_MAX_AGE_HOURS=48 —
    // this is deliberately earlier: vendors expire the underlying batch job at
    // 24h, so results are already unrecoverable even though local bookkeeping
    // won't self-clear for another day. That gap is exactly the lead time
    // this check exists to surface, not a claim that 24h is the discard point.
    return {
      name,
      status: 'error',
      message: `Batch in flight ${ageLabel} (${itemCount} reviews) — the vendor batch has expired (24h) and its results are no longer retrievable; local state self-clears at 48h unless a run resumes and re-submits first`,
      hint: 'Check the scoring workflow run history for stalled/crashed polling — these reviews will be scored fresh once scoring-batch-state.json clears.',
    };
  }
  if (age > 12) {
    return { name, status: 'warn', message: `Batch in flight ${ageLabel} (${itemCount} reviews) — next run resumes polling` };
  }
  return { name, status: 'pass', message: `Batch in flight ${ageLabel} (${itemCount} reviews) — next run resumes polling` };
}

function checkBatchState() {
  return [runCheck('Scoring: batch state', () => {
    if (!fs.existsSync(SCORING_BATCH_STATE_PATH)) {
      return batchStateResult(null);
    }
    let state;
    try {
      state = readJSON(SCORING_BATCH_STATE_PATH);
    } catch (err) {
      return { name: 'Scoring: batch state', status: 'warn', message: `Unparseable scoring-batch-state.json: ${err.message}` };
    }
    return batchStateResult(state);
  })];
}

// --- Category D: Content Quality ---

/**
 * providerSpendLedgerResult — decision for the "Data quality: provider spend
 * ledger" row. `raw` is the literal text of data/audit/provider-spend-daily.jsonl
 * (null when the file is absent/unreadable).
 *
 * Reads the ledger's own last `day` field rather than provider-spend-
 * snapshot.json's generatedAt: the two files are staged by separate `git add`
 * lines in the same commit step (adversarial review finding, 2026-09-14), so
 * if the ledger's `git add` ever silently no-ops while the snapshot's
 * succeeds, a generatedAt-based check would report healthy while the ledger —
 * the thing BRO-3317's acceptance criteria literally names — stayed frozen.
 *
 * BRO-3349: this row used to compare `Date.now() - new Date(lastDay)`, i.e.
 * measure from the START of the recorded day. That adds a phantom ~24h on
 * top of the ~24h that check-provider-spend.js's `day` is ALREADY behind
 * (its default DAY is utcYesterday() — the last COMPLETE day), and the row
 * is evaluated BEFORE "Provider spend reconciliation" runs later in the same
 * data-health-check.yml job, so the freshest `day` it can ever see is two
 * calendar days back. Healthy runs therefore measured 48h + hours-into-day
 * and tripped the >48h bar EVERY single-run day: the committed digest
 * snapshots show error on 2026-09-17/18/19/20/21 and pass only on 09-20's
 * second same-day run. Measuring from the END of the recorded day —
 * ledgerFreshnessHours(), the producer's own already-tested predicate — puts
 * a healthy run at 24-37h and a genuinely skipped reconciliation at 48h+,
 * which is the bar this check was always meant to enforce.
 *
 * Canonical-predicate rule (memory: feedback_includability_predicates_must_be_
 * canonical): import the producer's function, never restate its math here.
 * @param {string|null} raw
 * @param {Date} [now] injectable clock (tests) — never stubbed globally
 * @returns {{name: string, status: string, message: string, hint?: string}}
 */
function providerSpendLedgerResult(raw, now = new Date()) {
  const name = 'Data quality: provider spend ledger';
  const hint = 'node scripts/check-provider-spend.js';
  if (raw == null) {
    return { name, status: 'warn', message: 'No provider-spend ledger yet (cron not yet run)', hint };
  }
  // Corrupt-line-tolerant, same as check-provider-spend.js's own readLedger():
  // a bad row loses one day, never the whole check.
  const records = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { records.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
  }
  const age = ledgerFreshnessHours(records, now);
  if (!Number.isFinite(age)) {
    return { name, status: 'warn', message: 'Provider-spend ledger has no parseable rows', hint };
  }
  const lastDay = lastLedgerDay(records);
  if (age > PROVIDER_SPEND_STALE_HOURS) {
    return {
      name,
      status: 'error',
      message: `Provider spend ledger's newest entry (day=${lastDay}) is ${formatAge(age)} past its end-of-day (>${PROVIDER_SPEND_STALE_HOURS}h) — the daily reconciliation itself has stopped landing`,
      hint: 'Check the "Commit provider spend ledger (apiFallbackSafe)" step in data-health-check.yml — a push that reports success can still silently drop this file if an earlier commit step in the same job hard-resets the working tree first.',
    };
  }
  // A day still in progress (a manual `--day=<today>` run) has not ENDED yet,
  // so `age` is negative — "-12h past its end-of-day" is nonsense in the owner's
  // digest even though the pass verdict is right (ship-check P2).
  const ageText = age < 0 ? 'not yet ended' : `${formatAge(age)} past its end-of-day`;
  return { name, status: 'pass', message: `Newest entry (day=${lastDay}) ${ageText}` };
}

function checkQuality() {
  return [
    // Star-vs-score contradiction detector (card #396, Birthright 2026-07-24).
    // A review's EXPLICIT critic rating (5-star rave) that ends up scored as a
    // pan means the rating was mis-extracted — classically, the wrong show's
    // star grabbed off a combined multi-show review column (Theater Life), then
    // winning score-routing. Alerts only on findings NOT in the committed
    // baseline (data/audit/star-score-mismatch-baseline.json) so the known
    // backlog stays quiet and a genuinely NEW mismatch surfaces the day it
    // appears — a time window would miss slow-burn cases (Birthright's bad
    // extraction predated the user report by 19 days). `/^Quality:/` playbook
    // route = this-week warn, not a page.
    // BRO-5156: a stored openingDate later than the review cluster makes the
    // ingest anticipatory gate drop real first-night reviews as "pre-opening
    // posts" (Hercules WE 2025 lost five). Source labels ('ibdb',
    // 'theatremonkey') were often stamped after the fact, so this asks the
    // reviews instead. Warn only; triage with audit-opening-date-vs-reviews.js.
    // Own playbook entry below (the generic /^Quality:/ route describes a
    // scored-review-percentage drop, which is not what this measures).
    runCheck('Quality: opening date vs review dates', () => {
      const name = 'Quality: opening date vs review dates';
      const { scanOpeningDateContradictions, loadAcks } = require('./lib/opening-date-contradiction');
      const rtDir = path.join(DATA_DIR, 'review-texts');
      if (!fs.existsSync(rtDir)) {
        return { name, status: 'pass', message: 'Skipped (review-texts not checked out)' };
      }
      const showsData = readJSON(path.join(DATA_DIR, 'shows.json'));
      const shows = Array.isArray(showsData) ? showsData : (showsData?.shows || []);
      const { flagged, acked } = scanOpeningDateContradictions(shows, rtDir, loadAcks());
      if (flagged.length > 0) {
        const sample = flagged.slice(0, 3).map((f) => `${f.id} (stored ${f.openingDate}, reviews ${f.pressNight})`).join('; ');
        return { name, status: 'warn', message: `${flagged.length} show(s) store an opening date later than their reviews: ${sample}`, hint: 'node scripts/audit-opening-date-vs-reviews.js; fix with a data-edit plan or --ack=<id>' };
      }
      return { name, status: 'pass', message: `No opening date contradicts its reviews (${acked.length} acked)` };
    }),

    runCheck('Quality: star-vs-score mismatch', () => {
      const { scanReviewTexts } = require('./lib/star-score-mismatch');
      const rtDir = path.join(DATA_DIR, 'review-texts');
      if (!fs.existsSync(rtDir)) {
        return { name: 'Quality: star-vs-score mismatch', status: 'pass', message: 'Skipped (review-texts not checked out)' };
      }
      // BRO-3364: acks expire after 90 days (scripts/lib/baseline-ttl.js).
      const { activeBaselineKeys, describeExpiry } = require('./lib/baseline-ttl');
      let baselineKeys = new Set();
      let expiryNote = '';
      try {
        const b = readJSON(path.join(AUDIT_DIR, 'star-score-mismatch-baseline.json'));
        if (b && Array.isArray(b.keys)) {
          baselineKeys = activeBaselineKeys(b);
          expiryNote = describeExpiry(b, Date.now(), { renewCommand: '`node scripts/audit-star-score-mismatch.js --renew-baseline`' });
        }
      } catch { /* no baseline yet — everything is "new" */ }
      const { findings, baselinedCount } = scanReviewTexts(rtDir, { baselineKeys });
      if (findings.length === 0) {
        return { name: 'Quality: star-vs-score mismatch', status: 'pass', message: `No new star/score contradictions (${baselinedCount} known/baselined)${expiryNote}` };
      }
      const worst = findings[0];
      const hidden = findings.filter(f => f.starWonHidingContradiction).length;
      return {
        name: 'Quality: star-vs-score mismatch',
        status: 'warn',
        message: `${findings.length} NEW review(s) whose explicit rating contradicts the score (worst: ${worst.showId} ${worst.outlet} ${worst.originalRating}→${worst.expected} vs LLM ${worst.llm}, gap ${worst.worstGap})${hidden ? `; ${hidden} star-won-hiding` : ''}${expiryNote}`,
        hint: 'Run `node scripts/audit-star-score-mismatch.js` — likely a mis-extracted star (wrong show in a combined review column). Fix originalScore in review-texts + rescore, then `--write-baseline` to ack (acks expire after 90 days; `--renew-baseline=<key>` re-acks one key, bare `--renew-baseline` every listed key).',
      };
    }),

    runCheck('Quality: scored review ratio', () => {
      const reviews = readJSON(path.join(DATA_DIR, 'reviews.json'));
      const stats = reviews._meta?.stats || {};
      const scored = stats.totalReviews || 0;
      const noScore = stats.skippedNoScore || 0;
      const total = scored + noScore;
      if (total === 0) {
        return { name: 'Quality: scored review ratio', status: 'warn', message: 'No review stats available' };
      }
      const pct = ((scored / total) * 100).toFixed(1);
      if (pct < 35) {
        return { name: 'Quality: scored review ratio', status: 'warn', message: `${pct}% scored (${scored}/${total}) — below 35% threshold`, hint: 'LLM scoring may need attention' };
      }
      return { name: 'Quality: scored review ratio', status: 'pass', message: `${pct}% scored (${scored}/${total})` };
    }),

    // Surfaces the corpus-statistics drift monitor (check-corpus-drift.yml) in
    // the digest. Those audits (text-quality %, aggregator-truth ratios, regex
    // FP counts) were moved OUT of test.yml to non-blocking on 2026-06-21 so
    // they'd stop redding main as the rebuild bots drift the corpus every ~30
    // min. The workflow + workflows/CLAUDE.md both claimed they were "surfaced
    // in the daily digest by health-check.js" — but that wiring never existed,
    // so the signals were silently swallowed (advisory ≠ invisible). This is
    // that wiring: a drift audit that CANNOT RUN is an error (the monitor is
    // broken); drift itself is a `this-week` warn (via the /^Quality:/ playbook
    // route) so it shows in the digest without paging. Added 2026-06-22.
    runCheck('Quality: corpus drift', () => {
      const driftFile = path.join(AUDIT_DIR, 'corpus-drift.json');
      if (!fs.existsSync(driftFile)) {
        return { name: 'Quality: corpus drift', status: 'warn', message: 'No corpus-drift data (check-corpus-drift.yml may not have run)', hint: 'Trigger the "Check Corpus Drift" workflow' };
      }
      const data = readJSON(driftFile);
      const ts = data?._meta?.generatedAt;
      const age = ts ? hoursAgo(ts) : Infinity;
      // Daily cron + post-rebuild; 36h means it's missed a day of runs.
      if (age > 36) {
        return { name: 'Quality: corpus drift', status: 'warn', message: `Drift monitor last ran ${formatAge(age)} ago (>36h)`, hint: 'check-corpus-drift.yml may be stale/disabled' };
      }
      const audits = Array.isArray(data?.audits) ? data.audits : [];
      const crashed = audits.filter(a => a.crashed);
      if (crashed.length > 0) {
        // A drift audit that can't even run is a real problem, not drift.
        return { name: 'Quality: corpus drift', status: 'error', message: `${crashed.length} drift audit(s) crashed: ${crashed.map(a => a.name).join(', ')}`, hint: 'A corpus-statistics audit cannot scan — see data/audit/corpus-drift.json' };
      }
      const drifted = audits.filter(a => !a.ok && !a.crashed);
      // BRO-6082: an audit stamped with a channel (check-corpus-drift.js
      // runAudit) already reaches the owner on its own card or the FYI line;
      // only drift with no channel (a report written before the stamp) stays
      // a dispatched row here, so this umbrella cannot park on statistics.
      const unrouted = drifted.filter(a => a.channel !== 'card' && a.channel !== 'fyi');
      if (drifted.length > 0 && unrouted.length === 0) {
        return { name: 'Quality: corpus drift', status: 'pass', message: `${drifted.length} audit(s) drifting, each reported on its own card or the digest FYI line (${formatAge(age)} ago)` };
      }
      if (drifted.length > 0) {
        return { name: 'Quality: corpus drift', status: 'warn', message: `${drifted.length} audit(s) drifting: ${drifted.map(a => a.label || a.name).join(', ')}`, hint: 'Non-blocking corpus drift — review data/audit/corpus-drift.json' };
      }
      return { name: 'Quality: corpus drift', status: 'pass', message: `${audits.length} audits within thresholds (${formatAge(age)} ago)` };
    }),

    // Surfaces the DMARC deliverability verdict (BRO-525). The ingest routes
    // only 'action' findings through routeAlert; everything milder — including
    // 'policy-upgrade-available', the payoff of a clean authentication record
    // — would otherwise sit in a file nobody opens, which is the exact failure
    // that card was filed about (233 unread reports). Warn-level so it shows
    // in the digest without paging.
    runCheck('Quality: DMARC deliverability', () => {
      const { dmarcHealthResult } = require('./lib/dmarc-analysis.js');
      const summaryFile = path.join(AUDIT_DIR, 'dmarc-summary.json');
      const summary = fs.existsSync(summaryFile) ? readJSON(summaryFile) : null;
      return { name: 'Quality: DMARC deliverability', ...dmarcHealthResult(summary) };
    }),

    // Silent-exclusion detectors (#1147 tracker, card #1188): a pipeline stage
    // refuses to include a review and records nothing an operator would ever
    // look at. Two live incidents, both fixed by hand with no detector left
    // behind — this is that detector, wired into the existing daily digest
    // rather than a new cron. Advisory `this-week` warns via the /^Quality:/
    // playbook route, not a page: both predicates report CANDIDATES for a
    // human to confirm, never write.
    runCheck('Quality: missing contentTier', () => {
      const rtDir = path.join(DATA_DIR, 'review-texts');
      if (!fs.existsSync(rtDir)) {
        return { name: 'Quality: missing contentTier', status: 'pass', message: 'Skipped (review-texts not checked out)' };
      }
      const { scanMissingContentTier } = require('./lib/silent-exclusion-detectors');
      let showsById = {};
      try {
        const showsArr = readJSON(path.join(DATA_DIR, 'shows.json'));
        for (const s of (Array.isArray(showsArr) ? showsArr : showsArr.shows) || []) {
          if (s && s.id) showsById[s.id] = s;
        }
      } catch { /* shows.json unreadable — scan degrades to no show-context checks */ }
      let hits = scanMissingContentTier(rtDir, showsById);
      // rebuild-all-reviews.js reclassifies contentTier unconditionally on
      // every pass (in-memory, before the review is pushed to reviews.json),
      // so a source file missing contentTier does NOT necessarily mean the
      // review is currently absent — only that its source file's write-back
      // failed or hasn't run yet. Cross-check against the live reviews.json
      // so this check reports the residual gap, not every stale source file.
      const reviewsPath = path.join(DATA_DIR, 'reviews.json');
      if (hits.length > 0 && fs.existsSync(reviewsPath)) {
        try {
          const live = readJSON(reviewsPath);
          // Keyed by url+showId, not url alone (ship-check finding): a
          // review URL reused across two DIFFERENT shows (rare, but review
          // URLs aren't validated globally-unique) must not let one show's
          // live entry suppress a genuine gap under a different show.
          const liveUrlShowKeys = new Set(
            (live.reviews || []).map((r) => (r.url ? `${r.url}|${r.showId}` : null)).filter(Boolean),
          );
          const liveTriples = new Set(
            (live.reviews || []).map((r) => `${r.showId}|${String(r.outletId || '').toLowerCase()}|${String(r.criticName || '').toLowerCase().trim()}`),
          );
          // Match on url+showId FIRST when the hit has a url: two review-text
          // files can share showId+outletId+criticName (a republished
          // article, or byline-enrichment landing on two separate URLs) — the
          // coarser triple match alone would let one file already live in
          // reviews.json mask the OTHER file's genuine gap (ship-check
          // finding). Only fall back to the triple match when the hit has no
          // url to compare.
          hits = hits.filter((h) => {
            if (h.url) return !liveUrlShowKeys.has(`${h.url}|${h.showId}`);
            return !liveTriples.has(`${h.showId}|${String(h.outletId || '').toLowerCase()}|${String(h.criticName || '').toLowerCase().trim()}`);
          });
        } catch { /* reviews.json unreadable — report the unfiltered (safe-direction) hit list */ }
      }
      if (hits.length === 0) {
        return { name: 'Quality: missing contentTier', status: 'pass', message: 'No scored reviews missing contentTier' };
      }
      const worst = hits[0];
      return {
        name: 'Quality: missing contentTier',
        status: 'warn',
        message: `${hits.length} review(s) have fullText + a real byline + no rejection flags but NO contentTier, and are NOT in reviews.json (e.g. ${worst.showId}/${worst.file})`,
        hint: 'A review-text file lost its contentTier without fullText changing, so rebuild never re-derives it. Run classifyContentTier on it and restore contentTier by hand, or add contentTier to the show\'s review file directly.',
      };
    }),

    runCheck('Quality: outlet domain moves', () => {
      const registryPath = path.join(DATA_DIR, 'outlet-registry.json');
      const censusPath = path.join(AUDIT_DIR, 'unknown-aggregator-outlets.json');
      if (!fs.existsSync(registryPath) || !fs.existsSync(censusPath)) {
        return { name: 'Quality: outlet domain moves', status: 'pass', message: 'Skipped (registry or unknown-outlet census not present)' };
      }
      const { findProbableDomainMoves } = require('./lib/silent-exclusion-detectors');
      let outlets, census;
      try {
        outlets = readJSON(registryPath)?.outlets;
        census = readJSON(censusPath);
      } catch (parseErr) {
        // A malformed/mid-write file is a soft signal (retry next run), not a
        // crash — matches the sibling checks' pattern (e.g. Sync: grosses
        // weekEnding, Scoring: batch state) rather than falling through to
        // runCheck's generic try/catch, which would report 'error' and feed
        // the digest's escalation path for what's really a transient read.
        return { name: 'Quality: outlet domain moves', status: 'warn', message: `Could not parse registry or census: ${parseErr.message}`, hint: 'Likely a mid-write file — should clear on the next run' };
      }
      const ts = census?.generatedAt;
      const age = ts ? hoursAgo(ts) : Infinity;
      if (age > 48) {
        return { name: 'Quality: outlet domain moves', status: 'warn', message: `Unknown-outlet census is ${formatAge(age)} old (>48h)`, hint: 'The census that this check mines may be stale — check what writes data/audit/unknown-aggregator-outlets.json' };
      }
      const moves = findProbableDomainMoves(outlets, census?.outlets || []);
      if (moves.length === 0) {
        return { name: 'Quality: outlet domain moves', status: 'pass', message: `No probable domain moves in ${census?.outlets?.length || 0} unregistered host(s)` };
      }
      const worst = moves[0];
      return {
        name: 'Quality: outlet domain moves',
        status: 'warn',
        message: `${moves.length} unregistered host(s) name-match a registered outlet (e.g. ${worst.host} → ${worst.outletId}) — probable domain move dropping reviews via domain-mismatch`,
        hint: 'Confirm the host really belongs to that outlet, then add it to that outlet\'s domainAliases in data/outlet-registry.json.',
      };
    }),

    // BRO-4359: an opened show with a cached Show Score URL but no Show Score
    // audience source (School Girls, 2026-09-28: dead cached URL, nothing alerted).
    runCheck('Quality: Show Score gap', () => {
      const name = 'Quality: Show Score gap';
      const files = ['shows.json', 'show-score-urls.json', 'audience-buzz.json'].map((f) => path.join(DATA_DIR, f));
      if (!files.every((f) => fs.existsSync(f))) {
        return { name, status: 'pass', message: 'Skipped (shows, show-score-urls or audience-buzz not present)' };
      }
      const { findShowScoreGaps } = require('./lib/showscore-gap-detector');
      let shows, urls, buzz;
      try {
        shows = readJSON(files[0])?.shows;
        urls = readJSON(files[1])?.shows;
        buzz = readJSON(files[2])?.shows;
      } catch (parseErr) {
        return { name, status: 'warn', message: `Could not parse data: ${parseErr.message}`, hint: 'Likely a mid-write file, should clear on the next run' };
      }
      const gaps = findShowScoreGaps(shows, urls, buzz);
      if (gaps.length === 0) {
        return { name, status: 'pass', message: 'Every opened Broadway/off-Broadway show with a cached Show Score URL has a Show Score audience score' };
      }
      const ids = gaps.slice(0, 5).map((g) => g.id).join(', ');
      return {
        name,
        status: 'warn',
        message: `${gaps.length} opened show(s) have a cached Show Score URL but no Show Score audience score (${ids}${gaps.length > 5 ? ', ...' : ''})`,
        hint: 'No Show Score audience source despite a cached URL: the URL may be dead, the page may have no ratings yet, or the show shares a page with a sibling production. Check the page, then re-run update-show-score for the show (the scraper self-heals dead URLs, BRO-4358) and check data/show-score-urls.json.',
      };
    }),

    // Outlet stub-rate monitor (card #100): when an outlet redesigns its
    // site, its article-extractor.js pattern can silently stop matching —
    // extractArticleTextFromUrl returns 0 chars, the review saves as
    // contentTier:stub, and it never scores. Nothing alerted on this until
    // TheaterMania's 2026 Bootstrap redesign left 26 reviews stuck as stubs
    // corpus-wide, caught only by accident chasing one unrelated show. A
    // healthy outlet has old/legacy stub debt; a broken extractor produces a
    // SPIKE in the stub rate among reviews collected in the last 30 days —
    // that's the signal computeOutletStubRates() looks for. Advisory
    // `this-week` warn via the /^Quality:/ playbook route, not a page: it
    // reports a candidate for a human to confirm (real redesign vs. a run of
    // genuinely un-extractable pages), never writes.
    runCheck('Quality: outlet stub rate', () => {
      const rtDir = path.join(DATA_DIR, 'review-texts');
      if (!fs.existsSync(rtDir)) {
        return { name: 'Quality: outlet stub rate', status: 'pass', message: 'Skipped (review-texts not checked out)' };
      }
      const { collectReviewRecords, computeOutletStubRates } = require('./audit-outlet-stub-rate.js');
      const records = collectReviewRecords(rtDir);
      const { outlets, flaggedOutletIds } = computeOutletStubRates(records);
      if (flaggedOutletIds.length === 0) {
        return { name: 'Quality: outlet stub rate', status: 'pass', message: `No broken-extractor signature in ${outlets.length} outlet(s), ${records.length} review(s)` };
      }
      const worst = outlets.find((o) => o.outletId === flaggedOutletIds[0]);
      return {
        name: 'Quality: outlet stub rate',
        status: 'warn',
        message: `${flaggedOutletIds.length} outlet(s) show a broken-extractor signature (worst: ${worst.outletId} — ${worst.recentStubCount}/${worst.recentTotal} recent stubs, ${(worst.recentStubRate * 100).toFixed(0)}%)`,
        hint: 'Run `node scripts/audit-outlet-stub-rate.js` — likely a redesigned article-extractor.js pattern no longer matching. See tests/unit/theatermania-extractor.test.mjs for the fix pattern (regression test + updated extraction pattern).',
      };
    }),

    // Outlet invalid-content-rate monitor (card #1244, generalizing #100):
    // same broken-extractor failure mode as the stub check above, but for
    // extractions that DID return something — just not real article text
    // (cookie wall, 404-as-200, boilerplate; isGarbageContent() in
    // content-quality.js). 'invalid' is 23x larger corpus-wide than 'stub'
    // and includes outlets that are chronically near-100% invalid
    // (paywalled/bot-blocked, not newly broken) — computeOutletInvalidRates()
    // additionally requires the recent rate to SPIKE over the outlet's own
    // pre-window baseline so those don't cry wolf every day. It also excludes
    // wrongProduction/wrongShow-reasoned 'invalid' records by default (card
    // #1266) — that's a different classifyContentTier() code path (extractor
    // is fine, wrong show matched) with its own FP sweep (tasks #24/#243), not
    // an extractor-health signal. Same advisory `this-week` warn via the
    // /^Quality:/ playbook route, never writes.
    runCheck('Quality: outlet invalid-content rate', () => {
      const rtDir = path.join(DATA_DIR, 'review-texts');
      if (!fs.existsSync(rtDir)) {
        return { name: 'Quality: outlet invalid-content rate', status: 'pass', message: 'Skipped (review-texts not checked out)' };
      }
      const { collectReviewRecords, computeOutletInvalidRates } = require('./audit-outlet-stub-rate.js');
      const records = collectReviewRecords(rtDir);
      const { outlets, flaggedOutletIds } = computeOutletInvalidRates(records);
      if (flaggedOutletIds.length === 0) {
        return { name: 'Quality: outlet invalid-content rate', status: 'pass', message: `No broken-extractor signature in ${outlets.length} outlet(s), ${records.length} review(s)` };
      }
      const worst = outlets.find((o) => o.outletId === flaggedOutletIds[0]);
      return {
        name: 'Quality: outlet invalid-content rate',
        status: 'warn',
        message: `${flaggedOutletIds.length} outlet(s) show a broken-extractor signature (worst: ${worst.outletId} — ${worst.recentInvalidCount}/${worst.recentTotal} recent invalid, ${(worst.recentInvalidRate * 100).toFixed(0)}% vs ${(worst.baselineInvalidRate * 100).toFixed(0)}% baseline)`,
        hint: 'Run `node scripts/audit-outlet-stub-rate.js` — wrongProduction/wrongShow-reasoned records are excluded from this check (see tasks #24/#243 for that FP sweep), so a flag here should be a genuine article-extractor.js regression. Spot-check contentTierReason on the flagged files to confirm before diving in.',
      };
    }),

    // Affiliate revenue-stream monitor (affiliate hardening plan 2026-08-03).
    // check-affiliate-health.js runs earlier in the same data-health-check.yml
    // job and writes this snapshot; this line is (a) the digest surface for
    // its findings and (b) the monitor's own dead-man — a monitor that stops
    // writing its snapshot looks exactly like a healthy pipeline to any check
    // that only reads the last row (the arm-yield 'unobserved' lesson). This
    // is the site's ONLY revenue stream: a stale/broken monitor is an error,
    // not a warn.
    runCheck('Revenue: affiliate health', () => {
      const snapFile = path.join(AUDIT_DIR, 'affiliate-health.json');
      if (!fs.existsSync(snapFile)) {
        return { name: 'Revenue: affiliate health', status: 'warn', message: 'No affiliate-health snapshot yet (monitor not yet run)', hint: 'node scripts/check-affiliate-health.js --dry-run' };
      }
      const snap = readJSON(snapFile);
      const age = snap?.updatedAt ? hoursAgo(snap.updatedAt) : Infinity;
      if (age > 48) {
        return { name: 'Revenue: affiliate health', status: 'error', message: `Affiliate monitor snapshot is ${formatAge(age)} old (>48h) — the revenue-stream monitor itself is dead`, hint: 'Check the "Affiliate health monitor" step in data-health-check.yml' };
      }
      const checks = Array.isArray(snap?.checks) ? snap.checks : [];
      const criticals = checks.filter(c => c.verdict === 'critical');
      const warns = checks.filter(c => c.verdict === 'warn');
      const shadowTag = snap.shadow ? ' [shadow burn-in]' : '';
      if (criticals.length > 0) {
        return { name: 'Revenue: affiliate health', status: 'error', message: `${criticals.length} critical: ${criticals.map(c => c.label).join(', ')}${shadowTag}`, hint: criticals[0].reason };
      }
      if (warns.length > 0) {
        return { name: 'Revenue: affiliate health', status: 'warn', message: `${warns.length} anomaly: ${warns.map(c => c.label).join(', ')}${shadowTag}`, hint: warns[0].reason };
      }
      return { name: 'Revenue: affiliate health', status: 'pass', message: `${checks.length} checks healthy (${formatAge(age)} ago)${shadowTag}` };
    }),

    // Provider spend ledger dead-man (BRO-3317). The decision lives in
    // providerSpendLedgerResult() above (exported + unit-tested, CLAUDE.md
    // §15) so this row's freshness math cannot drift from the producer's
    // again — see that function's docstring for the BRO-3349 false-positive
    // this shape fixed.
    runCheck('Data quality: provider spend ledger', () => {
      const ledgerFile = path.join(AUDIT_DIR, 'provider-spend-daily.jsonl');
      let raw = null;
      try { raw = fs.readFileSync(ledgerFile, 'utf8'); } catch { /* absent/unreadable -> null */ }
      return providerSpendLedgerResult(raw);
    }),

    // Cross-outlet attribution drift (card #1550, Notion 3bd637c5-416f-81b0):
    // scripts/check-cross-outlet-attribution-drift.js runs earlier in this same
    // data-health-check.yml job and writes this snapshot — same dead-man shape as
    // "Revenue: affiliate health" above. A failing suspect count is a warn, not an
    // error: drift is expected as new review-texts land (opening-night pollers,
    // discovery), the underlying audit's own unit test is what the owner runs to
    // triage it, and this is a shadow-mode visibility check, not a gate (see the
    // card: a hard CI gate would redden main on legitimate data). An error is
    // reserved for the detector itself going dark.
    runCheck('Data quality: cross-outlet attribution drift', () => {
      const name = 'Data quality: cross-outlet attribution drift';
      const snapFile = path.join(AUDIT_DIR, 'cross-outlet-attribution-drift.json');
      if (!fs.existsSync(snapFile)) {
        return { name, status: 'warn', message: 'No drift-check snapshot yet (cron not yet run)', hint: 'node scripts/check-cross-outlet-attribution-drift.js' };
      }
      const snap = readJSON(snapFile);
      const age = snap?.updatedAt ? hoursAgo(snap.updatedAt) : Infinity;
      if (age > 48) {
        return { name, status: 'error', message: `Drift-check snapshot is ${formatAge(age)} old (>48h) — the daily check itself has stopped running`, hint: 'Check the "Cross-outlet attribution drift check" step in data-health-check.yml' };
      }
      if (snap.summaryUnparseable) {
        return { name, status: 'warn', message: `Could not parse the node --test summary (${formatAge(age)} ago) — the check's own parser needs updating, this is NOT a suspect-count reading`, hint: 'node scripts/check-cross-outlet-attribution-drift.test.mjs and scripts/check-cross-outlet-attribution-drift.js parseCount() vs current `node --test` output format' };
      }
      if (snap.allSkipped) {
        return { name, status: 'warn', message: `Skipped (${formatAge(age)} ago) — data/review-texts was not checked out in that run`, hint: 'Should not happen in data-health-check.yml, which always checks out review-texts; investigate the workflow run.' };
      }
      if (!snap.passed) {
        return { name, status: 'warn', message: `Unreviewed cross-outlet attribution suspect(s) found (${formatAge(age)} ago)`, hint: 'node scripts/audit-cross-outlet-attributions.js --json (and --include-fulltext / --playbill-bleed) to triage' };
      }
      return { name, status: 'pass', message: `No unreviewed suspects (${formatAge(age)} ago)` };
    }),

    // Opening-night bypass check lifetime coverage (task #1731). The check
    // itself (cv-wrongproduction-unhandled.check.js) only ran within
    // opening-night-checklist.js's ±2-day-of-opening window, so an older show
    // could re-trip the exact juan-a-ramirez bypass class (task #1712's 3
    // confirmed cases, all reintroduced weeks post-opening) with nothing ever
    // looking again. scripts/audit-cv-wrongproduction-lifetime.js runs the
    // SAME check against the full corpus. A warn, not an error, and never a
    // real-time page: a real test run found 800+ hits, the large majority
    // shaped like intentional prior-run coverage (priorRuns cross-links —
    // Kennedy Center/Lincoln Center/West End tryouts) the check has no way to
    // recognize, mirroring how the ±2-day version of this same check already
    // routes to a low-urgency 'digest' disposition in alert-ledger.json
    // rather than paging. An error is reserved for the detector itself going
    // dark (stale/missing snapshot) — see that script's header for the full
    // false-positive-rate discussion before tightening this to 'error'.
    //
    // Keys off newSinceLastRun, NOT totalViolations (ship-check/Codex
    // adversarial finding): with an 800+ known baseline, a raw-total-driven
    // digest would warn every single day forever — indistinguishable from
    // always passing, and trains the owner to ignore it. The script diffs
    // each run's violation-key set against the previous snapshot; only a
    // NEW (showId+filename) hit since last run trips the warn. totalViolations
    // still rides in the message as informational context, not the trigger.
    runCheck('Data quality: cv-wrongproduction lifetime sweep', () => {
      const name = 'Data quality: cv-wrongproduction lifetime sweep';
      const snapFile = path.join(AUDIT_DIR, 'cv-wrongproduction-lifetime.json');
      if (!fs.existsSync(snapFile)) {
        return { name, status: 'warn', message: 'No lifetime-sweep snapshot yet (cron not yet run)', hint: 'node scripts/audit-cv-wrongproduction-lifetime.js' };
      }
      const snap = readJSON(snapFile);
      const age = snap?.updatedAt ? hoursAgo(snap.updatedAt) : Infinity;
      if (age > 48) {
        return { name, status: 'error', message: `Lifetime-sweep snapshot is ${formatAge(age)} old (>48h) — the daily sweep itself has stopped running`, hint: 'Check the "cv-wrongproduction lifetime sweep" step in data-health-check.yml' };
      }
      if (snap.newSinceLastRun > 0) {
        return { name, status: 'warn', message: `${snap.newSinceLastRun} NEW unhandled CV.wrongProduction review(s) since last run (${snap.totalViolations} total across ${snap.showsWithViolations} show(s), ${formatAge(age)} ago)`, hint: 'node scripts/audit-cv-wrongproduction-lifetime.js --json to triage; check newViolationKeys in the snapshot for which ones are new' };
      }
      return { name, status: 'pass', message: `No new unhandled violations since last run (${snap.totalViolations} known baseline across ${snap.scanned} show(s), ${formatAge(age)} ago)` };
    }),

    // 4 more lifetime-sweep digest checks (task #1746), extending the
    // cv-wrongproduction pattern immediately above to the other
    // opening-night-checks plugins with the same ±2-day-window blind spot:
    // fulltext-mentions-show, slug-mismatch, roundup-url-mismatch,
    // revival-unverified. Same reasoning throughout — warn (never error
    // except detector staleness), keyed off newSinceLastRun not
    // totalViolations, for the identical alert-fatigue reason.
    ...[
      {
        name: 'Data quality: fulltext-mentions-show lifetime sweep',
        snapFile: 'fulltext-mentions-show-lifetime.json',
        scriptName: 'audit-fulltext-mentions-show-lifetime.js',
        stepName: 'fulltext-mentions-show lifetime sweep',
        unit: 'unmatched review(s)',
      },
      {
        name: 'Data quality: slug-mismatch lifetime sweep',
        snapFile: 'slug-mismatch-lifetime.json',
        scriptName: 'audit-slug-mismatch-lifetime.js',
        stepName: 'slug-mismatch lifetime sweep',
        unit: 'cross-show URL mismatch(es)',
      },
      {
        name: 'Data quality: roundup-url-mismatch lifetime sweep',
        snapFile: 'roundup-url-mismatch-lifetime.json',
        scriptName: 'audit-roundup-url-mismatch-lifetime.js',
        stepName: 'roundup-url-mismatch lifetime sweep',
        unit: 'roundup attribution mismatch(es)',
      },
      {
        name: 'Data quality: revival-unverified lifetime sweep',
        snapFile: 'revival-unverified-lifetime.json',
        scriptName: 'audit-revival-unverified-lifetime.js',
        stepName: 'revival-unverified lifetime sweep',
        unit: 'unverified revival flag(s)',
      },
    ].map(({ name, snapFile, scriptName, stepName, unit }) => runCheck(name, () => {
      const snapPath = path.join(AUDIT_DIR, snapFile);
      if (!fs.existsSync(snapPath)) {
        return { name, status: 'warn', message: 'No lifetime-sweep snapshot yet (cron not yet run)', hint: `node scripts/${scriptName}` };
      }
      const snap = readJSON(snapPath);
      const age = snap?.updatedAt ? hoursAgo(snap.updatedAt) : Infinity;
      if (age > 48) {
        return { name, status: 'error', message: `Lifetime-sweep snapshot is ${formatAge(age)} old (>48h) — the daily sweep itself has stopped running`, hint: `Check the "${stepName}" step in data-health-check.yml` };
      }
      if (snap.newSinceLastRun > 0) {
        return { name, status: 'warn', message: `${snap.newSinceLastRun} NEW ${unit} since last run (${snap.totalViolations} total across ${snap.showsWithViolations} show(s), ${formatAge(age)} ago)`, hint: `node scripts/${scriptName} --json to triage; check newViolationKeys in the snapshot for which ones are new` };
      }
      return { name, status: 'pass', message: `No new violations since last run (${snap.totalViolations} known baseline across ${snap.scanned} show(s), ${formatAge(age)} ago)` };
    })),

    // Missed opening-night broadcast sweep (BRO-2934). The dead-man half of
    // this check is the point: check-missed-broadcasts.js runs under
    // continue-on-error in data-health-check.yml (like every sibling sweep),
    // so if the script or the alert router breaks, it fails silently and the
    // owner simply stops being told about missed sends — the exact silence
    // this whole feature exists to end. A stale snapshot is therefore an
    // ERROR, not a warning. The findings themselves ride as a warn: the
    // script already pages per-show for anything actionable, so the digest
    // line's job is to keep the aged-out backlog visible rather than to
    // re-alarm about it.
    runCheck('Data quality: missed opening-night broadcasts', () => {
      const name = 'Data quality: missed opening-night broadcasts';
      const snapPath = path.join(AUDIT_DIR, 'missed-broadcasts.json');
      if (!fs.existsSync(snapPath)) {
        return { name, status: 'warn', message: 'No missed-broadcast snapshot yet (cron not yet run)', hint: 'node scripts/check-missed-broadcasts.js --dry-run' };
      }
      const snap = readJSON(snapPath);
      const age = snap?.generatedAt ? hoursAgo(snap.generatedAt) : Infinity;
      if (age > 48) {
        return { name, status: 'error', message: `Missed-broadcast snapshot is ${formatAge(age)} old (>48h) — the sweep itself has stopped running, so missed sends are going unreported again`, hint: 'Check the "Missed opening-night broadcast sweep" step in data-health-check.yml' };
      }
      const { uncovered, covered, alertable, agedOut } = summarizeMissedForHealth(snap);
      if (uncovered > 0) {
        return { name, status: 'warn', message: `${uncovered} show(s) opened and qualified but never emailed subscribers (${alertable} still alertable, ${agedOut} aged out past the paging window${covered ? `; ${covered} more were covered by a weekly round-up` : ''}, ${formatAge(age)} ago)`, hint: 'node scripts/check-missed-broadcasts.js --dry-run to list them with per-show remediation' };
      }
      return { name, status: 'pass', message: covered ? `No qualifying show was missed (${covered} reached subscribers via a weekly round-up rather than their own email, ${formatAge(age)} ago)` : `Every qualifying show reached subscribers (${formatAge(age)} ago)` };
    }),

    // Stale announced-shows audit (BRO-2620, BRO-93). audit-stale-announced-
    // shows.js now runs in this same job's "Stale announced shows audit
    // (shadow mode)" step — see that step's own comment for why nothing ran
    // it before this. A warn, not an error, mirrors every other shadow-mode
    // check in this file: a real flag is a data-quality issue (a show
    // showing the wrong status and no score on the live site), not this
    // job's own health failing. silencedByContaminationCount always rides in
    // the message, flagged or not — BRO-2611 added that discount specifically
    // so a too-aggressive contamination filter stays visible instead of
    // silently zeroing out flaggedCount; a digest row that only ever reports
    // flaggedCount would defeat that.
    //
    // Warns on flaggedCount TOTAL, not a newSinceLastRun delta (unlike the
    // cv-wrongproduction/4-sweep checks above) — deliberately: this audit has
    // a per-show --ack mechanism (evaluateAnnouncedShow excludes acked shows
    // from `flagged` entirely), so a real flag stays actionable rather than
    // becoming permanent background noise the way an untriaged lifetime-sweep
    // total would. Triage via --ack and flaggedCount drops back to 0.
    //
    // reviewTextsAvailable: false (ship-check/Codex adversarial finding) is
    // its own distinct warn, mirroring the cross-outlet-attribution-drift
    // check's `allSkipped` handling above — without it, a failed/skipped
    // review-texts checkout in this job silently downgrades the audit to
    // date-only signal and can report "no stale shows" while never having
    // scanned the review-driven cases at all.
    runCheck('Data quality: stale announced shows', () => {
      const name = 'Data quality: stale announced shows';
      const snapPath = path.join(AUDIT_DIR, 'stale-announced-shows.json');
      if (!fs.existsSync(snapPath)) {
        return { name, status: 'warn', message: 'No stale-announced-shows snapshot yet (cron not yet run)', hint: 'node scripts/audit-stale-announced-shows.js' };
      }
      const snap = readJSON(snapPath);
      const age = snap?.generatedAt ? hoursAgo(snap.generatedAt) : Infinity;
      if (age > 48) {
        return { name, status: 'error', message: `Stale-announced-shows snapshot is ${formatAge(age)} old (>48h) — the daily audit itself has stopped running`, hint: 'Check the "Stale announced shows audit" step in data-health-check.yml' };
      }
      if (snap.reviewTextsAvailable === false) {
        return { name, status: 'warn', message: `data/review-texts was not checked out in that run (${formatAge(age)} ago) — only date-based signals fired, review-driven stale flags may be missed`, hint: 'Check the "Checkout review-texts (private repo)" step in data-health-check.yml' };
      }
      const silencedNote = `${snap.silencedByContaminationCount ?? 0} silenced by contamination`;
      if (snap.flaggedCount > 0) {
        return { name, status: 'warn', message: `${snap.flaggedCount} show(s) still 'announced' after apparently opening (${silencedNote}, ${formatAge(age)} ago)`, hint: 'node scripts/audit-stale-announced-shows.js to see `flagged` and triage with --ack=<id> --ack-note="..."' };
      }
      return { name, status: 'pass', message: `No stale 'announced' shows (${silencedNote}, ${formatAge(age)} ago)` };
    }),

    // Coverage Verdict S1 (tasks #872 + #898). #872 measured SERP-census recall
    // once, after four owner spot-checks in a row found published reviews the
    // census reported absent — then nothing measured it again, so the next arm
    // regression would be invisible exactly the way the last four were. The
    // weekly audit-census-recall.yml cron writes the verdict here; this is what
    // makes it something the owner sees rather than a file nobody opens.
    //
    // A regression is a warn, not an error: recall is a measurement, and the
    // gate it feeds (S2+) is fail-open by design. An error is reserved for the
    // DETECTOR being broken — no data, or stale data, which means the cadence
    // itself has stopped and the blindness is back.
    runCheck(CENSUS_RECALL_CHECK, () => {
      const statusFile = path.join(AUDIT_DIR, 'census-recall-status.json');
      if (!fs.existsSync(statusFile)) return censusRecallResult(null);
      let data;
      try {
        data = readJSON(statusFile);
      } catch (err) {
        return { name: CENSUS_RECALL_CHECK, status: 'warn', message: `Unparseable census-recall-status.json: ${err.message}` };
      }
      return censusRecallResult(data);
    }),

    // Coverage Verdict S5 (task #903, the FINAL sprint). Findings surface
    // here — never as email spam or a blocking CI run — because the plan is
    // explicit that a seeded adversarial finding is this-week work, not a
    // page. An error is reserved for the detector itself going quiet.
    runCheck(COVERAGE_PROBE_CHECK, () => {
      const statusFile = path.join(AUDIT_DIR, 'coverage-adversarial-probe-status.json');
      if (!fs.existsSync(statusFile)) return coverageProbeResult(null);
      let data;
      try {
        data = readJSON(statusFile);
      } catch (err) {
        return { name: COVERAGE_PROBE_CHECK, status: 'warn', message: `Unparseable coverage-adversarial-probe-status.json: ${err.message}` };
      }
      return coverageProbeResult(data);
    }),
  ];
}

const CENSUS_RECALL_CHECK = 'Coverage: SERP census recall';
/** Weekly cron; past this the detector has missed a run outright. */
const CENSUS_RECALL_MAX_AGE_HOURS = 24 * 9;

/**
 * Render the census-recall verdict as a digest check (Coverage Verdict S1,
 * tasks #872 + #898).
 *
 * Severity, and why it is not the other way round:
 *   · a REGRESSION is a warn. Recall is a measurement, and the gate it
 *     eventually feeds (S2+) is fail-open by design — an error here would page
 *     the owner over a number that suppresses nothing.
 *   · MISSING or STALE data is also surfaced rather than skipped, because that
 *     means the cadence itself has stopped and the #898 blindness is back. A
 *     detector that goes quiet must never read as health (the #647 lesson).
 *
 * Pure so it can be tested against fixtures without a live audit file
 * (CLAUDE.md rule 15); checkQuality() supplies the I/O.
 *
 * @param {object|null} data parsed data/audit/census-recall-status.json
 * @param {object} [opts] {nowMs} for deterministic age in tests
 */
function censusRecallResult(data, opts = {}) {
  const name = CENSUS_RECALL_CHECK;
  if (!data) {
    return { name, status: 'warn', message: 'No census-recall data (audit-census-recall.yml may not have run yet)', hint: 'Run `gh workflow run "Audit Census Recall"`' };
  }
  const now = opts.nowMs === undefined ? Date.now() : opts.nowMs;
  const ts = data.generatedAt ? Date.parse(data.generatedAt) : NaN;
  const age = Number.isFinite(ts) ? (now - ts) / 3600000 : Infinity;
  if (age > CENSUS_RECALL_MAX_AGE_HOURS) {
    return {
      name, status: 'warn',
      message: `Recall last measured ${formatAge(age)} ago (weekly cron, >${CENSUS_RECALL_MAX_AGE_HOURS / 24}d)`,
      hint: 'audit-census-recall.yml may be stale or disabled — the regression detector is blind while it is.',
    };
  }

  const latest = data.latest || {};
  const summary = Object.entries(latest.families || {})
    .map(([f, r]) => `${SEARCH_METHOD_LABELS[f] || f} found ${pctOf(r)}`)
    .join(', ');
  const scope = `across ${latest.shows ?? 0} recent opening(s); ${latest.truthUrls ?? 0} review pages any of our searches could find`;

  if (data.verdict === 'regressed') {
    const worst = (data.regressions || [])
      .map(r => `${SEARCH_METHOD_LABELS[r.arm] || r.arm} ${r.current === null ? 'stopped reporting' : `now finds ${pctOf(r.current)} vs ${pctOf(r.baseline)} recently`}`)
      .join('; ');
    return {
      name, status: 'warn',
      message: `Review coverage dropped — ${worst} (${scope}). New shows may be going live with published reviews missing.`,
      hint: 'Run `node scripts/audit-serp-census-recall.js --sample=10` and compare per-arm recall; a dead query slot or a provider outage is the usual cause.',
    };
  }
  if (data.verdict === 'blind' || data.verdict === 'insufficient-sample') {
    return {
      name, status: 'warn',
      message: `Review coverage not judgeable yet: ${data.reason || data.verdict}`,
      hint: data.verdict === 'insufficient-sample'
        ? 'This run measured too few shows or reviews to judge; the next weekly run re-judges on a fresh sample.'
        : 'Needs more weekly runs on record before a drop can be detected.',
    };
  }
  return {
    name, status: 'pass',
    message: `${summary || 'no search methods recorded'} — ${scope}; ${data.comparedArms ?? 0} search method(s) steady vs recent weeks (${formatAge(age)} ago)`,
  };
}

const COVERAGE_PROBE_CHECK = 'Coverage: adversarial probe';
/** Weekly cron; past this the probe has missed a run outright. */
const COVERAGE_PROBE_MAX_AGE_HOURS = 24 * 9;

/**
 * Render the Coverage Verdict S5 adversarial-probe verdict as a digest check
 * (task #903, the FINAL sprint).
 *
 * A found gap is a warn, not an error: it is a real, current finding that
 * needs a human to ingest or explain the review, but the pipeline is not
 * broken by it existing (it exists precisely because the pipeline has not
 * caught up yet). An error is reserved for the DETECTOR going quiet — no
 * data, or stale data — which means the weekly cadence has stopped and this
 * check can no longer see anything at all.
 *
 * Pure so it can be tested against fixtures without a live audit file.
 *
 * @param {object|null} data parsed data/audit/coverage-adversarial-probe-status.json
 * @param {object} [opts] {nowMs} for deterministic age in tests
 */
function coverageProbeResult(data, opts = {}) {
  const name = COVERAGE_PROBE_CHECK;
  if (!data) {
    return { name, status: 'warn', message: 'No adversarial-probe data (coverage-adversarial-probe.yml may not have run yet)', hint: 'Run `gh workflow run "Coverage Adversarial Probe"`' };
  }
  const now = opts.nowMs === undefined ? Date.now() : opts.nowMs;
  const ts = data.generatedAt ? Date.parse(data.generatedAt) : NaN;
  const age = Number.isFinite(ts) ? (now - ts) / 3600000 : Infinity;
  if (age > COVERAGE_PROBE_MAX_AGE_HOURS) {
    return {
      name, status: 'warn',
      message: `Probe last ran ${formatAge(age)} ago (weekly cron, >${COVERAGE_PROBE_MAX_AGE_HOURS / 24}d)`,
      hint: 'coverage-adversarial-probe.yml may be stale or disabled — the probe is blind while it is.',
    };
  }

  if (data.verdict === 'gaps-found') {
    const shows = (data.gapShows || []).join(', ') || 'unnamed show(s)';
    return {
      name, status: 'warn',
      message: `The naive search found ${data.gapCount ?? '?'} review URL(s) this pipeline hasn't discovered yet: ${shows}`,
      hint: 'See data/audit/coverage-adversarial-probe.json for the URLs, then ingest or explain each one.',
    };
  }
  if (data.verdict === 'inconclusive') {
    return {
      name, status: 'warn',
      message: `This week's sample had nothing measurable (settling/undated shows, or a SERP outage) — no evidence either way`,
      hint: 'Not a failure — the next weekly run should have a measurable sample.',
    };
  }
  const acceptance = data.acceptance || {};
  const acceptedNote = acceptance.accepted ? ' — 2 consecutive clean weeks, acceptance bar cleared' : '';
  return {
    name, status: 'pass',
    message: `Every discovered review URL was live or named-excluded (${formatAge(age)} ago)${acceptedNote}`,
  };
}

// The owner reads this line in a morning email among ~30 others. "scoped",
// "naive", "onDisk", "arm" and "recall 0.28" are internal vocabulary; a
// fresh-eyes review (2026-08-02) confirmed every one of them stops a
// non-engineer reader, and that a bare ratio invites a wrong conclusion
// because nothing says whether 0.28 is normal.
const SEARCH_METHOD_LABELS = {
  scoped: 'our targeted searches',
  naive: 'a plain Google search',
  onDisk: 'reviews already collected',
};
/** 0.283 -> "28%". The percentage is what a reader actually parses. */
function pctOf(r) {
  return typeof r === 'number' && Number.isFinite(r) ? `${Math.round(r * 100)}%` : 'n/a';
}

// --- Outlet health signals (card #641) ---
// standingCoverage drift (card #627), coverageExpectation drift (card #640), and
// outlet-heartbeat red flags (card #582/#299) were all computed correctly but
// dead-ended in an unread GH Actions step summary of a weekly unattended cron —
// nobody opens that run to scroll it. Same fix as "Quality: corpus drift" above:
// give each signal a digest row so it's visible without opening Actions.
function loadOutletHealthCoreData() {
  const showsFile = path.join(DATA_DIR, 'shows.json');
  const reviewsFile = path.join(DATA_DIR, 'reviews.json');
  const registryFile = path.join(DATA_DIR, 'outlet-registry.json');
  if (!fs.existsSync(showsFile) || !fs.existsSync(reviewsFile) || !fs.existsSync(registryFile)) {
    return null;
  }
  // Called directly in checkOutletHealth() (not through runCheck), so a
  // concurrent writer leaving one of these files mid-write/truncated must not
  // throw here — that would escape to main().catch() and kill the whole
  // digest, sending no email at all (ship-check finding, 2026-07-30).
  try {
    return {
      shows: readJSON(showsFile).shows,
      reviews: readJSON(reviewsFile).reviews,
      outlets: readJSON(registryFile).outlets,
    };
  } catch {
    return null;
  }
}

function checkOutletHealth() {
  const core = loadOutletHealthCoreData();

  return [
    // standingCoverage is DERIVED from measured Broadway coverage (card #627) —
    // recomputed live off current core data every run, same as the source
    // audit-standing-coverage.js script does, so no separate snapshot file or
    // staleness window is needed.
    runCheck('Quality: standingCoverage drift', () => {
      if (!core) {
        return { name: 'Quality: standingCoverage drift', status: 'pass', message: 'Skipped (core data not checked out)' };
      }
      const { evaluateStandingCoverage } = require('./audit-standing-coverage');
      const result = evaluateStandingCoverage(core.shows, core.reviews, core.outlets, Date.now());
      const drifted = result.promote.length + result.demote.length;
      if (drifted === 0) {
        return { name: 'Quality: standingCoverage drift', status: 'pass', message: 'No standingCoverage drift' };
      }
      const parts = [];
      if (result.promote.length) parts.push(`promote: ${result.promote.join(', ')}`);
      if (result.demote.length) parts.push(`demote: ${result.demote.join(', ')}`);
      return {
        name: 'Quality: standingCoverage drift',
        status: 'warn',
        message: `${drifted} outlet(s) drifted from outlet-registry.json standingCoverage flags (${parts.join('; ')})`,
        hint: 'Run `node scripts/audit-standing-coverage.js` and update outlet-registry.json standingCoverage flags.',
      };
    }),

    // coverageExpectation ("this outlet does NOT review theatre") claims decay
    // on their own DECAY_DAYS window (card #640) — same live recompute, no
    // snapshot file.
    runCheck('Quality: coverageExpectation drift', () => {
      if (!core) {
        return { name: 'Quality: coverageExpectation drift', status: 'pass', message: 'Skipped (core data not checked out)' };
      }
      const { evaluateCoverageExpectationDrift } = require('./audit-standing-coverage');
      const result = evaluateCoverageExpectationDrift(core.shows, core.reviews, core.outlets, Date.now());
      if (result.needsReprobe.length === 0) {
        return { name: 'Quality: coverageExpectation drift', status: 'pass', message: 'No coverageExpectation re-probes needed' };
      }
      return {
        name: 'Quality: coverageExpectation drift',
        status: 'warn',
        message: `${result.needsReprobe.length} outlet(s) need coverageExpectation re-decision: ${result.needsReprobe.join(', ')}`,
        hint: 'Run `node scripts/audit-standing-coverage.js --coverage-expectation` and update outlet-registry.json coverageExpectation/coverageExpectationDecidedAt.',
      };
    }),

    // outlet-heartbeat DOES have a persisted weekly snapshot (committed by
    // audit-critic-coverage.yml) — read it and check staleness, same posture
    // as "Quality: corpus drift". Actionability is gated on the SAME
    // redStreak>=2 threshold outlet-heartbeat-state.js already uses for its
    // Discord ACTION alert (data/audit/outlet-heartbeat-state.json,
    // updateHeartbeatState()) rather than raw current-run status==='red' —
    // a single red week is deliberately treated as noise there (long-silent
    // outlets like newsday sit red every week), so re-warning on every row
    // that's merely red-this-week would just recreate the "unread signal"
    // problem this card exists to fix (ship-check finding, 2026-07-30).
    // 29 outlet×market rows are already redStreak=1 as of 2026-07-30 and will
    // likely all cross the threshold together on the next Monday cron — some
    // (newsday::broadway, backstage::broadway) have been silent for YEARS.
    // Same "known backlog vs genuinely new" split as "Quality: star-vs-score
    // mismatch" above: alert only on rows NOT in the committed baseline
    // (data/audit/outlet-heartbeat-baseline.json, card #643).
    // Logic extracted to lib/outlet-heartbeat-monitor-core.js (BRO-2521) so
    // it's also runnable standalone via scripts/outlet-heartbeat-monitor.js
    // without duplicating the staleness/actionable-rows logic here.
    runCheck('Quality: outlet-heartbeat red flags', () => {
      const { evaluateOutletHeartbeat } = require('./lib/outlet-heartbeat-monitor-core');
      return evaluateOutletHeartbeat({ auditDir: AUDIT_DIR });
    }),

    // BRO-6352: outlet-listing-poller.yml writes the per-feed newest-item
    // snapshot daily; a configured rss/sitemap feed that froze while the
    // outlet keeps publishing is listed in its stale[].
    runCheck('Quality: outlet feed staleness', () => evaluateOutletFeedHealth()),
  ];
}

function evaluateOutletFeedHealth({ filePath = path.join(__dirname, '..', require('./lib/outlet-listing-helpers').OUTLET_FEED_HEALTH_REL), now = Date.now() } = {}) {
  const name = 'Quality: outlet feed staleness';
  if (!fs.existsSync(filePath)) {
    return { name, status: 'pass', message: 'Skipped (no feed-health snapshot yet; outlet-listing-poller.yml writes it daily)' };
  }
  const data = readJSON(filePath);
  const ageH = (now - Date.parse(data.generatedAt)) / 3600000;
  if (!(ageH <= 72)) {
    return { name, status: 'warn', message: `Feed-health snapshot is ${isNaN(ageH) ? 'undated' : `${Math.round(ageH)}h old`} (outlet-listing-poller runs daily)`, hint: 'Check the Outlet Listing Poller workflow runs and its commit step.' };
  }
  const stale = Array.isArray(data.stale) ? data.stale : [];
  const failing = Array.isArray(data.failing) ? data.failing : [];
  const total = Object.keys(data.outlets || {}).length;
  if (stale.length === 0 && failing.length === 0) return { name, status: 'pass', message: `${total} feed(s) checked, none stale or failing` };
  const outlets = data.outlets || {};
  const parts = [];
  if (stale.length) parts.push(`${stale.length} stale: ${stale.map(id => `${id} (feed newest ${(outlets[id] || {}).newestFiltered || 'none'}, review ${(outlets[id] || {}).latestReviewDate || '?'})`).join(', ')}`);
  if (failing.length) parts.push(`${failing.length} failing: ${failing.map(id => `${id} (${String((outlets[id] || {}).error || '').slice(0, 60)})`).join(', ')}`);
  return {
    name,
    status: 'warn',
    message: `Of ${total} feed(s), outlet still publishing but feed ${parts.join('; ')}`,
    hint: 'Probe a replacement feed with `node scripts/probe-outlet-feeds.js --outlets <id>` and update OUTLET_STRATEGY_CONFIG in scripts/outlet-listing-poller.js.',
  };
}

// --- Commercial model drift (S2-T3) ---
// Surfaces the rolling history written by audit-commercial-data.js
// --write-history (S2-T1, called weekly from commercial-weekly.yml — S2-T2):
// modelDesignationFlag contradiction count and ai-estimated-tier count,
// week over week. Same posture as "Quality: corpus drift" above — drift
// itself is a `this-week` warn (visible in the digest, not paging); a
// missing/unreadable history file is also a warn (informational monitor,
// not a ship-blocker) since a first-ever week or a not-yet-run cron
// legitimately has no file yet.
// BRO-6336: the pending-review queue must stay small and young. Pure thresholds live in lib/pending-health.js.
const COMMERCIAL_HELD_ROWS_CHECK = 'Commercial: rows held for a person';
function checkCommercialPendingQueue({ pendingFile = path.join(DATA_DIR, 'commercial-pending-review.json'), now = Date.now() } = {}) {
  return [
    runCheck('Commercial pending-review queue', () => {
      const name = 'Commercial pending-review queue';
      const { pendingQueueHealth } = require('./lib/pending-health');
      if (!fs.existsSync(pendingFile)) return { name, status: 'pass', message: 'No pending file: nothing waits.' };
      let pending;
      try { pending = readJSON(pendingFile); } catch (err) { return { name, status: 'error', message: `Failed to parse commercial-pending-review.json: ${err.message}` }; }
      const { ok, problems, stats } = pendingQueueHealth(pending, now);
      const { formatBacklogLine } = require('./lib/pending-review-backlog');
      return ok
        ? { name, status: 'pass', message: formatBacklogLine(stats) }
        : { name, status: 'error', message: `${formatBacklogLine(stats)} Over the limit: ${problems.join('; ')}.`, hint: 'Run the Commercial Pending Review workflow; entries no cited page confirms move to the rejected log.' };
    }),
    // BRO-6471: rows held for a person go to a worker through this row's card, never to a parked owner card.
    runCheck(COMMERCIAL_HELD_ROWS_CHECK, () => {
      const name = COMMERCIAL_HELD_ROWS_CHECK;
      const { heldRowsHealth, MAX_HELD_AGE_DAYS } = require('./lib/pending-health');
      if (!fs.existsSync(pendingFile)) return { name, status: 'pass', message: 'No pending file: nothing is held.' };
      let pending;
      try { pending = readJSON(pendingFile); } catch (err) { return { name, status: 'error', message: `Failed to parse commercial-pending-review.json: ${err.message}` }; }
      const { ok, held, overdue } = heldRowsHealth(pending, now);
      if (ok) return { name, status: 'pass', message: `${held.length} row(s) held for a person, none past ${MAX_HELD_AGE_DAYS} days.` };
      const list = overdue.slice(0, 20).map((h) => `${h.key} (${h.heldDays == null ? 'undated' : `${h.heldDays} days`}): ${h.needs}`).join('; ');
      return { name, status: 'warn', message: `${overdue.length} row(s) in data/commercial-pending-review.json held for a person past ${MAX_HELD_AGE_DAYS} days: ${list}${overdue.length > 20 ? '; and more' : ''}.` };
    }),
  ];
}

function checkCommercialModelDrift() {
  return [
    runCheck('Commercial model drift', () => {
      const historyFile = path.join(AUDIT_DIR, 'commercial-data-history.json');
      if (!fs.existsSync(historyFile)) {
        return {
          name: 'Commercial model drift',
          status: 'warn',
          message: 'No commercial-data-history.json (commercial-weekly.yml may not have run --write-history yet)',
          hint: 'Trigger commercial-weekly.yml or check S2-T1/S2-T2 wiring',
        };
      }
      let history;
      try {
        history = readJSON(historyFile);
      } catch (err) {
        return { name: 'Commercial model drift', status: 'error', message: `Failed to parse commercial-data-history.json: ${err.message}` };
      }
      const result = computeCommercialModelDriftStatus(history);
      return { name: 'Commercial model drift', status: result.status, message: result.message, hint: result.hint };
    }),
    // BRO-5004: stored model values a fresh run no longer reproduces. A writer
    // that changes a model input (cost, capital, closing date) after the model
    // ran leaves the stored range on the old input until the next run
    // (the-great-gatsby showed 83.1% against a fresh 64.4%). Read-only, ~2s;
    // the same scan as scripts/check-model-drift.js.
    runCheck('Commercial model: stored vs fresh run', () => {
      const name = 'Commercial model: stored vs fresh run';
      const { makeGrossesLookup } = require('./lib/grosses-lookup');
      const { scanModelDrift } = require('./lib/model-drift');
      const files = ['shows.json', 'commercial.json', 'grosses.json', 'grosses-history.json'];
      const missing = files.filter((f) => !fs.existsSync(path.join(DATA_DIR, f)));
      if (missing.length) return { name, status: 'warn', message: `Cannot check: missing ${missing.join(', ')}` };
      const today = new Date().toISOString().split('T')[0];
      const { flagged, summary } = scanModelDrift(
        Object.values(readJSON(path.join(DATA_DIR, 'shows.json')).shows),
        readJSON(path.join(DATA_DIR, 'commercial.json')).shows,
        makeGrossesLookup(readJSON(path.join(DATA_DIR, 'grosses.json')), readJSON(path.join(DATA_DIR, 'grosses-history.json'))),
        today,
      );
      if (!flagged.length) return { name, status: 'pass', message: `${summary.checked} records match a fresh run` };
      const top = flagged.slice(0, 5).map((f) => `${f.slug} [${f.kind}] ${f.detail}`).join('; ');
      return {
        name,
        status: 'warn',
        message: `${flagged.length} of ${summary.checked} records differ from a fresh run (${summary.sameDay} same-day, ${summary.drift} drift, ${summary.method} method): ${top}`,
        hint: 'Run node scripts/check-model-drift.js. The model re-runs daily (commercial-stale-closures.yml, 08:00 UTC, after this digest), so a row that persists a second day means that run failed or was skipped',
      };
    }),
    // BRO-5027: advisory fit of our weekly profit structure against
    // u/Boring_Waltz_9545's posted profit ranges, written each Monday by
    // scrape-waltz-costs.yml. Aggregates only; never 'error'.
    runCheck('Commercial model: Boring Waltz fit', () => {
      const name = 'Commercial model: Boring Waltz fit';
      let file = null;
      try { file = readJSON(path.join(AUDIT_DIR, 'waltz-model-fit.json')); } catch { /* missing or corrupt: warn below */ }
      const result = waltzFitCheckStatus(file);
      return { name, ...result, hint: result.status === 'pass' ? undefined : 'Stale or missing: check the Monday scrape-waltz-costs.yml run. Drift: a model change or a shift in his numbers; compare with node scripts/backtest-recoupment-ground-truth.js before changing anything' };
    }),
    // BRO-5073: every announced recoupment is a dated check of the model.
    // Running-show "% returned" bars stay off until >= 10 strong rows are
    // >= 80% inside for plays and musicals each; this re-runs the timing
    // backtest (about 1s, aggregates only) so the digest says when to revisit.
    runCheck('Commercial model: running-show bar revisit', () => {
      const name = 'Commercial model: running-show bar revisit';
      const out = execFileSync(process.execPath, [path.join(__dirname, 'backtest-recoupment-ground-truth.js'), '--timing', '--json', '--aggregate-only'], { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'ignore'] });
      let report = null;
      try { report = JSON.parse(out.slice(out.indexOf('{'))); } catch { /* unreadable: warn below */ }
      const result = revisitBarStatus(report);
      return { name, ...result, hint: result.status === 'pass' ? undefined : 'Run node scripts/backtest-recoupment-ground-truth.js --timing --displayable-only for the rows; the launch call is the owner\'s' };
    }),
  ];
}

// --- Category E: Cookie Expiration ---

const COOKIE_DIR = path.join(DATA_DIR, 'cookies');
const COOKIE_WARN_DAYS = 7;
const COOKIE_ERROR_DAYS = 2;
const CRITICAL_COOKIE_OUTLETS = new Set([
  'wsj', 'nytimes', 'newyorker', 'washpost', 'financialtimes', 'vulture', 'timeout'
]);

function checkCookieExpiration() {
  const results = [];
  // Cookies are managed on the Mac Studio (data/cookies/ is gitignored for security).
  // In CI the directory will always be missing — that's expected, not a problem.
  if (process.env.GITHUB_ACTIONS) {
    results.push({ name: 'Cookies: expiration', status: 'pass', message: 'Skipped in CI (cookies managed on Mac Studio)' });
    return results;
  }
  if (!fs.existsSync(COOKIE_DIR)) {
    results.push({ name: 'Cookies: expiration', status: 'warn', message: 'data/cookies/ not found', hint: 'Run: python3 scripts/extract-safari-cookies.py' });
    return results;
  }

  // Skip sidecar/meta files (e.g. _extracted-at.json) and quarantined files.
  const files = fs.readdirSync(COOKIE_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'));
  if (files.length === 0) {
    results.push({ name: 'Cookies: expiration', status: 'warn', message: 'No cookie files found' });
    return results;
  }

  const now = Date.now() / 1000;
  const details = [];

  for (const file of files) {
    const outlet = file.replace('.json', '');
    const isCritical = CRITICAL_COOKIE_OUTLETS.has(outlet);
    try {
      const cookies = JSON.parse(fs.readFileSync(path.join(COOKIE_DIR, file), 'utf8'));
      if (!Array.isArray(cookies) || cookies.length === 0) continue;

      const validCookies = cookies.filter(c => c.expires && c.expires > 0);
      if (validCookies.length === 0) continue;

      const latestExpiry = Math.max(...validCookies.map(c => c.expires));
      const daysLeft = (latestExpiry - now) / (60 * 60 * 24);

      if (daysLeft <= COOKIE_WARN_DAYS) {
        details.push({ outlet, daysLeft: Math.round(daysLeft * 10) / 10, isCritical });
      }
    } catch (e) {
      details.push({ outlet, daysLeft: -1, isCritical, error: e.message });
    }
  }

  if (details.length > 0) {
    const criticalIssues = details.filter(d => d.isCritical);
    const status = criticalIssues.some(d => d.daysLeft <= COOKIE_ERROR_DAYS) ? 'error'
      : criticalIssues.length > 0 ? 'warn'
      : details.some(d => d.daysLeft <= 0) ? 'warn'
      : 'pass';

    const expired = details.filter(d => d.daysLeft <= 0).length;
    const expiring = details.filter(d => d.daysLeft > 0).length;
    const summary = details
      .sort((a, b) => a.daysLeft - b.daysLeft)
      .slice(0, 5)
      .map(d => `${d.outlet}${d.isCritical ? '*' : ''}: ${d.daysLeft <= 0 ? 'EXPIRED' : d.daysLeft + 'd left'}`)
      .join(', ');

    // Include per-cookie countdown for the digest
    const cookieCountdowns = details.map(d => {
      const days = Math.round(d.daysLeft);
      if (days < 0) return `${d.outlet}: EXPIRED (${Math.abs(days)}d ago)`;
      if (days < 3) return `${d.outlet}: ${days}d left`;
      if (days < 7) return `${d.outlet}: ${days}d left`;
      return null;
    }).filter(Boolean);

    results.push({
      name: 'Cookies: expiration',
      status,
      message: `${expired} expired, ${expiring} expiring <${COOKIE_WARN_DAYS}d — ${summary}`,
      hint: 'Run: python3 scripts/extract-safari-cookies.py then gh secret set <NAME> < /tmp/<file>.txt',
      cookieCountdowns,
    });
  } else {
    results.push({
      name: 'Cookies: expiration',
      status: 'pass',
      message: `${files.length} cookie files, all valid >${COOKIE_WARN_DAYS}d`,
    });
  }

  return results;
}

// --- Category F: Core Web Vitals ---

function checkCWV() {
  return [
    runCheck('CWV: performance', () => {
      const cwvFile = path.join(AUDIT_DIR, 'cwv-results.json');
      if (!fs.existsSync(cwvFile)) {
        return { name: 'CWV: performance', status: 'warn', message: 'No CWV data (check-cwv-health may not have run)' };
      }
      const data = readJSON(cwvFile);
      const latest = data.latest;
      if (!latest || !latest.timestamp) {
        return { name: 'CWV: performance', status: 'warn', message: 'No latest CWV run found' };
      }
      const age = hoursAgo(latest.timestamp);
      if (age > 336) { // 14 days — weekly check, allow 2 weeks
        return { name: 'CWV: performance', status: 'warn', message: `Last CWV check ${formatAge(age)} ago (>14d)`, hint: 'Trigger check-cwv-health workflow manually' };
      }
      const alerts = [];
      const m = latest.mobile || {};
      const d = latest.desktop || {};
      // CI runners are ~30-50% slower than real devices; use relaxed thresholds
      // to avoid false alarms from CI variance (e.g. TBT 759ms on a 750 threshold)
      if (m.lcp > 6000) alerts.push(`Mobile LCP ${(m.lcp / 1000).toFixed(1)}s`);
      if (m.cls > 0.15) alerts.push(`Mobile CLS ${m.cls.toFixed(3)}`);
      if (m.tbt > 1000) alerts.push(`Mobile TBT ${m.tbt.toFixed(0)}ms`);
      if (d.lcp > 3000) alerts.push(`Desktop LCP ${(d.lcp / 1000).toFixed(1)}s`);
      if (d.cls > 0.1) alerts.push(`Desktop CLS ${d.cls.toFixed(3)}`);
      if (d.tbt > 400) alerts.push(`Desktop TBT ${d.tbt.toFixed(0)}ms`);

      if (alerts.length > 0) {
        return { name: 'CWV: performance', status: 'warn', message: `Threshold violations: ${alerts.join(', ')}`, hint: 'Check Lighthouse results in data/audit/cwv-results.json' };
      }
      return { name: 'CWV: performance', status: 'pass', message: `All metrics within thresholds (${formatAge(age)} ago)` };
    }),
  ];
}

// --- Category G: SEO Health ---

function checkSEO() {
  return [
    runCheck('SEO: health', () => {
      const seoFile = path.join(AUDIT_DIR, 'seo-health.json');
      if (!fs.existsSync(seoFile)) {
        return { name: 'SEO: health', status: 'warn', message: 'No SEO data (check-seo-health may not have run)' };
      }
      const data = readJSON(seoFile);
      const age = (data.timestamp || data.lastChecked) ? hoursAgo(data.timestamp || data.lastChecked) : Infinity;
      if (age > 336) { // 14 days
        return { name: 'SEO: health', status: 'warn', message: `Last SEO check ${formatAge(age)} ago (>14d)`, hint: 'Trigger check-seo-health workflow manually' };
      }
      // Check for anomalies flagged by the SEO health script.
      // Anomaly objects are { type, severity, message } — there is NO `metric`
      // field, so the alert MUST render `message` (or `type`), not `a.metric`,
      // or every SEO alert reads "N critical SEO anomalies: , " with blank
      // descriptions and is unactionable (the state this digest sat in).
      const describe = (a) => a.message || a.type || 'unknown';
      // BRO-477: lab-only (simulated-test) wobbles stay in seo-health.json but are not a daily row.
      const anomalies = require('./lib/seo-lab-noise').actionableSeoAnomalies(data.anomalies);
      if (anomalies.length > 0) {
        const critical = anomalies.filter(a => a.severity === 'error');
        if (critical.length > 0) {
          return { name: 'SEO: health', status: 'error', message: `${critical.length} critical SEO anomalies: ${critical.map(describe).join('; ')}`, hint: 'Check data/audit/seo-health.json for details' };
        }
        return { name: 'SEO: health', status: 'warn', message: `${anomalies.length} SEO warning(s): ${anomalies.map(describe).join('; ')}`, hint: 'Check data/audit/seo-health.json for details' };
      }
      // Check index coverage — only warn if <50% (sample is 50 URLs from 700+ pages,
      // skewed toward historical shows Google deprioritizes)
      if (data.indexCoverage) {
        const { indexed, total } = data.indexCoverage;
        if (total > 0 && indexed / total < 0.5) {
          return { name: 'SEO: health', status: 'warn', message: `${((indexed / total) * 100).toFixed(0)}% indexed (${indexed}/${total})` };
        }
      }
      return { name: 'SEO: health', status: 'pass', message: `Healthy (${formatAge(age)} ago)` };
    }),
  ];
}

// --- Category H: Cron Health (via GitHub API) ---

function checkCronHealth() {
  // Uses `gh` CLI to check last run of critical workflows
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
    return [{ name: 'Cron: health', status: 'warn', message: 'Skipped — no GH_TOKEN available (local run)' }];
  }

  // User-facing data refresh workflows were added 2026-04-14 so that their
  // most-recent-run failures surface in the daily digest with fix-now
  // urgency (playbook entry: `^Cron failed:`). Owner reads the email, not
  // the Discord channel the workflow's native notify-failure targets.
  // The list itself lives in scripts/lib/health-digest-crons.js (BRO-2818) so the coverage
  // audit can require() it and fail on drift against check-cron-health.yml.
  const CRITICAL_CRONS = require('./lib/health-digest-crons').DIGEST_CRONS;

  return CRITICAL_CRONS.map(({ workflow, maxHours, name, livenessOnly }) =>
    runCheck(`Cron: ${name}`, () => {
      try {
        // limit=5, not 1: on high-churn workflows the newest run is routinely a
        // cancel-cascade casualty (a data commit lands, GitHub cancels the
        // in-flight run in favour of the newer one). Reading only the head run
        // reported "Cron failed: cancelled" while the cron was in fact doing its
        // job on the very next run — see task #80, ~75% of Test Suite runs on main
        // cancel this way. Same single API call, five records.
        // Cached (shared across every concurrently-dispatched session on this
        // Mac, see scripts/lib/gh-api-cache.js): 15 entries in this array is
        // 15 gh calls PER health-check.js run, and this runs on every
        // /ship-check + /wrap-up across ~dozens of dispatches/day.
        const result = cachedShell(
          runCacheKey(`cron:${workflow}`),
          ghRunsQuery(workflow, { limit: 5 })
        );
        const runs = sortRunsNewestFirst(result ? JSON.parse(result) : []);
        if (!runs.length) {
          return { name: `Cron: ${name}`, status: 'warn', message: 'No runs found' };
        }
        const run = runs[0];
        const age = hoursAgo(run.createdAt);
        if (age > maxHours) {
          return { name: `Cron: ${name}`, status: 'error', message: `Last run ${formatAge(age)} ago (max ${maxHours}h). Conclusion: ${run.conclusion || 'still running'}`, hint: 'Check Actions tab — workflow may be disabled' };
        }
        if (livenessOnly && run.conclusion) {
          // Watchdog-style cron that fails by design when it pages: ran inside the window = alive.
          return { name: `Cron: ${name}`, status: 'pass', message: `${formatAge(age)} ago, ran (${run.conclusion}; liveness-only check)` };
        }
        if (run.conclusion === 'success') {
          return { name: `Cron: ${name}`, status: 'pass', message: `${formatAge(age)} ago, success` };
        }
        if (!run.conclusion) {
          // Still running/queued — limit=1 with no status filter can return an
          // in-flight run. Not evidence of a problem, so stays at baseline
          // urgency rather than routing to the fix-now `Cron failed:` name.
          return { name: `Cron: ${name}`, status: 'warn', message: `Last run still running (started ${formatAge(age)} ago)` };
        }
        // The head run is inconclusive. Before calling that a failure, check
        // whether a RECENT run actually succeeded: a cancelled head run with a
        // green run still inside the freshness window means the cron is working
        // and the newest attempt was just superseded. That is TRUE STATE, not an
        // unfixed failure, and reporting it as one produced permanent digest
        // warnings for Rebuild Reviews and Test Suite that no fix could clear.
        const recentSuccess = runs.find(r => r.conclusion === 'success' && hoursAgo(r.createdAt) <= maxHours);
        if (recentSuccess) {
          return {
            name: `Cron: ${name}`,
            status: 'pass',
            message: `${formatAge(hoursAgo(recentSuccess.createdAt))} ago, success (newest run ${run.conclusion} — superseded, not a failure)`,
          };
        }
        // No successful run inside the window: failure / cancelled / skipped /
        // timed_out / action_required / neutral / stale all mean the cron has not
        // demonstrably done its job. Emit under a distinct name so the playbook
        // routes to fix-now urgency (prominent in digest), separate from the
        // baseline `Cron: X` staleness checks which stay at low urgency.
        // Previously only 'failure' routed here — cancelled/timed_out runs
        // silently read as 'pass' (ship-check adversarial finding on #367
        // surfaced the same bug in checkSecretsHealth(); same fix applied here).
        return { name: `Cron failed: ${name}`, status: 'warn', message: `Last run inconclusive: ${run.conclusion} (${formatAge(age)} ago), no success in ${maxHours}h` };
      } catch (err) {
        return { name: `Cron: ${name}`, status: 'warn', message: `gh CLI failed: ${err.message.substring(0, 80)}` };
      }
    })
  );
}

/**
 * BRO-3492 default liveness sweep: every scheduled workflow that neither
 * check-cron-health.yml (CRITICAL_CRONS) nor checkCronHealth() above watches.
 * Before this, ~130 exempt crons could stop firing (disabled, broken YAML,
 * startup_failure) and nothing noticed, because notify-failure only fires on a
 * run that started. One aggregated row so a quiet day adds no digest noise.
 * CI only: ~130 API calls, too many for every local /ship-check.
 */
function checkExemptCronLiveness() {
  const NAME = 'Cron: exempt-cron liveness';
  if (!process.env.GITHUB_ACTIONS || (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN)) {
    return [{ name: NAME, status: 'pass', message: 'Skipped outside CI (runs in the daily digest)' }];
  }
  if (hasLowHeadroom()) {
    return [{ name: NAME, status: 'warn', message: 'Skipped: GitHub API headroom low' }];
  }
  return [runCheck(NAME, () => {
    const { isScheduledWorkflow, parseExemptEntries, classifyAlertPaths, extractCrons, livenessVerdict } = require('./lib/cron-coverage');
    const wfDir = path.join(__dirname, '..', '.github', 'workflows');
    const exemptFile = path.join(__dirname, '..', '.cron-health-exempt.txt');
    const paging = new Set([...fs.readFileSync(path.join(wfDir, 'check-cron-health.yml'), 'utf8')
      .matchAll(/"([a-z0-9-]+\.yml)\|\d+\|/g)].map(m => m[1]));
    const digest = require('./lib/health-digest-crons').DIGEST_CRONS.map(d => d.workflow);
    const yamls = new Map(readWorkflowFilesOrFailClosed(wfDir)
      .map(f => [f, fs.readFileSync(path.join(wfDir, f), 'utf8')]));
    const scheduled = [...yamls].filter(([, y]) => isScheduledWorkflow(y)).map(([f]) => f);
    const paths = classifyAlertPaths(scheduled, paging,
      digest, parseExemptEntries(fs.existsSync(exemptFile) ? fs.readFileSync(exemptFile, 'utf8') : ''));
    const stale = [], errors = [], disabled = [];
    let checked = 0;
    for (const [wf, p] of paths) {
      if (p !== 'liveness') continue;
      const crons = extractCrons(yamls.get(wf));
      try {
        const raw = cachedShell(runCacheKey(`liveness:${wf}`), ghRunsQuery(wf, { limit: 5, event: 'schedule' }));
        const runs = (raw ? JSON.parse(raw) : []).map(r => ({ conclusion: r.conclusion, created_at: r.createdAt }));
        // Zero scheduled runs: a new cron reads unknown until it has existed past its limit
        // (BRO-5675). One extra call, zero-run workflows only.
        // A failed lookup must not hide a never-fired cron: it counts as a lookup error.
        let createdAt = null;
        if (!runs.length) {
          createdAt = cachedShell(runCacheKey(`wfcreated:${wf}`),
            `gh api "repos/${GH_REPO_PLACEHOLDER}/actions/workflows/${wf}" --jq .created_at`);
        }
        const v = livenessVerdict({ crons, runs, createdAt });
        if (v.status === 'unknown') continue;
        checked++;
        if (v.status !== 'stale') continue;
        // A workflow someone switched off on purpose is not a dead cron: name it, don't warn.
        // One extra call, stale workflows only.
        // A failed state lookup must not hide a stale workflow: report it as stale.
        let state = null;
        try {
          state = cachedShell(runCacheKey(`wfstate:${wf}`),
            `gh api "repos/${GH_REPO_PLACEHOLDER}/actions/workflows/${wf}" --jq .state`);
        } catch { /* fall through to stale */ }
        if (state === 'disabled_manually') { disabled.push(wf); continue; }
        stale.push(`${wf} (${v.ageHours == null ? 'no scheduled start in last 5 runs' : `last start ${v.ageHours}h ago`}, limit ${v.limitHours}h${state && state !== 'active' ? `, ${state}` : ''})`);
      } catch (err) {
        errors.push(`${wf}: ${String(err.message).substring(0, 60)}`);
      }
    }
    const off = (disabled.length ? ` Disabled on purpose: ${disabled.join(', ')}.` : '')
      + (errors.length ? ` ${errors.length} lookup(s) failed: ${errors.slice(0, 3).join('; ')}.` : '');
    if (stale.length) {
      return { name: NAME, status: 'warn', message: `${stale.length} of ${checked} exempt scheduled workflow(s) stopped starting: ${stale.join('; ')}.${off}`,
        hint: 'Stopped, broken, or timing out every run (a timeout reads as cancelled, which notify-failure misses). Check the Actions tab.' };
    }
    if (errors.length > 5) return { name: NAME, status: 'warn', message: `${errors.length} lookups failed: ${errors.slice(0, 3).join('; ')}` };
    return { name: NAME, status: 'pass', message: `${checked - disabled.length} exempt scheduled workflow(s) started on cadence.${off}` };
  })];
}

/**
 * BRO-5962: scheduled workflows that fail on every run. CRITICAL_CRONS and the digest's
 * success-keyed rows only notice a job once it is stale past its window, and
 * repeatFailureResults only looks at 24h, so a weekly job red for months stayed silent
 * (check-seo-health.yml: 9 Sundays). One aggregated row for every non-paged scheduled
 * workflow whose last 3 finished scheduled runs all failed. Reuses the liveness sweep's
 * cached run lookups. CI only. Advisory (warn, not paged). A job that times out every
 * run reads as cancelled and forms no streak here; liveness catches it once it goes stale.
 */
function checkScheduledFailureStreak() {
  const NAME = 'Cron: failing every scheduled run';
  if (!process.env.GITHUB_ACTIONS || (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN)) {
    return [{ name: NAME, status: 'pass', message: 'Skipped outside CI (runs in the daily digest)' }];
  }
  if (hasLowHeadroom()) {
    return [{ name: NAME, status: 'warn', message: 'Skipped: GitHub API headroom low' }];
  }
  return [runCheck(NAME, () => {
    const { isScheduledWorkflow, parseExemptEntries, classifyAlertPaths, consecutiveFailureVerdict } = require('./lib/cron-coverage');
    const wfDir = path.join(__dirname, '..', '.github', 'workflows');
    const exemptFile = path.join(__dirname, '..', '.cron-health-exempt.txt');
    const paging = new Set([...fs.readFileSync(path.join(wfDir, 'check-cron-health.yml'), 'utf8')
      .matchAll(/"([a-z0-9-]+\.yml)\|\d+\|/g)].map(m => m[1]));
    const digest = require('./lib/health-digest-crons').DIGEST_CRONS.map(d => d.workflow);
    const scheduled = readWorkflowFilesOrFailClosed(wfDir)
      .filter(f => isScheduledWorkflow(fs.readFileSync(path.join(wfDir, f), 'utf8')));
    const paths = classifyAlertPaths(scheduled, paging, digest,
      parseExemptEntries(fs.existsSync(exemptFile) ? fs.readFileSync(exemptFile, 'utf8') : ''));
    const failing = [], errors = [];
    let checked = 0;
    for (const [wf, p] of paths) {
      // 'none' (liveness opt-out) still counts: a red job is not a quiet one.
      // 'digest' workflows already surface a red run as `Cron failed:` (fix-now).
      if (p === 'paged' || p === 'digest') continue;
      try {
        const raw = cachedShell(runCacheKey(`liveness:${wf}`), ghRunsQuery(wf, { limit: 5, event: 'schedule' }));
        const v = consecutiveFailureVerdict(raw ? JSON.parse(raw) : []);
        checked++;
        if (v.failing) failing.push(`${wf} (${v.streak}+ in a row, last ${v.lastFailureAt ? v.lastFailureAt.slice(0, 10) : '?'})`);
      } catch (err) {
        errors.push(`${wf}: ${String(err.message).substring(0, 60)}`);
      }
    }
    const lookups = errors.length ? ` ${errors.length} lookup(s) failed: ${errors.slice(0, 3).join('; ')}.` : '';
    if (failing.length) {
      return { name: NAME, status: 'warn', message: `${failing.length} of ${checked} scheduled workflow(s) failed their last 3 scheduled runs: ${failing.slice(0, 10).join('; ')}${failing.length > 10 ? `; +${failing.length - 10} more` : ''}.${lookups}`,
        hint: 'Fix the root cause, or remove its schedule and say why in the workflow header. A job that is red on every run is dead, not flaky.' };
    }
    if (errors.length > 5) return { name: NAME, status: 'warn', message: `${errors.length} lookups failed: ${errors.slice(0, 3).join('; ')}` };
    return { name: NAME, status: 'pass', message: `${checked} scheduled workflow(s) checked, none red on every run.${lookups}` };
  })];
}

// --- Category I: Secrets Health ---

function checkSecretsHealth() {
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
    return [{ name: 'Secrets: health', status: 'warn', message: 'Skipped — no GH_TOKEN available (local run)' }];
  }

  return [
    runCheck('Secrets: health', () => {
      try {
        // limit=5 for the same reason as checkCriticalCrons(): a cancelled head
        // run with a green run still inside the window is a supersession, not a
        // failure. #367 noted the two checks share this logic and must move
        // together — they drifted again, so keep them in step.
        const result = cachedShell(
          runCacheKey('cron:check-secrets-health.yml'),
          ghRunsQuery('check-secrets-health.yml', { limit: 5 })
        );
        const runs = sortRunsNewestFirst(result ? JSON.parse(result) : []);
        if (!runs.length) {
          return { name: 'Secrets: health', status: 'warn', message: 'No secrets check runs found' };
        }
        const run = runs[0];
        const age = hoursAgo(run.createdAt);
        if (age > 336) { // 14 days — weekly check
          return { name: 'Secrets: health', status: 'warn', message: `Last check ${formatAge(age)} ago (>14d)`, hint: 'Trigger check-secrets-health workflow manually' };
        }
        if (run.conclusion === 'success') {
          return { name: 'Secrets: health', status: 'pass', message: `Last check passed (${formatAge(age)} ago)` };
        }
        if (run.conclusion === 'failure') {
          return { name: 'Secrets: health', status: 'error', message: `Last check FAILED (${formatAge(age)} ago)`, hint: 'Check check-secrets-health workflow logs' };
        }
        if (!run.conclusion) {
          // Still running/queued — limit=1 with no status filter can return an
          // in-flight run (conclusion is null until it completes). Not a pass:
          // a stuck run would otherwise silently mask its eventual result.
          return { name: 'Secrets: health', status: 'warn', message: `Last check still running (started ${formatAge(age)} ago)`, hint: 'Check check-secrets-health workflow run status' };
        }
        // Head run inconclusive: a green run still inside the 14d window means the
        // check did verify the secrets and the newest attempt was superseded.
        const recentPass = runs.find(r => r.conclusion === 'success' && hoursAgo(r.createdAt) <= 336);
        if (recentPass) {
          return { name: 'Secrets: health', status: 'pass', message: `Last check passed (${formatAge(hoursAgo(recentPass.createdAt))} ago; newest run ${run.conclusion} — superseded, not a failure)` };
        }
        // cancelled / skipped / timed_out / action_required / neutral / stale with no
        // pass inside the window — inconclusive, not a verified pass (ship-check
        // adversarial finding, #367).
        return { name: 'Secrets: health', status: 'warn', message: `Last check inconclusive: ${run.conclusion} (${formatAge(age)} ago), no pass in 14d`, hint: 'Check check-secrets-health workflow logs' };
      } catch (err) {
        return { name: 'Secrets: health', status: 'warn', message: `gh CLI failed: ${err.message.substring(0, 80)}` };
      }
    }),
  ];
}

// --- Category I3: Alert Router Deadman ---
//
// Independent detector for the router-silently-broken failure class
// (2026-07-24 npm-ci postmortem, Notion card #374: notion-brain.js crashed on
// a missing @notionhq/client, and every disposition='auto' dispatch failed
// silently for days because the ledger never records failed attempts — only
// successes — so nothing looked wrong to anything reading the ledger alone).
//
// Reads the trailing-7-day dispatch ATTEMPT log (readDispatchAttempts —
// scripts/lib/owner-alert-router.js records every disposition='auto' call,
// success AND failure) and flags when attempts happened but NONE succeeded.
// This does not depend on the ledger, and does not depend on the E2E canary
// (scripts/e2e-canary-alert-chain.js) ever having run — it fires even if the
// canary itself is broken or was skipped that day.
//
// isCI gates the self-page (added after a local run of the sibling canary
// script paged the owner at midnight, 2026-07-24 — this check has the exact
// same live-side-effect shape and runs unconditionally as part of building
// `allResults`, BEFORE main()'s own `if (!isCI) return` early-exit, so
// without this guard a local `node scripts/health-check.js` with a failed
// attempts-log history would ALSO email the owner for real).
async function checkAlertRouterDeadman(isCI) {
  // readDispatchAttempts returns oldest→newest by ts, so the last element is
  // always the most recent attempt regardless of file/write order.
  const attempts = readDispatchAttempts({ days: 7 });
  if (attempts.length === 0) {
    return [{ name: 'Alert Router: dispatch deadman', status: 'pass', message: 'No auto-dispatch attempts in the trailing 7d (nothing to check)' }];
  }

  const succeeded = attempts.filter(a => a.ok).length;
  const mostRecent = attempts[attempts.length - 1];
  // Ship-check finding: gating on "any success in the 7d window" lets one
  // stale success mask an outage that started right after it — the exact
  // failure class this check exists to catch. Gate on the MOST RECENT
  // attempt instead: if it succeeded, the chain is healthy right now
  // regardless of history; if it failed, that's live broken state even if
  // older attempts this week succeeded.
  if (mostRecent.ok) {
    // "succeeded" here means the LAUNCH succeeded — not that the session did any
    // work. Saying otherwise is what let a fully dead fleet read 42/42 green for
    // 13 days (2026-08-10). Whether jobs actually fixed anything is the separate
    // "Autofix: jobs actually succeeding" row, which reads outcomes.
    return [{ name: 'Alert Router: dispatch deadman', status: 'pass', message: `${succeeded}/${attempts.length} auto-dispatch attempts LAUNCHED ok in the last 7d (launch only — see "Autofix: jobs actually succeeding" for whether they fixed anything)` }];
  }

  // Most recent attempt failed. Surface the most recent REAL error
  // verbatim — this exact spot is where the npm-ci incident got
  // misdiagnosed as a NOTION_API_KEY problem by a hand-written guess instead
  // of the logged error.
  const message = `Most recent auto-dispatch attempt failed (${succeeded}/${attempts.length} succeeded in the last 7d) — same failure class as the 2026-07-24 npm-ci incident. Last error: ${mostRecent.error || '(none captured)'}`;

  // How long has the CURRENT breakage actually been going on? This check fires
  // on "the most recent attempt failed" (see the ship-check comment above), NOT
  // on "7 days of failures" — but the alert title said "for 7 days"
  // unconditionally, so on 2026-08-31 it reported a 7-day outage for a breakage
  // ~12h old and sent triage looking through the wrong window.
  const { consecutiveFailures, streakHours, forHowLong } = summarizeFailureStreak(attempts);
  const pageOwner = deadmanShouldPage({ consecutiveFailures, streakHours });

  // Self-page via disposition='human' directly from here — that path calls
  // sendAlert() (Resend) and never shells out to linear-brain.js, so it
  // survives even though the exact thing we just detected as broken is that
  // shell-out. Don't rely on the generic humanAction dispatch loop below,
  // which routes through disposition='auto' (the same broken path).
  // isCI-gated: never page from a local/dev run (see function header comment).
  if (isCI) {
    try {
      // BRO-4141: a short streak is a blip that usually heals on the next
      // attempt — digest it under its own key so it never touches the page
      // key's cooldown; page only once deadmanShouldPage() says it persisted.
      await routeAlert({
        conditionKey: pageOwner ? 'alert-router:deadman' : 'alert-router:deadman-early',
        // conditionKey (not the title) is what the ledger dedups on, so making
        // this title dynamic does not re-page or break the existing cooldown.
        title: `Alert Router: auto-dispatch silently failing for ${forHowLong} (${consecutiveFailures} consecutive)`,
        description: message,
        severity: pageOwner ? 'critical' : 'warning',
        disposition: pageOwner ? 'human' : 'digest',
        cooldownHours: 24,
      });
    } catch (err) {
      console.error(`[Deadman] failed to send direct human alert: ${err.message}`);
    }
  } else {
    console.error('[Deadman] DEV RUN — suppressing the owner-facing disposition=human alert (no GITHUB_ACTIONS/CI env). In real CI this would page the owner.');
  }

  return [{
    name: 'Alert Router: dispatch deadman',
    status: 'error',
    message,
    hint: 'Check the linear-brain.js shell-out first (workflow env/dependency gap, e.g. missing npm ci) before assuming LINEAR_API_KEY — read the actual last error above, not a guess.',
  }];
}

// --- Codex runner liveness (BRO-5287) ---
// The unattended Codex card runner (scripts/codex/daily-runner.js) posts a run summary on
// BRO-4745 every 2 hours. It landed nothing for 19 hours on 2026-10-13 and nothing alarmed;
// several sessions then reported it fixed without anything watching whether it stayed fixed.
// Rules live in scripts/lib/codex-runner.js runnerHealth (unit-tested); this is the I/O.
async function checkCodexRunner() {
  const NAME = 'Codex runner: landing cards';
  if (!process.env.LINEAR_API_KEY) return [{ name: NAME, status: 'warn', message: 'Skipped: no LINEAR_API_KEY to read the runner summaries' }];
  try {
    const { listIssueComments } = require('./lib/linear-client.js');
    const comments = (await listIssueComments(['BRO-4745'])).get('BRO-4745') || [];
    const row = require('./lib/codex-runner.js').runnerHealth(comments, Date.now());
    return [{ name: NAME, ...row, ...(row.status !== 'pass' && { hint: 'Read the newest "## Codex runner" summaries on BRO-4745 and the run log in that firing\'s Board workers session (the lock body names it: node scripts/codex/daily-runner.js --lock-status).' }) }];
  } catch (err) {
    return [{ name: NAME, status: 'warn', message: `Could not read the runner summaries: ${err.message}` }];
  }
}

// --- Category I4: Main Red Streak (task #1748) ---
//
// On 2026-08-17, main's Test Suite failed continuously from 04:05 to ~15:40 —
// roughly eight hours across dozens of pushes by many sessions — and nothing
// alarmed. checkCronHealth()'s existing test.yml row only asks "has ANY run
// succeeded in the last 48h" — an 8h streak never crosses that window, so it
// stayed silent the whole time. This asks a different question: how long has
// it been since main was last green, and alarms well inside that window.
//
// Predicate lives in scripts/lib/main-red-streak.js (pure, fixture-tested);
// this function does the `gh` I/O only. Job/step detail (needed to tell a
// real failure from an infra-only "Set up job" flake) is fetched ONLY for
// runs that look red at the run-list level — bounded, so a long-healthy main
// costs one API call, and a real incident costs a handful, not one per run.
async function checkMainRedStreak(isCI) {
  const NAME = 'Main: red streak';
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
    return [{ name: NAME, status: 'warn', message: 'Skipped — no GH_TOKEN available (local run)' }];
  }

  const THRESHOLD_HOURS = 2;
  const RUN_LIMIT = 30; // "dozens of pushes" during the 2026-08-17 incident
  const MAX_JOB_DETAIL_CALLS = 10; // cap gh run view calls even on a very long streak

  try {
    const listResult = cachedShell(
      runCacheKey('main-red-streak:test.yml'),
      ghRunsQuery('test.yml', { limit: RUN_LIMIT, branch: 'main' })
    );
    const rawRuns = sortRunsNewestFirst(listResult ? JSON.parse(listResult) : []);
    if (!rawRuns.length) {
      return [{ name: NAME, status: 'warn', message: 'No Test Suite runs found on main' }];
    }

    // First pass with no job detail: find the contiguous non-success streak
    // from the newest run backward, so job-detail fetches are bounded to
    // runs that are actually candidates, not all RUN_LIMIT of them. A
    // still-running run (conclusion null) doesn't end the scan — a real red
    // run can sit behind it — but it also isn't a fetch candidate: classify()
    // treats null as neutral with zero job evidence needed.
    let candidateCount = 0;
    while (candidateCount < rawRuns.length && rawRuns[candidateCount].conclusion !== 'success') candidateCount++;

    const runs = rawRuns.map((r, idx) => ({
      headSha: r.headSha,
      createdAt: r.createdAt,
      conclusion: r.conclusion,
    }));

    if (candidateCount > 0 && !hasLowHeadroom()) {
      let fetched = 0;
      // OLDEST candidate first (code-review finding): the oldest run in the
      // streak becomes `firstRedSha` — the exact commit named in the alarm —
      // so it must not be the one MAX_JOB_DETAIL_CALLS leaves without
      // evidence on a streak longer than the cap. The newest runs matter
      // less individually; their raw conclusion already proves the streak
      // exists even without job detail.
      for (let idx = candidateCount - 1; idx >= 0 && fetched < MAX_JOB_DETAIL_CALLS; idx--) {
        // Still running — no job evidence to fetch yet. The falsy test is load-
        // bearing and must stay falsy: the REST endpoint (BRO-2767) reports
        // null here where `gh run list --json conclusion` reported ''. Both are
        // falsy, so this is correct for either source — but narrowing it to
        // `=== ''` or `=== null` would break one of them.
        if (!rawRuns[idx].conclusion) continue;
        fetched++;
        try {
          const jobsResult = cachedShell(
            `main-red-streak:jobs:${rawRuns[idx].databaseId}`,
            `gh run view ${rawRuns[idx].databaseId} --json jobs`
          );
          const parsed = jobsResult ? JSON.parse(jobsResult) : null;
          if (parsed?.jobs) runs[idx].jobs = parsed.jobs;
        } catch (err) {
          console.error(`[Main red streak] gh run view failed for ${rawRuns[idx].databaseId}: ${err.message}`);
        }
      }
    }

    const assessment = assessMainRedStreak(runs, Date.now(), THRESHOLD_HOURS);

    if (!assessment.alarm) {
      // redStreakHours can be null even with redRunCount > 0 (the anchor
      // run's createdAt failed to parse) — code-review finding: reporting
      // 'pass' with a garbled "undefinedh" message would silently hide a
      // real data-quality problem instead of surfacing it.
      if (assessment.redRunCount > 0 && assessment.redStreakHours === null) {
        return [{ name: NAME, status: 'warn', message: `${assessment.redRunCount} red run(s) but could not compute time since last green (unparseable createdAt) — check gh run list output` }];
      }
      const msg = assessment.redRunCount > 0
        ? `${assessment.redRunCount} red run(s), ${assessment.redStreakHours.toFixed(1)}h since last green — under the ${THRESHOLD_HOURS}h threshold`
        : 'Last run green';
      return [{ name: NAME, status: 'pass', message: msg }];
    }

    // Actionable, not just "main is red" — the alarm string already names
    // the failing job and the FIRST red commit (CLAUDE.md: alerts must be
    // ACTION-only). File through the alert router rather than a new email
    // path (task #1748's suggested approach).
    //
    // conditionKey is deliberately the SAME 'test-yml:main-streak' key
    // test.yml's own "Detect consecutive main test failures" step has always
    // used (.github/workflows/test.yml) — not a new one keyed on
    // firstRedSha — so test.yml's "Resolve alert — main test.yml green
    // again" step (which resolves this key on every green run) keeps
    // closing this one too. disposition:'human' (BRO-3865, changed from
    // 'auto'): test.yml's push-triggered dispatch now files a PER-SIGNATURE
    // 'auto' card per distinct failing job/step/test
    // (scripts/route-main-streak-signatures.js, conditionKey
    // 'test-yml:red:<job>:<hash>') instead of one shared 'auto' card under
    // THIS key — so this aggregate condition is no longer "diagnose one
    // failing test", it's "nobody's per-signature card is stemming a
    // long-running red trunk", the same severity class as the
    // 'test-yml:main-streak-escalation' human page below. 'test-yml:main-
    // streak' was REMOVED from scripts/lib/page-worthy-alerts.js's
    // allowlist 2026-09-23 (owner email-noise complaint), so this 'human'
    // disposition is downgraded to the digest by the router — a red trunk is
    // for the automated fixers, not an owner page. cooldownHours matches the escalation tier's 24h (NOT the old
    // 6h — under 'auto' this key only ever paged once, since
    // findLinearDuplicate's tracker dedupe made every later hit
    // action:'silent' with no email at all; under 'human' there is no such
    // tracker dedupe, only this cooldown, so 6h here would have turned a
    // condition that can stay open for weeks into an email every 6h —
    // caught in second-opinion review before this shipped).
    if (isCI) {
      try {
        await routeAlert({
          conditionKey: 'test-yml:main-streak',
          title: `Main test.yml red — no confirmed-green run in ${assessment.redStreakHours.toFixed(1)}h`,
          description: assessment.alarm,
          hint: `git log ${assessment.firstRedSha} — start from the first red commit, not the latest push.`,
          severity: 'error',
          disposition: 'human',
          cardAction: 'Fix',
          fields: [{ name: 'First red commit', value: assessment.firstRedSha || 'unknown' }],
          cooldownHours: 24,
        });
      } catch (err) {
        console.error(`[Main red streak] routeAlert failed: ${err.message}`);
      }
    }

    return [{ name: NAME, status: 'error', message: assessment.alarm }];
  } catch (err) {
    return [{ name: NAME, status: 'warn', message: `gh CLI failed: ${err.message.substring(0, 80)}` }];
  }
}

// --- Main: green rate (2026-09-20) ---
//
// Companion to checkMainRedStreak above. That row asks "how long has main
// been red RIGHT NOW" and alarms; this one asks "over the last 7 days, what
// fraction of completed push runs on main were green" — the measurement that
// ends the "main is fixed now" claims (~45 sessions have made one after a
// handful of green runs; the owner trusts none of them). The number, not a
// session, is the only thing allowed to say it.
//
// It shells out to scripts/ci-green-rate.js — the same CLI cards use as a
// safe-form acceptance command — so there is exactly ONE fetch, ONE set of
// guards (sample floor, cancel storm, truncated window, rerun collapse) and
// ONE verdict string, here and everywhere else. In CI it passes --record so
// the nightly reading lands in data/audit/ci-green-rate.jsonl (committed by
// data-health-check.yml's snapshot step) and the row can show "7d trend
// from Y%, day D of 14 at ≥80%". Exit 1 from the CLI is a legitimate FAIL
// reading, not an error; exit 2 (gh failure / no repo) is a warn row that
// says so. Never a second alert: the actionable alarm is the red-streak row.
function checkCiGreenRate(isCI, deps = {}) {
  const NAME = 'Main: green rate';
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
    return [{ name: NAME, status: 'warn', message: 'Skipped — no GH_TOKEN available (local run)' }];
  }
  if (hasLowHeadroom()) {
    return [{ name: NAME, status: 'warn', message: 'Skipped — low rate-limit headroom (up to 12 GETs for a 7d window: 3 reads x 4 pages)' }];
  }
  const exec = deps.exec || execFileSync;
  const { healthRow } = require('./lib/ci-green-rate.js');
  const args = [path.join(__dirname, 'ci-green-rate.js'), '--days', '7', '--json', ...(isCI ? ['--record'] : [])];
  let stdout = '';
  try {
    stdout = exec('node', args, { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    if (err && err.status === 1 && err.stdout) {
      stdout = String(err.stdout); // FAIL verdict — still a reading
    } else {
      const detail = String((err && (err.stderr || err.message)) || '').trim().split('\n')[0].slice(0, 120);
      return [{ name: NAME, status: 'warn', message: `ci-green-rate.js failed (exit ${err && err.status != null ? err.status : '?'}) — no reading: ${detail}` }];
    }
  }
  let result;
  try { result = JSON.parse(stdout); } catch {
    return [{ name: NAME, status: 'warn', message: `ci-green-rate.js printed unparseable output — no reading: ${stdout.trim().slice(0, 120)}` }];
  }
  return [healthRow(result, NAME)];
}

// --- Main: mid-setup cancels (BRO-2512) ---
//
// Empirical companion to the static concurrency audit (audit-workflow-concurrency.js):
// scripts/ci-health-check.sh samples the last 20 test.yml push runs on main and exits 1
// when more than 30% were cancelled before any job validated (the pre-2026-07-12
// per-sha-concurrency baseline was ~75%). Until this row nothing ran it on a schedule, so
// a reverted concurrency block would have gone unnoticed. Exit 1 is a legitimate reading
// (warn row WITH the numbers); exit 2 (gh failure / no runs) is a warn row saying "no
// reading", never a pass. Resolves flap-safe through the generic health-row resolver.
function checkCiMidSetupCancels(deps = {}) {
  const NAME = 'Main: mid-setup cancels';
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
    return [{ name: NAME, status: 'warn', message: 'Skipped — no GH_TOKEN available (local run)' }];
  }
  if (hasLowHeadroom()) {
    return [{ name: NAME, status: 'warn', message: 'Skipped — low rate-limit headroom (~21 gh calls for a 20-run sample)' }];
  }
  const exec = deps.exec || execFileSync;
  const script = path.join(__dirname, 'ci-health-check.sh');
  let stdout = '';
  let status = 0;
  let stderr = '';
  try {
    stdout = exec('bash', [script, '20', '30'], { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    status = err && err.status != null ? err.status : '?';
    stdout = String((err && err.stdout) || '');
    stderr = String((err && (err.stderr || err.message)) || '');
  }
  const summary = (stdout.match(/Mid-setup cancelled \(never validated\):\s+(\d+) \((\d+)%\)/) || []);
  const total = (stdout.match(/last (\d+) completed runs/) || [])[1];
  if (status === 0) {
    return [{ name: NAME, status: 'pass', message: `${summary[2] ?? '?'}% of the last ${total ?? '?'} test.yml main runs cancelled mid-setup (threshold 30%)` }];
  }
  if (status === 1) {
    return [{ name: NAME, status: 'warn', message: `${summary[2] ?? '?'}% (${summary[1] ?? '?'} of ${total ?? '?'}) of the last test.yml main runs were cancelled before validating, above the 30% threshold. Check test.yml's per-sha concurrency block and run: node scripts/audit-workflow-concurrency.js` }];
  }
  const detail = stderr.trim().split('\n')[0].slice(0, 120);
  return [{ name: NAME, status: 'warn', message: `ci-health-check.sh failed (exit ${status}) — no reading: ${detail}` }];
}

// --- Auto-fix effectiveness (2026-08-10 incident) ---
//
// The owner received a near-identical morning digest 13 days running. Cause: the
// local `claude` CLI was logged out, so every headless auto-fix job started,
// emitted zero bytes, and hit its own timeout — leaving cards `in_progress`
// forever and the same ~31 issues re-reporting each morning.
//
// "Alert Router: dispatch deadman" did NOT catch it: it counts dispatch ATTEMPTS,
// so it read `42/42 auto-dispatch attempts succeeded` while the true fix rate was
// zero. This row reads the OUTCOMES the ledger already records (card-pass /
// card-fail) and is the difference between noticing on day 2 and on day 13.
//
// BRO-6468: CI-skipped, same reason as checkAutofixThroughput (BRO-467). The
// ledger is git-tracked, but only the Mac appends to it and it reaches
// origin only when a sync recovery happens to push it, so CI's copy can lag
// by days. CI then judged a frozen file against a moving 7-day window: the
// last committed launches stayed in the window while their outcomes (written
// the next morning, never pushed) did not, and it reported "Auto-fix loop is
// DEAD: 3 job(s) launched, 0 reported back" on 2026-10-28 while the three
// jobs the digest launched the day before had all run and landed. The digest
// showed that row as "Automatic fixing looks stalled".
// LOCAL-FOLD(checkAutofixEffectiveness): CI-skipped; the live verdict is
// computed on the Mac by send-morning-digest.js localLoopDeadMessage().
function checkAutofixEffectiveness(isCI) {
  if (isCI) return [];
  const name = AUTOFIX_EFFECTIVENESS_CHECK_NAME;
  const file = path.join(__dirname, '..', 'data', 'audit', 'digest-autofix-ledger.jsonl');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      // WARN, never ERROR: missing input cannot establish loop failure.
      // ENOENT means this checkout is missing the ledger; restore the file or
      // read the dispatch host.
      return [{
        name,
        status: 'warn',
        unmeasurable: true,
        message: 'Auto-fix health is not measurable here: data/audit/digest-autofix-ledger.jsonl is absent. '
          + 'The ledger is git-tracked and written on the dispatch host; this checkout cannot judge the loop without it.',
        hint: 'Restore the tracked ledger in this checkout, or run this check on the dispatch host for current outcomes. Committed snapshots can lag live activity.',
      }];
    }
    // Fail loud: a check that cannot read its input must not report healthy —
    // that is the failure mode this whole row exists to end.
    return [{ name, status: 'warn', message: `Could not read the auto-fix ledger: ${err.message}` }];
  }

  const rows = [];
  // Exact-line dedupe (BRO-3868): this ledger is tracked and merge=union, so
  // a sync's union recovery can leave the SAME row twice — same rationale as
  // autofix-effectiveness.js's readLedgerRows dedupe.
  const seen = new Set();
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    try { rows.push(JSON.parse(t)); } catch { /* skip unparseable line */ }
  }

  // No dispatchCount option: launches now come from this ledger's own
  // `auto-dispatch` rows (see autofix-effectiveness.js header for why the
  // alert-router coupling was removed).
  const r = assessAutofixEffectiveness(rows);
  return [{
    name,
    status: r.status,
    message: r.message,
    ...(r.status === 'error' ? {
      // NOT `claude auth status` / a bare `claude -p`: the fleet does not use the
      // CLI's stored login. claude-cli.js injects ANTHROPIC_API_KEY /
      // CLAUDE_CODE_OAUTH_TOKEN from .env into every spawned job (resolveAuthEnv
      // + strippedEnv), because under launchd process.env carries only the
      // plist's block. A bare probe from an interactive shell therefore reports
      // "Not logged in" even while the fleet is healthy — 2026-08-11: that false
      // reading was reported to the owner as a total outage, twice.
      hint: 'Read the newest log in ~/Library/Logs/bsc-jobs/ — empty apart from a TIMEOUT marker means the job produced nothing. Then confirm .env still carries ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN (claude-cli.js forwards these; the CLI\'s own stored login is NOT what the fleet uses).',
    } : {}),
  }];
}

// --- Digest-autofix S6: daily canary + throughput (task #1225) ---
//
// checkAutofixEffectiveness above answers "of the jobs that reported back,
// how many succeeded" over a 7-day window. It cannot answer "did the pipeline
// dispatch anything AT ALL today" — the exact question that would have caught
// the 8/5-8/9 starvation (task #1184) on day 2 instead of day 5. These two
// rows close that gap: a live end-to-end canary (scripts/lib/autofix-canary.js)
// and a daily throughput rollup with an explicit zero-activity alarm. The
// canary and backlog-drain ledgers are gitignored/Mac-local; the digest
// ledger is git-tracked, but CI sees a potentially stale committed snapshot.
// ENOENT reads as `null` (never `[]`) so the pure functions can tell
// "absent here" from "present and empty", and both checks follow the same
// warn-never-error-never-silent-pass rule task #1221 exists to enforce.
function readJsonlLedgerOrNull(absPath) {
  if (!fs.existsSync(absPath)) return null;
  let raw;
  try { raw = fs.readFileSync(absPath, 'utf8'); } catch { return null; }
  const out = [];
  // Exact-line dedupe (BRO-3868): digest-autofix-ledger.jsonl is tracked and
  // merge=union, so a sync's union recovery can leave the SAME row twice,
  // and this function's callers (assessThroughputRow) have no dedupe of
  // their own. A no-op for this function's other callers, whose ledgers are
  // gitignored/untracked and never git-merged.
  const seen = new Set();
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    try { out.push(JSON.parse(t)); } catch { /* skip corrupt line */ }
  }
  return out;
}

// BRO-467 root cause: both rows below need data that is structurally,
// permanently unavailable to a GitHub-hosted CI runner, not just "absent
// this run" — autofix-canary-ledger.jsonl and backlog-drain-ledger.jsonl are
// gitignored/Mac-local (never checked out in CI, ever), and
// digest-autofix-ledger.jsonl, while tracked, only reaches origin
// OPPORTUNISTICALLY (scripts/lib/sync-audit-checkout.sh's own header: "the
// next time ANY worktree session runs merge-worktree-to-main.sh... an
// acceptable, self-limiting wait" — there is no scheduled pusher), so its
// committed content can lag live Mac state by an UNBOUNDED number of days.
// assessThroughputRow's zero-dispatch/zero-pass streaks
// (ZERO_DISPATCH_ERROR_DAYS=2, ZERO_PASS_ERROR_DAYS=3) assume the ledger
// reflects "today" — an assumption CI can never satisfy. Reproduced
// 2026-09-24: CI's committed snapshot (last digest-autofix-ledger.jsonl
// commit 5 days old, backlog-drain always null) reported "0 dispatches on
// each of the last 5 day(s)" while the SAME check run against live Mac data
// showed real dispatch activity on every one of those days. The row's own
// design (task #1221) refuses to ever report 'pass' while backlogLedger is
// null (partial blindness must never look healthy) — combined with CI's
// permanent blindness to that ledger, that means this row can NEVER read
// 'pass' from CI, only perpetual 'warn'/'error' regardless of true fleet
// health. planAutofix files a card for 'warn' rows too (not error-only), so
// left as-is this becomes an unfalsifiable, permanently-recurring false
// alarm every time nobody happens to merge-to-main for 2+ days — exactly
// what filed BRO-467. Both signals are only ever trustworthy computed live
// on the Mac (send-morning-digest.js's own read of these same files, with
// both ledgers real-time) — CI simply has no honest answer to give, so it
// gives none rather than a false one.
// LOCAL-FOLD(checkAutofixCanary): CI-skipped; the real row is folded into
// sections.health.errors by send-morning-digest.js (BRO-467 follow-up).
// Enforced by tests/unit/audit-health-check-audit.test.mjs (BRO-2199).
function checkAutofixCanary(isCI) {
  if (isCI) return [];
  const { assessCanaryRow } = require('./lib/autofix-canary.js');
  const dispatchLedger = require('./lib/dispatch-ledger.js');
  const canaryLedgerEntries = readJsonlLedgerOrNull(path.join(AUDIT_DIR, 'autofix-canary-ledger.jsonl'));
  let dispatchLedgerEntries = [];
  try { dispatchLedgerEntries = dispatchLedger.readEntries(); } catch { /* stage folding degrades to card-filed-only */ }
  return [assessCanaryRow({ canaryLedgerEntries, dispatchLedgerEntries })];
}

// BRO-5168: advisory (warn-only) tripwire that reads only CI-visible state:
// the tracked alert ledger plus Linear's open issues. Fires when a
// visitor-facing row has been red for 4+ days and nothing open tracks it,
// which is what the Mac-only throughput rows could not show from CI.
async function checkUntrackedPersistentRows() {
  try {
    return [await untrackedPersistentRowsResult({
      ledger: require('./lib/owner-alert-router.js').loadLedger(),
      listOpenIssues: () => require('./lib/linear-client.js').listOpenIssuesWithDescriptions(),
      getIssue: (id) => require('./lib/linear-client.js').getIssue(id),
    })];
  } catch (err) {
    // Advisory row: a failure here must never take down the other checks.
    return [{ name: UNTRACKED_ROWS_ROW_NAME, status: 'warn', message: `Unmeasurable: ${String(err.message || err).slice(0, 160)}` }];
  }
}

// LOCAL-FOLD(checkAutofixThroughput): CI-skipped; the real row is evaluated
// by send-morning-digest.js localLoopDeadMessage() (BRO-3321) on the Mac.
// Enforced by tests/unit/audit-health-check-audit.test.mjs (BRO-2199).
function checkAutofixThroughput(isCI) {
  if (isCI) return [];
  const { assessThroughputRow } = require('./lib/autofix-canary.js');
  const digestLedgerEntries = readJsonlLedgerOrNull(path.join(AUDIT_DIR, 'digest-autofix-ledger.jsonl'));
  const backlogLedgerEntries = readJsonlLedgerOrNull(path.join(AUDIT_DIR, 'backlog-drain-ledger.jsonl'));
  return [assessThroughputRow({ digestLedgerEntries, backlogLedgerEntries })];
}

// --- Digest content-invariant FAIL monitor (task #1648) ---
//
// Card #1641 upgraded scripts/send-morning-digest.js's content-invariant
// check from a WARN to `process.exitCode = 1` on violation, but nothing
// consumed that exit code — this reads the JSONL ledger the sender now
// writes on every FAIL (scripts/lib/digest-invariant-fail-monitor.js) so a
// future violation surfaces as a health.errors row instead of hiding behind
// a launchd stderr log nobody tails. Same null-means-absent contract as the
// push-retry/autofix-canary ledgers above.
//
// BRO-467 sibling fix: data/audit/digest-invariant-fail-ledger.jsonl is
// gitignored/Mac-local (same as the autofix-canary/backlog-drain ledgers
// above) and therefore ALWAYS reads null in CI — assessDigestInvariantFailRow
// then ALWAYS returns the identical static 'warn' ("cannot measure from this
// environment"), every run, forever. Task #1648's own fix already added the
// real, live-data fold into send-morning-digest.js's sections.health.errors
// (see that file, right after the autofix-canary fold this same card added)
// specifically so a genuine violation is never silently missed — this CI row
// was never the mechanism that achieves that; it can't be, structurally.
// Left in place it did exactly what BRO-467's throughput row did: filed and
// re-files BRO-3370 ("BSC Daily: Digest: content-invariant check") off a
// message that can never say anything else. Skip here for the same reason.
// LOCAL-FOLD(checkDigestInvariantFail): task #1648's own fix; the real row is
// folded into sections.health.errors by send-morning-digest.js (BRO-2199 audit).
function checkDigestInvariantFail(isCI) {
  if (isCI) return [];
  const { assessDigestInvariantFailRow } = require('./lib/digest-invariant-fail-monitor.js');
  const entries = readJsonlLedgerOrNull(path.join(AUDIT_DIR, 'digest-invariant-fail-ledger.jsonl'));
  return [assessDigestInvariantFailRow(entries)];
}

// --- Stuck pipeline items (card #794) ---
//
// scripts/send-morning-digest.js has computed this exact signal for months
// (overnight-digest.js's gatherDigest()/stuckSignals()) and auto-files a
// "Stuck pipeline items" card whenever it's non-empty — but the row only
// ever existed inside the digest's own extraIssues list, never in
// computeCoreHealthResults()/HEALTH_DIGEST_SNAPSHOT_FILE. That meant every
// auto-filed card's safe-form verify command
// (check-health-row-absent.js, reading this function's output) could never
// find the row present in the first place, so it reported the row "absent"
// (fixed) unconditionally — a permanent false pass regardless of whether
// anything was actually stuck. This makes the same signal a first-class row
// here so the row can genuinely go from warn to pass and back.
//
// Fidelity note: gatherDigest()'s worktree/cmux/reconcile-report sources
// only exist on the owner's Mac (reconcile-report.jsonl is gitignored,
// .claude/worktrees/ and the cmux binary aren't present in CI's ephemeral
// checkout) — those sections fail soft to "nothing found" there by design.
// A CI run of this check can therefore only ever see the git-history and
// tracked-file signals (review-count drop, rebuild-regression.json); the
// worktree/cmux/headless-job signals are only visible when this runs
// locally, same as the digest itself.
function checkStuckPipelineItems() {
  const { gatherDigest, stuckSignals } = require('./lib/overnight-digest.js');
  const repo = path.join(__dirname, '..');
  let digest;
  try {
    // skipFetch: this runs inside health-row-probe.js's supposed-to-be
    // side-effect-free --live probe (rerun on EVERY card's acceptance check,
    // not just this row's) — a real `git fetch` there would mutate
    // FETCH_HEAD/remote-tracking refs on disk, which the probe's fs-write
    // monkey-patch can't catch since it's a child process, not a Node fs
    // call (adversarial ship-check finding). send-morning-digest.js's real
    // run is unaffected — it doesn't pass this option.
    digest = gatherDigest({ repo, skipFetch: true });
  } catch (err) {
    return [{ name: 'Stuck pipeline items', status: 'warn', message: `Could not gather the overnight digest to check for stuck signals (${String(err.message).slice(0, 120)})` }];
  }
  const signals = stuckSignals(digest);
  if (signals.length) {
    return [{
      name: 'Stuck pipeline items',
      status: 'warn',
      message: `${signals.length} pipeline signal(s) flagged possibly-stuck by the overnight digest — investigate and unstick. ${signals.join(' | ')}`.slice(0, 500),
    }];
  }
  if (digest.errors.length) {
    // "No signals found" and "collection itself partially failed" are NOT
    // the same claim — collapsing them the way this row never existing at
    // all collapsed every state to "fixed" is the exact false-pass class
    // this row exists to end (adversarial ship-check finding).
    return [{
      name: 'Stuck pipeline items',
      status: 'warn',
      message: `Overnight digest gathered partially (${digest.errors.length} source(s) failed) — cannot confirm clean: ${digest.errors.join('; ')}`.slice(0, 500),
    }];
  }
  return [{ name: 'Stuck pipeline items', status: 'pass', message: 'No pipeline signals flagged possibly-stuck by the overnight digest.' }];
}

// --- Data freshness gaps (BRO-3697) ---
//
// send-morning-digest.js used to push this row only into its own
// extraIssues list, so it never existed in computeCoreHealthResults() and
// the auto-filed card's check-health-row-absent.js --live verify could only
// ever say 'unknown'. Same source and same 36h staleness bar as the digest
// (digest-snapshots.js readFreshnessReport / summarizeFreshnessHighSeverity),
// so the row and the digest's own freshness section cannot disagree.
// Distinct from checkFreshness() above, which checks file AGE, not content.
const DATA_FRESHNESS_GAPS_CHECK = 'Data freshness: shows missing poster/synopsis/tickets';

// Pure: takes readFreshnessReport()'s {status, snapshot, generatedAt} result.
function dataFreshnessGapsResult(r) {
  const name = DATA_FRESHNESS_GAPS_CHECK;
  if (!r || r.status !== 'fresh') {
    // Missing/stale/invalid report: the check could not run. The message
    // MUST start with "Skipped" so health-row-probe.js reads 'unknown', never
    // 'absent' (a still-open gap must not verify as fixed). Status stays
    // 'pass' so the skip does not file a misnamed "missing poster" card;
    // the digest already banners a stale report under "no fresh data from".
    return { name, status: 'pass', message: `Skipped — data/freshness-report.json is ${r ? r.status : 'unreadable'}${r && r.generatedAt ? ` (generated ${r.generatedAt})` : ''}; check-show-freshness.yml may not have run` };
  }
  if (!Array.isArray(r.snapshot?.dataQuality?.hasIssues)) {
    return { name, status: 'pass', message: 'Skipped — freshness-report.json has no dataQuality.hasIssues array (producer shape changed?)' };
  }
  const { summarizeFreshnessHighSeverity } = require('./lib/digest-snapshots.js');
  const summary = summarizeFreshnessHighSeverity(r.snapshot);
  const count = summary ? summary.count : 0;
  if (count > 0) {
    return {
      name,
      status: 'warn',
      message: `${count} open show(s) missing critical data — auto-fill from the standard image/synopsis/ticket pipelines.`,
    };
  }
  return { name, status: 'pass', message: 'No open show is missing a poster, synopsis or tickets' };
}

function checkDataFreshnessGaps({ dataDir = DATA_DIR, now = Date.now() } = {}) {
  return [runCheck(DATA_FRESHNESS_GAPS_CHECK, () => {
    const { readFreshnessReport } = require('./lib/digest-snapshots.js');
    return dataFreshnessGapsResult(readFreshnessReport({ dataDir, now }));
  })];
}

// --- Push-retry deadman (task #394) ---
//
// Full explanation (including the BRO-231/#1221 absent-vs-empty contract)
// lives in scripts/lib/push-retry-deadman.js's header.
//
// SOURCE (task: push-retry-failure telemetry, 2026-08-23, Phase 0 of the
// push-contention systemic fix): the LOCAL data/audit/push-retry-
// failures.jsonl this used to read is gitignored and dies with the runner
// whenever the failed push is the only write in a CI job — which is exactly
// why this row reported "Cannot measure" for months. record_push_failure()
// (scripts/lib/push-with-retry.sh) now ALSO durably records to a dedicated
// `push-retry-failures` git branch via the generalized scripts/lib/
// push-ledger-store.js (same CAS-branch pattern proven by the push-ledger
// success stream). Reads from THAT branch now, not the local file — same
// null-means-absent contract as readJsonlLedgerOrNull() above (any read/
// fetch error, including the branch not existing yet, returns null so this
// row still says "cannot measure" rather than falsely reporting zero
// failures).
function readPushRetryFailureLedgerOrNull() {
  try {
    const { readLedger } = require('./lib/push-ledger-store.js');
    const { parseLedgerLines } = require('./lib/push-ledger.js');
    const cwd = path.join(__dirname, '..');
    const { content, fetchFailed } = readLedger(cwd, { branch: 'push-retry-failures', file: 'failures.jsonl' });
    if (fetchFailed) return null;
    return parseLedgerLines(content, ['reason', 'ts']);
  } catch {
    return null;
  }
}

// CI-ONLY-OK(checkPushRetryDeadman): NOT a per-machine ledger any more. It
// reads the `push-retry-failures` git branch (readPushRetryFailureLedgerOrNull
// above), which CI can fetch, so 'error'/'warn' are reachable from the CI
// digest run and no send-morning-digest.js local fold is needed. The old
// per-machine caveat is history; see scripts/lib/push-retry-deadman.js SOURCE.
// Enforced by tests/unit/audit-health-check-audit.test.mjs (BRO-2199).
function checkPushRetryDeadman(dryRun = false) {
  const { assessPushRetryDeadman } = require('./lib/push-retry-deadman.js');
  // Reading this remote ledger fetches its branch. A live probe must leave
  // refs untouched and report an unreadable ledger, never a clean empty one.
  const row = assessPushRetryDeadman(dryRun ? null : readPushRetryFailureLedgerOrNull());
  if (dryRun) row.message = 'Skipped: the side-effect-free probe cannot fetch the durable push-retry-failures ledger.';
  return [row];
}

// --- Shared checkout depth (BRO-2049) ---
// LOCAL-FOLD(checkSharedCheckoutShallow): health-check.js runs only in GitHub Actions
// (data-health-check.yml, ubuntu-latest), which cannot see the Mac Studio's shared checkout, and CI
// checkouts are shallow by design. So in CI this returns NO row (never a reassuring pass) and the real
// measurement is shallowDigestRow() folded into send-morning-digest.js, which runs on the Mac under
// launchd. Run by hand on the Mac, this row measures the canonical main checkout. `deps` exists for tests.
function checkSharedCheckoutShallow(deps = {}) {
  const { shallowDigestRow } = require('./lib/shared-checkout-shallow.js');
  const ci = deps.ci !== undefined ? deps.ci : (!!process.env.CI || !!process.env.GITHUB_ACTIONS || process.env.CLAUDE_CODE_REMOTE === 'true');
  if (ci) return [];
  return [shallowDigestRow({ fromDir: __dirname, deps: { ...deps, ci: false } })];
}

// --- Category I3: Infra-review gate telemetry (task #1095) ---
//
// The #1079 gate (~/.claude/hooks/infra-plan-review-gate.sh,
// scripts/lib/infra-review-scope.js) writes every warn/block to
// data/audit/infra-review-gate.jsonl — gitignored, per-machine, read by
// nothing until now. A session that ran a real /plan-review and one that
// typed "NO-PLAN-REVIEW: whatever" both look like silence from the owner's
// side. Card #672 named the honest observable: the ratio of real
// pre-implementation reviews (phase:'plan' verdicts in
// .claude/review-verdicts.jsonl) to bypasses. Pure counting logic lives in
// scripts/lib/infra-review-digest.js (tested by
// scripts/tests/infra-review-digest.test.mjs) — this just reads the two
// ledgers and hands them over.

function readJsonlBestEffort(absPath) {
  let raw;
  try {
    raw = fs.readFileSync(absPath, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* tolerate partial line */ }
  }
  return out;
}

// Both ledgers are written by ~/.claude/hooks/infra-plan-review-gate.sh /
// scripts/lib/review-gate.mjs at the MAIN checkout root — resolved via
// `git rev-parse --git-common-dir`, not the invoking script's own directory,
// specifically so a worktree session's writes land somewhere every other
// worktree (and this check) can see (infra-review-scope.js header, and
// review-gate.mjs's canonicalRoot()). This file is __dirname-relative by
// default (matching every other check here), which resolves to the WRONG
// directory when health-check.js itself runs from inside a worktree — the
// overwhelmingly common case per this repo's own worktree-first mandate.
// Reading via __dirname alone would make this check see nothing even on the
// same machine, in the same run, that just wrote real events.
function infraReviewLedgerRoot() {
  try {
    const common = execSync('git rev-parse --git-common-dir', { cwd: __dirname, encoding: 'utf8' }).trim();
    if (!common) return path.join(__dirname, '..');
    // `common` is already relative to __dirname (git was invoked with
    // cwd: __dirname) — joining it against __dirname alone resolves it
    // correctly, matching review-gate.mjs's canonicalRoot(). An earlier
    // version prepended an extra '..' here, which double-counted the
    // "go up one level" already baked into a relative --git-common-dir
    // result (e.g. "../.git") and landed one directory ABOVE the actual
    // repo root for any plain (non-worktree) checkout — silently wrong
    // only for the primary Mac Studio use case, since worktree common-dir
    // happens to come back absolute and skip this branch entirely
    // (caught by ship-check's adversarial review, task #1095).
    const abs = path.isAbsolute(common) ? common : path.join(__dirname, common);
    return path.dirname(abs);
  } catch {
    return path.join(__dirname, '..');
  }
}

// CI-ONLY-OK(checkInfraReviewGate): reads two gitignored per-machine ledgers,
// but computeInfraReviewDigest() can only return 'pass' or 'warn', never
// 'error' (infra-review-digest.js), so there is no unreachable error state
// like #1648's. It is non-paging policy telemetry: in CI it says plainly
// "cannot measure here" (warn) and the real counts are read by running
// health-check.js on the Mac. Folding a warn into the owner email would only
// add noise. If this ever gains an 'error' status, it needs a local fold in
// send-morning-digest.js like checkAutofixCanary. Enforced by
// tests/unit/audit-health-check-audit.test.mjs (BRO-2199).
function checkInfraReviewGate() {
  const ledgerRoot = infraReviewLedgerRoot();
  const gatePath = path.join(ledgerRoot, 'data', 'audit', 'infra-review-gate.jsonl');
  const verdictsPath = path.join(ledgerRoot, '.claude', 'review-verdicts.jsonl');
  // Both ledgers are gitignored, per-machine files the local
  // infra-plan-review-gate.sh hook writes only on a dev machine — a fresh CI
  // checkout will never have them. Reporting the same "no edits observed"
  // pass message in that case would be indistinguishable from a genuinely
  // clean week: exactly the vacuous-gate failure class (task #1075, #1063-69)
  // this file elsewhere insists on failing loud for. Say plainly that this
  // environment can't see the telemetry instead of silently passing.
  if (!fs.existsSync(gatePath) && !fs.existsSync(verdictsPath)) {
    return [{
      name: 'Infra-review: gate telemetry',
      status: 'warn',
      unmeasurable: true,
      message: 'No local infra-review telemetry visible from this environment — data/audit/infra-review-gate.jsonl and .claude/review-verdicts.jsonl are gitignored, per-machine files the #1079 hook writes only where it runs. This check cannot confirm the plan-review gate is being used or bypassed from here.',
      hint: 'Run `node scripts/health-check.js` on the machine where the hook actually fires to see real counts. A CI-visible rollup (so the scheduled digest sees this too) is tracked as a follow-up.',
    }];
  }
  const { computeInfraReviewDigest } = require('./lib/infra-review-digest.js');
  const gateEvents = readJsonlBestEffort(gatePath);
  const planVerdicts = readJsonlBestEffort(verdictsPath);
  return [runCheck('Infra-review: gate telemetry', () => computeInfraReviewDigest({
    gateEvents, planVerdicts, now: Date.now(),
  }))];
}

// --- Category: Dispatch outcomes (did dispatched work actually land?) ---
//
// scripts/audit-dispatch-outcomes.js (task #1101) already classifies every
// dispatch as landed/in-flight/abandoned by cross-referencing
// data/audit/dispatch-ledger.jsonl against the task store, but nothing ran
// it — its first real run found 37 abandoned dispatches that had gone unseen
// for up to 14 days (task #1106). This wires its pure decision function
// (scripts/lib/dispatch-outcome-digest.js) into the daily digest.
//
// dispatch-ledger.jsonl is gitignored/per-machine, same as the infra-review
// ledger above — a fresh CI checkout won't have it. Say so plainly instead of
// a silent pass (#1075 vacuous-gate class).
//
// previousAbandonedCount is tracked in its own small state file rather than
// folded into the shared HISTORY_FILE: history.results (below, ~L3546) is
// deliberately narrowed to {name,status,message} for every check to avoid
// bloating health-check-history.json, so extending it would mean widening
// that shared shape for one check. A dedicated per-check state file already
// has precedent here (tryAutoFix()'s data/audit/triage/autofix-*.json
// attempt counters) — this follows the same pattern.
const DISPATCH_OUTCOME_STATE_FILE = path.join(AUDIT_DIR, 'dispatch-outcome-digest-state.json');

// CI-ONLY-OK(checkDispatchOutcomes): reads gitignored dispatch-ledger.jsonl but
// computeDispatchOutcomeDigest() only yields pass/warn (no 'error' state to
// lose), and in CI it says plainly it cannot measure. The error-capable
// dispatch rows are checkDispatchHealth, which is folded locally (BRO-2199).
function checkDispatchOutcomes(dryRun) {
  const ledgerPath = path.join(AUDIT_DIR, 'dispatch-ledger.jsonl');
  if (!fs.existsSync(ledgerPath)) {
    return [{
      name: 'Dispatch outcomes: abandoned',
      status: 'warn',
      unmeasurable: true,
      message: 'No local dispatch-ledger.jsonl visible from this environment — data/audit/dispatch-ledger.jsonl is gitignored, per-machine, written only where dispatches actually launch. This check cannot confirm dispatch outcomes from here.',
      hint: 'Run `node scripts/health-check.js` (or `node scripts/audit-dispatch-outcomes.js`) on the machine where dispatches launch to see real counts.',
    }];
  }

  return [runCheck('Dispatch outcomes: abandoned', () => {
    const { computeDispatchOutcomeDigest } = require('./lib/dispatch-outcome-digest.js');
    const { classifyDispatches, OUTCOMES } = require('./lib/dispatch-outcome.js');
    const { loadTasksUnioned } = require('./audit-dispatch-outcomes.js');

    const raw = fs.readFileSync(ledgerPath, 'utf8');
    const dispatchLedgerEntries = raw.trim().split('\n')
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);

    // loadTasksUnioned() throws loud on an empty/unreadable task store — do
    // NOT wrap this in a try/catch that defaults to an empty Map. runCheck()
    // (the caller) turns an uncaught throw into a visible 'error' status row,
    // which is the point: a dead task store must surface as broken, not as a
    // quiet "0 abandoned" pass (#1063/#1069 vacuous-gate class).
    const tasksById = loadTasksUnioned();

    // cmux-workspaces.js is the shared, tested cmux-liveness abstraction
    // (also used by the #1102 dispatch watchdog) — reuse it rather than
    // re-parsing `cmux list-workspaces` a second way.
    // An empty result is treated the SAME as cmux being unavailable (ship-check
    // finding, task #1106): `listWorkspaces()` returns `[]` on a cmux daemon
    // hiccup or malformed output, not a throw — trusting an empty Set as
    // ground truth would flip EVERY in-flight dispatch with a workspaceRef to
    // ABANDONED in one shot (dispatch-outcome.js's workspaceGone check is
    // `!live.has(ref)`, true for everything when live is empty). "Never
    // guess" already governs the ledger-side helper this mirrors
    // (audit-dispatch-outcomes.js's own liveWorkspaceRefs()) — apply the same
    // rule here: only trust cmux when it reports at least one workspace.
    let liveWorkspaceRefs;
    try {
      const { cmuxAvailable, listWorkspaces } = require('./lib/cmux-workspaces.js');
      if (cmuxAvailable()) {
        const refs = listWorkspaces().map((w) => w.ref);
        if (refs.length > 0) liveWorkspaceRefs = new Set(refs);
      }
    } catch { /* cmux unavailable — classifyDispatches falls back to ledger-only */ }

    let previousAbandonedCount = null;
    try {
      if (fs.existsSync(DISPATCH_OUTCOME_STATE_FILE)) {
        const prev = readJSON(DISPATCH_OUTCOME_STATE_FILE);
        previousAbandonedCount = typeof prev.abandonedCount === 'number' ? prev.abandonedCount : null;
      }
    } catch { /* corrupt state file — treat as no history, don't fail the check over it */ }

    const row = computeDispatchOutcomeDigest({
      dispatchLedgerEntries, tasksById, liveWorkspaceRefs, previousAbandonedCount,
    });

    // The state file tracks the TRUE current count, not "count as of the
    // last alert" — recompute it directly rather than relying on `row`,
    // which is null both when there are 0 abandoned and when the count is
    // unchanged from last run.
    const currentAbandonedCount = classifyDispatches(
      dispatchLedgerEntries, tasksById, liveWorkspaceRefs ? { liveWorkspaceRefs } : {}
    ).filter((r) => r.outcome === OUTCOMES.ABANDONED).length;
    // dryRun (health-row-probe.js's live verification probe): compute the row
    // exactly as normal but skip the trend-cache write — a probe run must never
    // perturb the state a REAL health-check.js run compares "unchanged since
    // last run" against, or it corrupts tomorrow's real digest message.
    if (!dryRun) {
      try {
        fs.mkdirSync(AUDIT_DIR, { recursive: true });
        fs.writeFileSync(DISPATCH_OUTCOME_STATE_FILE, JSON.stringify({
          abandonedCount: currentAbandonedCount, updatedAt: new Date().toISOString(),
        }, null, 2) + '\n');
      } catch { /* best-effort persistence — a failed write here shouldn't fail the check */ }
    }

    if (row) return row;
    // currentAbandonedCount > 0 but unchanged from last run still counts as
    // 'warn', not 'pass' — an unresolved backlog must not silently drop out
    // of the digest's pass/warn/error tally just because it stopped
    // generating a fresh alert (the vacuous-pass class this whole check
    // exists to avoid). Only a genuinely zero count is a real pass.
    return currentAbandonedCount === 0
      ? { name: 'Dispatch outcomes: abandoned', status: 'pass', message: 'No abandoned dispatches' }
      : { name: 'Dispatch outcomes: abandoned', status: 'warn', message: `${currentAbandonedCount} abandoned dispatch(es), unchanged since last run — see \`node scripts/audit-dispatch-outcomes.js\`` };
  })];
}

// --- Category I1b: Dispatch health (do dispatched sessions actually START?) ---
//
// checkDispatchOutcomes above asks whether dispatched work LANDED. This asks
// the prior question: did the session ever start at all? Card #1199 — roughly
// one bsc-next launch in five creates its cmux workspace, never renders a
// terminal surface, and so never runs the injected command. The retry layer
// recovers the WORK, so each session sees only its own 1-3 failures, retries,
// succeeds, and truthfully reports success; nothing aggregated the ledger, so
// a chronic ~20% rate ran unseen for a week and several "fixes" were judged
// green by a single clean dispatch. Only the RATE over many launches can tell
// whether a cause fix worked, which is what this row is for.
//
// Same gitignored/per-machine caveat as checkDispatchOutcomes — say so plainly
// rather than passing on missing input (#1075 vacuous-gate class).

// LOCAL-FOLD(checkDispatchHealth): reads gitignored dispatch-ledger.jsonl, so
// in CI this is only the "(unmeasurable here)" warn. The real 'error' rows are
// evaluated by send-morning-digest.js (computeDispatchHealthDigest /
// computeHeadlessDispatchDigest) on the Mac (BRO-2199).
function checkDispatchHealth() {
  const ledgerPath = path.join(AUDIT_DIR, 'dispatch-ledger.jsonl');
  const { CHECK_NAME, HEADLESS_CHECK_NAME } = require('./lib/dispatch-health.js');
  if (!fs.existsSync(ledgerPath)) {
    // Card #1714 ship-check finding: dispatch-ledger.jsonl is gitignored and
    // per-machine, and this function only ever executes for real (i.e. feeds
    // history/alerts/the digest snapshot, not just a local console run) from
    // data-health-check.yml on ubuntu-latest — an environment that can NEVER
    // have this file. Giving these rows the SAME name as the real-measurement
    // rows below would make them match CHECK_NAME/HEADLESS_CHECK_NAME's
    // AUTO_FIX_PLAYBOOK entries (urgency 'this-week', has humanAction) and
    // file a permanently-open, permanently-unresolvable "cannot measure" card
    // via routeAlert on every single CI run, forever — since the condition
    // that would close it (the ledger existing on that runner) can never
    // become true. Suffixed name deliberately does NOT match either playbook
    // regex (both are `^...$`-anchored). That alone was NOT enough: a row
    // with no playbook entry is actionable by default, so these were filed as
    // "BSC Daily" cards anyway (BRO-4120, BRO-4704..4708). `unmeasurable: true`
    // is what keeps them visible in the full check list but never actionable,
    // never in the digest snapshot, never card-filed. The unsuffixed names stay
    // reserved for a real local run where the ledger IS present.
    return [
      {
        name: `${CHECK_NAME} (unmeasurable here)`,
        status: 'warn',
        unmeasurable: true,
        message: 'No local dispatch-ledger.jsonl visible from this environment — data/audit/dispatch-ledger.jsonl is gitignored, per-machine, written only where dispatches actually launch. The dead-launch rate cannot be measured from here.',
        hint: 'Run `node scripts/audit-dispatch-dead-rate.js` on the machine where dispatches launch to see the real rate.',
      },
      {
        name: `${HEADLESS_CHECK_NAME} (unmeasurable here)`,
        status: 'warn',
        unmeasurable: true,
        message: 'No local dispatch-ledger.jsonl visible from this environment — data/audit/dispatch-ledger.jsonl is gitignored, per-machine, written only where dispatches actually launch. The headless success rate cannot be measured from here.',
        hint: 'Run `node scripts/audit-headless-outcome-rate.js` on the machine where dispatches launch to see the real rate.',
      },
    ];
  }

  // Parsed once and shared by both rows below (ship-check finding: two
  // separate reads of the same concurrently-appended JSONL file could
  // describe two different populations if a writer appends between them).
  const entries = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n')
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);

  return [runCheck(CHECK_NAME, () => {
    const { computeDispatchHealthDigest } = require('./lib/dispatch-health.js');
    // No previous-value suppression on purpose (contrast checkDispatchOutcomes'
    // DISPATCH_OUTCOME_STATE_FILE): a static abandoned COUNT is stale news, but
    // a RATE above the floor is a live defect every day it holds, and
    // "unchanged since yesterday" silence is exactly the invisibility #1199
    // exists to end. Repeat-day email noise is already handled downstream by
    // owner-alert-router's conditionKey, which files one card per OPEN
    // incident rather than one per run.
    const { name, status, message, hint } = computeDispatchHealthDigest({
      entries, nowMs: Date.now(),
    });
    return hint ? { name, status, message, hint } : { name, status, message };
  }), runCheck(HEADLESS_CHECK_NAME, () => {
    const { computeHeadlessDispatchDigest } = require('./lib/dispatch-health.js');
    // Same no-suppression reasoning as the cmux row above — card #1714.
    const { name, status, message, hint } = computeHeadlessDispatchDigest({
      entries, nowMs: Date.now(),
    });
    return hint ? { name, status, message, hint } : { name, status, message };
  })];
}

// --- Category I1c: cmux socket reachability (BRO-2992) ---
//
// Every consumer of the cmux socket (checkDispatchOutcomes above,
// dispatch-watchdog-core.js, overnight-digest.js) degrades quietly when it
// can't be reached instead of asserting reachability directly — that silence
// is why the 2026-09-07 BRO-2959 auth migration disabled bsc-reconcile's tab
// self-heal, bsc-prune, and dispatch-watchdog simultaneously for ~2h with
// nothing paging. Decision logic (streak tracking + the alert threshold)
// lives in scripts/lib/cmux-reachability-check.js, shared verbatim with the
// dedicated launchd sentinel (scripts/check-cmux-reachability.js) that
// actually catches this in near-real-time — data-health-check.yml only runs
// this row once/day on ubuntu-latest, where cmux.app can never exist, so
// this row degrades to the same "(unmeasurable here)" pattern
// checkDispatchHealth() uses above rather than manufacturing a permanent
// false "unreachable" streak out of a CI runner that was never going to have
// cmux installed.
async function checkCmuxReachability() {
  const { runReachabilityCheck } = require('./lib/cmux-reachability-check.js');
  // Always dryRun:true here, independent of health-check.js's own dryRun param
  // (plan-review finding, BRO-2992): cmux-workspaces.js's run() admits a
  // process INSIDE cmux by ancestry alone, no credential needed, while an
  // outside-cmux launchd process must present CMUX_SOCKET_PASSWORD — exactly
  // the axis BRO-2959 broke along. health-check.js is routinely run
  // interactively FROM inside a cmux workspace (including this card's own
  // `VERIFY: node scripts/health-check.js`), so if this row wrote to the same
  // attempts log the dedicated launchd sentinel (scripts/check-cmux-
  // reachability.js) uses, one healthy in-cmux run would reset the
  // consecutive-failure streak to zero even during a real outside-cmux
  // outage — silently defeating the very alert this card exists to
  // guarantee. This row still probes live and reads the sentinel's real
  // persisted streak for display, it just never writes to it or pages —
  // paging stays the sentinel's job alone.
  return [await runReachabilityCheck({ dryRun: true })];
}

// --- Category I2: Deploy freshness (content-aware gate watchdog) ---
//
// The should-deploy gate (scripts/lib/should-deploy-gate.js) skips scheduled
// deploys when nothing site-relevant changed, with a 6h staleness backstop.
// All existing alerting keys off run FAILURES — a gate stuck wrongly-closed
// produces green skip runs and zero deploys with no signal (plan-review
// pre-mortem, 2026-07-19). This check is the stuck-closed detector: the
// backstop guarantees a READY production deployment at least every ~6h
// (plus cron delay), so age >8h means the gate, the cron, or Vercel is broken.
// Uses check-prod-deploy.js (canonical READY-deployment query) — do not
// hand-roll another copy of the Vercel API call.

function checkDeployFreshness() {
  if (!process.env.VERCEL_TOKEN) {
    return [{ name: 'Deploy: production freshness', status: 'warn', message: 'Skipped — no VERCEL_TOKEN available' }];
  }
  return [runCheck('Deploy: production freshness', () => {
    let out;
    try {
      out = execSync('node scripts/check-prod-deploy.js --json', {
        encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      // check-prod-deploy exits 2 on API/network failure — a transient Vercel
      // blip is not "prod is stale"; warn (visible in digest) instead of error
      // (subject-line escalation). A real freshness breach still errors below.
      return { name: 'Deploy: production freshness', status: 'warn', message: `Vercel API unreachable (${err.message.split('\n')[0].slice(0, 120)}) — freshness unknown this run` };
    }
    const dep = JSON.parse(out);
    const ageH = dep.ageSec / 3600;
    const msg = `Latest READY production deploy: ${dep.deployedSha ? dep.deployedSha.slice(0, 10) : 'unknown-sha'}, age ${ageH.toFixed(1)}h`;
    // BRO-2771: this hint used to tell the owner to run `gh run list --workflow=...`,
    // the exact command BRO-2767 proved returns months-stale result sets on this repo.
    const hint = 'Gate stuck or cron dead? Check should-deploy runs with: gh api "repos/{owner}/{repo}/actions/workflows/vercel-deploy.yml/runs?per_page=10" --jq \'.workflow_runs[] | "\\(.created_at) \\(.conclusion)"\' — use that REST form, NOT the gh CLI run-listing shorthand, which is stale on this repo. Then dispatch "Rebuild Reviews (Fast)", or set repo var DEPLOY_GATE_DISABLED=true';
    if (ageH > 12) return { name: 'Deploy: production freshness', status: 'error', message: msg + ' (>12h — 6h backstop is not firing)', hint };
    if (ageH > 8) return { name: 'Deploy: production freshness', status: 'warn', message: msg + ' (>8h — backstop late; GH cron delays can explain up to ~2h)', hint };
    return { name: 'Deploy: production freshness', status: 'pass', message: msg };
  })];
}

// --- Category: Stuck Work — retired (BRO-3018) ---
//
// The "Stuck work:" rows read the Notion brain, frozen since 2026-08-20, and
// counted cards that were long closed in Linear or never migrated. Linear
// covers both states itself: linear-reclaim-abandoned.js hands idle In
// Progress cards back hourly, and a paused report moves a card to Backlog
// (linear-session-reporting.js). The last snapshot is in
// docs/notion-linear-residue-sweep.md.

// --- Category J: API Credits ---

function checkAPICredits() {
  const apiKey = process.env.SCRAPINGBEE_API_KEY;
  const results = [];

  // No early return on a missing SB key — the SD/BD/BB checks below must
  // still run (each provider is monitored independently).
  if (!apiKey) {
    results.push({ name: 'Credits: ScrapingBee', status: 'warn', message: 'Skipped — no SCRAPINGBEE_API_KEY available' });
  } else results.push(runCheck('Credits: ScrapingBee', () => {
    try {
      const result = execSync(
        `curl -s "https://app.scrapingbee.com/api/v1/usage?api_key=${apiKey}"`,
        { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      // Field names live in provider-billing.sbUsageFields (BRO-3010); values
      // pass through untouched, so this check's maths are unchanged.
      const usage = sbUsageFields(JSON.parse(result));
      const remaining = usage.max - usage.used;
      const pctUsed = Math.round((usage.used / usage.max) * 100);
      const pctRemaining = 100 - pctUsed;
      const remainingK = Math.round(remaining / 1000);

      // Project exhaustion date from burn rate
      let exhaustionMsg = '';
      if (usage.renewalAt && usage.used > 0) {
        const renewalDate = new Date(usage.renewalAt);
        const renewalStr = renewalDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const daysUntilRenewal = Math.max(0, (renewalDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
        // Estimate cycle length from renewal date (assume ~30 day cycles)
        const cycleStartEstimate = new Date(renewalDate);
        cycleStartEstimate.setDate(cycleStartEstimate.getDate() - 30);
        const daysIntoCycle = Math.max(1, (Date.now() - cycleStartEstimate.getTime()) / (1000 * 60 * 60 * 24));

        if (remaining <= 0) {
          exhaustionMsg = ` · EXHAUSTED · renews ${renewalStr}`;
        } else if (daysIntoCycle < 5) {
          // Too early in cycle for a reliable daily rate — denominator is too small
          exhaustionMsg = ` · renews ${renewalStr} (burn rate unavailable — <5 days into cycle)`;
        } else {
          const dailyBurnRate = Math.round(usage.used / daysIntoCycle);
          const daysUntilExhaustion = remaining / dailyBurnRate;
          exhaustionMsg = ` · ${Math.round(dailyBurnRate / 1000)}k/day burn · `;
          if (daysUntilExhaustion < daysUntilRenewal) {
            exhaustionMsg += `exhausts in ~${Math.round(daysUntilExhaustion)}d (renews ${renewalStr})`;
          } else {
            exhaustionMsg += `lasts until renewal ${renewalStr}`;
          }
        }
      }

      if (pctRemaining <= 5) {
        if (remaining <= 0) {
          const ack = SCRAPINGBEE_ACKNOWLEDGED_EXHAUSTION;
          if (isScrapingBeeExhaustionAcknowledged()) {
            return { name: 'Credits: ScrapingBee', status: 'warn', message: `${remainingK}k credits left (${pctRemaining}%)${exhaustionMsg} — acknowledged: ${ack.reason} [expires ${ack.expires}]` };
          }
        }
        return { name: 'Credits: ScrapingBee', status: 'error', message: `${remainingK}k credits left (${pctRemaining}%)${exhaustionMsg}`, hint: 'Upgrade plan or reduce scraping.' };
      }
      if (pctRemaining <= 15) {
        return { name: 'Credits: ScrapingBee', status: 'warn', message: `${remainingK}k credits left (${pctRemaining}%)${exhaustionMsg}`, hint: 'Monitor usage — may run out before renewal.' };
      }
      return { name: 'Credits: ScrapingBee', status: 'pass', message: `${remainingK}k credits left (${pctRemaining}%)${exhaustionMsg}` };
    } catch (err) {
      return { name: 'Credits: ScrapingBee', status: 'warn', message: `API check failed: ${err.message.substring(0, 80)}` };
    }
  }));

  // Scrapingdog — same burn-projection shape as SB. Added 2026-07-19 after the
  // SB-exhaustion incident revealed SD had ZERO balance monitoring: if SD runs
  // dry, every fetch silently falls back to BD/SB (the exact failure that
  // exhausted SB's plan). 'error' (not 'warn') on projected exhaustion so the
  // actionable-only email policy actually delivers it — EXCEPT while the
  // expiring scrapingdog-ack acknowledgment (task #418) covers a known,
  // non-imminent burn spike: that narrow case reports 'warn' with the ack
  // reason inline. Exhausted/near-dry/<3d-out balances always stay 'error'.
  const sdKey = process.env.SCRAPINGDOG_API_KEY;
  if (sdKey) {
    results.push(runCheck('Credits: ScrapingDog', () => {
      // Internal try/catch: a transient curl timeout / non-JSON response must
      // report 'warn', not 'error' — runCheck's catch would emit an emailing
      // 'error' for pure infra noise. 'error' is reserved for a successfully
      // parsed low/exhausted balance (same pattern as the SB check above).
      let acct;
      try {
        const result = execSync(
          `curl -s --max-time 10 "https://api.scrapingdog.com/account?api_key=${sdKey}"`,
          { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }
        ).trim();
        acct = JSON.parse(result);
      } catch (err) {
        return { name: 'Credits: ScrapingDog', status: 'warn', message: `API check failed: ${err.message.substring(0, 80)}` };
      }
      if (!acct || !acct.requestLimit) {
        return { name: 'Credits: ScrapingDog', status: 'warn', message: `Unexpected account response: ${JSON.stringify(acct ?? null).slice(0, 80)}` };
      }
      // Pure decision lives in scripts/lib/scrapingdog-ack.js (§15 extraction)
      // so the ack downgrade is unit-testable; this call site only fetches.
      const { status, message: msg } = evaluateScrapingdogCredits(acct);
      return { name: 'Credits: ScrapingDog', status, message: msg, hint: status !== 'pass' ? 'If SD runs dry, all traffic silently falls back to BD/SB. Upgrade plan or reduce scraping.' : undefined };
    }));
  } else {
    results.push({ name: 'Credits: ScrapingDog', status: 'warn', message: 'Skipped — no SCRAPINGDOG_API_KEY available' });
  }

  // Bright Data — month-to-date spend (serp + unlocker zones), balance shown
  // for context only. Alerting rationale in the comment inside the check.
  const bdToken = process.env.BRIGHTDATA_TOKEN;
  if (bdToken) {
    results.push(runCheck('Credits: Bright Data', () => {
      // Internal try/catch: infra failure → 'warn' (see ScrapingDog note above).
      let bal;
      try {
        const balRaw = execSync(
          `curl -s --max-time 10 -H "Authorization: Bearer ${bdToken}" "https://api.brightdata.com/customer/balance"`,
          { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }
        ).trim();
        bal = JSON.parse(balRaw);
      } catch (err) {
        return { name: 'Credits: Bright Data', status: 'warn', message: `API check failed: ${err.message.substring(0, 80)}` };
      }
      const monthStart = new Date();
      monthStart.setDate(1);
      const from = monthStart.toISOString().split('T')[0];
      const to = new Date().toISOString().split('T')[0];
      const zones = ['serp_api1', process.env.BRIGHTDATA_ZONE || 'web_unlocker2'];
      let monthCost = 0;
      for (const zone of [...new Set(zones)]) {
        try {
          const costRaw = execSync(
            `curl -s --max-time 10 -H "Authorization: Bearer ${bdToken}" "https://api.brightdata.com/zone/cost?zone=${zone}&from=${from}&to=${to}"`,
            { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }
          ).trim();
          const cost = JSON.parse(costRaw);
          for (const cust of Object.values(cost)) {
            if (cust && cust.custom && typeof cust.custom.cost === 'number') monthCost += cust.custom.cost;
          }
        } catch { /* per-zone cost is best-effort */ }
      }
      // BD is pay-as-you-go with MONTHLY INVOICING (verified in dashboard
      // 2026-07-19: "All bills are paid", next invoice 1st of month). The
      // prepaid `balance` field is leftover credit, NOT a spending limit —
      // consumption accrues to the invoice and scraping does NOT hard-stop at
      // $0 balance. So low balance is normal and must not alert; the real
      // signal is month-to-date spend (runaway SERP demand). Baseline ~$225/mo
      // pace July 2026.
      const balance = typeof bal.balance === 'number' ? bal.balance : null;
      const pending = typeof bal.pending_costs === 'number' ? bal.pending_costs : 0;
      let msg = `balance $${balance !== null ? balance.toFixed(2) : '?'} · pending invoice $${pending.toFixed(2)} · month-to-date $${monthCost.toFixed(2)} (serp+unlocker)`;
      if (monthCost > 400) {
        return { name: 'Credits: Bright Data', status: 'error', message: msg, hint: 'BD spend above $400/mo pace — runaway SERP/unlocker demand, investigate now (cost report attributes by workflow).' };
      }
      if (monthCost > 250) {
        return { name: 'Credits: Bright Data', status: 'warn', message: msg, hint: 'BD spend above $250/mo pace — check SERP demand.' };
      }
      return { name: 'Credits: Bright Data', status: 'pass', message: msg };
    }));
  }

  // Browserbase — usage trend only (minutes are lifetime-cumulative; small volume).
  const bbKey = process.env.BROWSERBASE_API_KEY;
  const bbProject = process.env.BROWSERBASE_PROJECT_ID;
  if (bbKey && bbProject) {
    results.push(runCheck('Credits: Browserbase', () => {
      let usage;
      try {
        const raw = execSync(
          `curl -s --max-time 10 -H "X-BB-API-Key: ${bbKey}" "https://api.browserbase.com/v1/projects/${bbProject}/usage"`,
          { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }
        ).trim();
        usage = JSON.parse(raw);
      } catch (err) {
        return { name: 'Credits: Browserbase', status: 'warn', message: `API check failed: ${err.message.substring(0, 80)}` };
      }
      if (!usage || typeof usage.browserMinutes !== 'number') {
        return { name: 'Credits: Browserbase', status: 'warn', message: `Unexpected usage response: ${JSON.stringify(usage ?? null).slice(0, 80)}` };
      }
      return { name: 'Credits: Browserbase', status: 'pass', message: `${usage.browserMinutes} browser minutes used (cumulative)` };
    }));
  }

  return results;
}

// --- Category K: Workflow Runs (last 24h summary via GitHub API) ---

async function getWorkflowRunSummary() {
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
    return { total: 0, failed: 0, succeeded: 0, failedRuns: [], repeatFailures: [], skipped: true };
  }

  // Rate-limit headroom check FIRST (the /rate_limit endpoint itself is free
  // — see scripts/lib/gh-api-cache.js). This call alone can spend up to 3
  // run-list pages plus capped job-detail calls; when the shared budget is
  // low, skip it gracefully instead of contributing to the exhaustion.
  if (hasLowHeadroom()) {
    return { total: 0, failed: 0, succeeded: 0, failedRuns: [], repeatFailures: [], skipped: true, skipReason: 'low rate-limit headroom' };
  }

  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const owner = 'thomaspryor';
  const repo = 'Broadwayscore';

  try {
    // Cached (shared across every concurrently-dispatched session on this
    // Mac): this is the single most expensive call in health-check.js (up to
    // 3 paginated requests), and health-check.js runs on every /ship-check +
    // /wrap-up across dozens of dispatches/day. `since` is intentionally NOT
    // part of the cache key — it's "last 24h from call time" either way, and
    // pinning the key lets concurrent callers within the TTL window share
    // one result instead of each computing a distinct since= and missing.
    const { runs: results, partial } = await cachedFetch('workflow-run-summary-24h', async () => {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      // Use REST API with per_page=100 (covers most days in 1-2 calls)
      const runs = [];
      let page = 1;
      const maxPages = 3; // Cap at 300 runs to avoid rate limit issues
      let partial = false;

      while (page <= maxPages) {
        const url = `https://api.github.com/repos/${owner}/${repo}/actions/runs?created=%3E${since}&per_page=100&page=${page}`;
        let response;
        try {
          response = await fetchGitHubJSON(url, { token, caller: 'health-check.js', headers: { 'User-Agent': 'bsc-health-check' } });
        } catch (pageErr) {
          // A failure on page 2+ must not discard page 1's already-fetched
          // runs (fetchGitHubJSON throws on non-2xx, unlike the old fetchJSON
          // which silently parsed whatever body came back) — degrade to
          // "partial results" instead of losing everything. A page-1 failure
          // means zero data was ever fetched — keep propagating that to the
          // outer catch so it reports skipped/error rather than a false "0
          // failures" clean read.
          if (page === 1) throw pageErr;
          console.error(`[Workflows] page ${page} fetch failed, using ${runs.length} run(s) from earlier pages: ${pageErr.message}`);
          partial = true;
          break;
        }
        if (!response || !response.workflow_runs) break;
        runs.push(...response.workflow_runs);
        if (response.workflow_runs.length < 100) break;
        page++;
      }
      return { runs, partial };
    });

    const completed = results.filter(r => r.status === 'completed');
    const failed = completed.filter(r => r.conclusion === 'failure');

    const detailed = await enrichRepeatFailureSteps(completed, { token });
    const repeatFailures = summarizeRepeatFailures(detailed);

    return {
      total: completed.length,
      failed: failed.length,
      succeeded: completed.filter(r => r.conclusion === 'success').length,
      failedRuns: failed.slice(0, 5).map(r => ({
        name: r.name,
        url: r.html_url,
        created: r.created_at,
      })),
      repeatFailures,
      skipped: false,
      partial,
    };
  } catch (err) {
    console.error(`[Workflows] API error: ${err.message}`);
    return { total: 0, failed: 0, succeeded: 0, failedRuns: [], repeatFailures: [], skipped: true, error: err.message };
  }
}

// A self-healed repeat-failure streak (result.selfHealed, set from
// isRepeatFailureSelfHealed() above) is not actionable — 2+ consecutive
// green runs since the last failure mean the condition already resolved
// itself. Without this override, the digest's urgency bucketing used only
// the static AUTO_FIX_PLAYBOOK entry (hardcoded 'fix-now' for every
// "Workflow repeat-failure:" check) regardless of selfHealed — only
// `status`/`message` were selfHealed-aware — so a provably-ended streak
// still filed a Linear card at fix-now urgency with the generic "likely
// broken, not a transient blip" hint (BRO-2742). Pure (no IO) — unit-tested
// in tests/unit/health-check-repeat-failures.test.mjs.
function effectiveUrgencyLevel(urgencyLevel, result) {
  if (result && result.selfHealed) return 'low';
  // BRO-4120: a row that says "this environment cannot see the input" (a
  // gitignored per-machine ledger read from CI) is never fixable from where
  // the digest runs, so it must never file a card or count as a warning.
  if (result && result.unmeasurable) return 'low';
  return urgencyLevel;
}

// Shared "is this result actionable (not low-urgency)" predicate — the exact
// filter getDigestSubject(), updateErrorFingerprint(), and the overall status
// banner each reimplemented inline from the static playbook alone. Routing
// them all through effectiveUrgencyLevel() keeps the subject line, the
// day-streak fingerprint, and the status banner consistent with the card-
// filing logic in sendEmailDigest: a selfHealed repeat-failure must not
// count toward "N warnings need attention" in one place while the digest
// body calls it "monitoring itself, no action needed" in another.
function isActionableResult(r) {
  if (r.unmeasurable) return false; // BRO-4120: see effectiveUrgencyLevel
  const entry = getPlaybookEntry(r.name);
  // No playbook entry at all → actionable by default (matches the three
  // inline predicates this replaced: `!entry || entry.urgency !== 'low'`).
  // Only checks WITH an entry get run through effectiveUrgencyLevel, so a
  // selfHealed result can only be downgraded when something already opted
  // it into a static urgency in the first place.
  if (!entry) return true;
  return effectiveUrgencyLevel(entry.urgency, r) !== 'low';
}

function repeatFailureResults(workflowSummary) {
  if (!workflowSummary || workflowSummary.skipped) return [];
  const repeats = workflowSummary.repeatFailures || [];
  return repeats.map(r => ({
    name: `Workflow repeat-failure: ${repeatFailureLabel(r)}`,
    // A provably-ended streak (2+ consecutive trailing greens) downgrades to
    // warn so an already-self-healed condition doesn't drive ACTION NEEDED
    // subjects or invite a Fix-this tap on a resolved streak.
    status: r.selfHealed ? 'warn' : (r.count >= 3 ? 'error' : 'warn'),
    message: `${repeatFailureLabel(r)} failed ${r.count} times in the last 24h`
      + (r.detailsUnavailable ? '; failed-step details unavailable, this count may combine different causes' : '')
      + (r.selfHealed
        ? ' — 2+ consecutive green runs since; likely self-healed, failures will age out of the window.'
        : ' — likely broken, not transient.'),
    hint: 'Open the latest run from the Repeat Workflow Failures section of the digest and fix the root cause.',
    // BRO-2742: must be carried through — effectiveUrgencyLevel()/
    // isActionableResult() key off this to keep urgency, subject line, and
    // card-filing consistent with the selfHealed-aware status/message above.
    // Without it, a self-healed streak still filed a fix-now Linear card.
    selfHealed: !!r.selfHealed,
  }));
}

// Open user-feedback issues that auto-fix punted on (label needs-manual-review).
// The owner deliberately unwatches the repo (process-feedback.yml suppresses
// GitHub notification emails), so these issues have NO notification channel at
// all — Kirsten Weiss's MISTERMAN report (GH #393) sat unseen for 9 days and
// 27 such issues had accumulated by 2026-07-12. The daily digest is the one
// place the owner reliably reads; surface the backlog there.
async function getOpenFeedbackReviewIssues() {
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) return { skipped: true, issues: [] };
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  try {
    const url = 'https://api.github.com/repos/thomaspryor/Broadwayscore/issues?labels=needs-manual-review&state=open&per_page=100';
    // Cached (shared across every concurrently-dispatched session on this Mac).
    const response = await cachedFetch('needs-manual-review-issues',
      () => fetchGitHubJSON(url, { token, caller: 'health-check.js', headers: { 'User-Agent': 'bsc-health-check' } }));
    if (!Array.isArray(response)) return { skipped: true, issues: [] };
    return {
      skipped: false,
      issues: response
        .filter(i => !i.pull_request)
        .map(i => ({ number: i.number, title: i.title, createdAt: i.created_at, url: i.html_url })),
    };
  } catch (err) {
    console.error(`[Feedback issues] API error: ${err.message}`);
    return { skipped: true, issues: [] };
  }
}

// Promote the needs-manual-review backlog into a first-class check result so it
// drives the digest subject line like every other warning. Pure (no IO) —
// unit-tested in tests/unit/health-check-repeat-failures.test.mjs.
// BRO-5164: a read that found nothing returns a same-name pass row (the only
// way health-row-probe.js can read a fixed row as 'absent'); a skipped or
// failed read returns [] so it can never verify a fix.
function feedbackBacklogResults(feedbackSummary, now = new Date()) {
  if (!feedbackSummary || feedbackSummary.skipped || !Array.isArray(feedbackSummary.issues)) return [];
  const issues = feedbackSummary.issues;
  if (issues.length === 0) {
    return [{ name: 'Feedback: needs-manual-review backlog', status: 'pass', message: 'No open user-feedback issues awaiting manual review' }];
  }
  const newest = [...issues].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  const oldest = [...issues].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
  const oldestDays = Math.floor((now - new Date(oldest.createdAt)) / 86400000);
  return [{
    name: 'Feedback: needs-manual-review backlog',
    status: 'warn',
    message: `${issues.length} open user-feedback issue(s) awaiting manual review (oldest ${oldestDays}d). Newest: #${newest.number} ${String(newest.title).substring(0, 70)}`,
    hint: 'gh issue list --label needs-manual-review — these have NO other notification channel (repo is unwatched by design).',
  }];
}

// Core check (BRO-5164): was gated behind `if (isCI)` in main(), so the live
// probe (computeCoreHealthResults only) could never see this row. Token-gated,
// cached and headroom-gated like checkMainRedStreak; no token, low headroom or
// an API error returns [].
async function checkFeedbackBacklog() {
  // Low headroom: do not spend API budget; [] reads as 'unknown', never a pass.
  if (hasLowHeadroom()) return [];
  const feedbackSummary = await getOpenFeedbackReviewIssues();
  if (!feedbackSummary.skipped) {
    console.log(`[Feedback issues] ${feedbackSummary.issues.length} open needs-manual-review issue(s)`);
  }
  return feedbackBacklogResults(feedbackSummary);
}

// Never-run workflow coverage (data/audit/workflow-run-coverage.json, written
// by audit-workflow-hygiene.js's advisory rule (f) — task #737). Surfaces
// registered workflows with a lifetime run count of zero (checkout/secrets/
// npm/script path never once exercised — the #657/#688 class) next to the
// repeat-failure rows above. Pure (no IO) — mirrors repeatFailureResults().
// Free disk on the machine that runs the local automation (2026-08-09).
//
// WHY THIS EXISTS: disk was NOT a monitored signal anywhere. On 2026-08-09 the
// volume sat at 100% (2.0Gi free of 460Gi) and nothing warned — there was no
// digest row, so it could not warn, escalate or page. The only disk logic in the
// repo was scripts/lib/disk-floor-check.sh, which reacts at MERGE time (too late)
// and only as a WARN line inside merge output nobody reads. Every merge that day
// burned minutes on an emergency GC; one took ~25 minutes.
//
// Thresholds are absolute GB, not percentages: what breaks is an operation
// needing N spare GB (a git merge, a next build, a Playwright install), and that
// need does not scale with volume size. 20GB warn gives days of headroom at the
// observed fill rate; 10GB error is roughly two merges from the 5GB floor that
// merge-worktree-to-main.sh already refuses to run under.
function diskSpaceResults(free, total) {
  const NAME = 'Infra: disk space';
  // UNPARSEABLE and ZERO must not share a branch (code-review finding, 2026-08-09).
  // Folding `free <= 0` in here meant a volume so full that `df -h` rounds Avail
  // to 0 — precisely the incident this row exists for — reported as a parse-failure
  // WARN instead of an ERROR. Only a non-finite reading is a parse failure; 0 is a
  // real, and maximally bad, measurement. Negative is impossible from df, so treat
  // it as unparseable.
  if (!Number.isFinite(free) || free < 0) {
    return [{
      name: NAME,
      status: 'warn',
      message: 'Could not read free disk space',
      hint: 'df parsing failed — check the df output shape on this machine.',
    }];
  }
  const pct = Number.isFinite(total) && total > 0 ? Math.round((1 - free / total) * 100) : null;
  const where = `${free}GB free${pct === null ? '' : ` (${pct}% used)`}`;
  if (free < 10) {
    return [{
      name: NAME,
      status: 'error',
      message: `${where} — below the 10GB floor; merges and builds will start failing`,
      hint: 'Reclaim now: git worktree list, drain finished worktrees (gc-merged-worktrees.sh), clear ~/Library/Developer/Xcode/DerivedData and node_modules/.next in stale worktrees.',
    }];
  }
  if (free < 20) {
    return [{
      name: NAME,
      status: 'warn',
      message: `${where} — under 20GB; merge-worktree-to-main.sh starts paying an emergency GC below 5GB`,
      hint: 'Drain finished worktrees before this reaches the floor — the usual source is abandoned dispatch worktrees holding unfinished work.',
    }];
  }
  return [{ name: NAME, status: 'ok', message: where }];
}

// Read free/total GB for the volume holding the repo. Pure `df` parse so it is
// testable; returns NaN on anything unexpected rather than guessing.
function readDiskSpace(dfOutput) {
  const line = String(dfOutput || '').trim().split('\n').pop() || '';
  const cols = line.split(/\s+/);
  const toGB = (v) => {
    const m = /^([\d.]+)([BKMGTPi]*)$/.exec(v || '');
    if (!m) return NaN;
    const n = parseFloat(m[1]);
    const unit = m[2].replace(/i$/, '');
    // 'B' (bytes) is included because a genuinely full volume prints Avail as
    // "0B" / "0Bi" — dropping it would send the worst possible reading down the
    // unparseable path (code-review finding, 2026-08-09). A bare number stays
    // NaN on purpose: this parser is only ever fed `df -h`, which always emits a
    // suffix, so a unitless value means the output is not what we think it is and
    // guessing the unit would risk reporting a full disk as healthy.
    const mult = { B: 1 / 1024 / 1024 / 1024, K: 1 / 1024 / 1024, M: 1 / 1024, G: 1, T: 1024, P: 1024 * 1024 }[unit];
    return mult === undefined ? NaN : Math.round(n * mult);
  };
  // df -h layout: Filesystem Size Used Avail Capacity ... Mounted
  return { total: toGB(cols[1]), free: toGB(cols[3]) };
}

// Called only with a report computed moments ago in main(), so an empty
// offender list is a clean run, never a stale one (BRO-5164 pass row). A
// workflow whose run count could not be read (unknownCount) is excluded from
// offenders, so a pass needs every count known and at least one checked.
function neverRunWorkflowResults(report) {
  if (!report || !Array.isArray(report.offenders)) return [];
  if (report.offenders.length === 0) {
    if (report.unknownCount !== 0 || !(report.totalChecked > 0)) return [];
    return [{ name: 'Workflow coverage: never-run', status: 'pass', message: `No never-run workflows among ${report.totalChecked != null ? report.totalChecked : '?'} checked` }];
  }
  const list = report.offenders.join(', ');
  return [{
    name: 'Workflow coverage: never-run',
    status: 'warn',
    message: `${report.offenders.length} workflow(s) registered on GitHub Actions with ZERO lifetime runs (>${report.minAgeDays}d old): ${list}`,
    hint: 'checkout/secrets/npm/script path never exercised — give each a dry_run smoke lane (see add-requested-show.yml) and dispatch once.',
  }];
}

// OB closing-date detector candidates (data/audit/ob-closing-candidates.json,
// committed weekly by detect-ob-closings.yml). The detector is alert-only by
// design; without a digest line its report is a JSON file nobody reads — the
// same silent-channel failure as the needs-manual-review backlog above.
//
// Named-first-in-array is not named-most-urgent: this used to always report
// candidates[0] (reviewTextSweep entries first, then todaytixStaleness),
// so a todaytixStaleness candidate sitting many weeks deep in the combined
// list never got named — only the generic count did. "Are You Now or Have
// You Ever Been" (closed 2026-08-02, announced early) sat in this backlog
// for 5 consecutive weekly runs (2026-08-03 -> 2026-08-31) behind
// candidates[0]='my-joy-is-heavy-off-broadway-2025' the entire time, and the
// digest message never changed enough to prompt someone to open the raw
// JSON. Fix: rank by age (todaytixStaleness carries firstMissingDate;
// reviewTextSweep entries have no age signal, so they sort last) and name
// the OLDEST candidate, escalating to 'error' once it's stale enough that a
// single weekly warn line has clearly already failed to get it actioned.
const { rankByAge } = require('./lib/backlog-digest-age');
const OB_CLOSING_AGED_DAYS_ERROR = 21; // ~3 missed weekly runs
// The report is a weekly snapshot, so it goes stale the moment a candidate is
// closed by hand or the next weekly run fails (BRO-4699: the 2026-10-05 run
// was cancelled and both named shows had already been closed in shows.json,
// so the digest kept flagging them for a week). With `shows` given, entries
// whose show is no longer open in the current shows.json are dropped, and the
// count is per show (one show can sit in both signals).
function obClosingBacklogResults(report, now = new Date(), shows = null) {
  if (!report || !report.reviewTextSweep) return [];
  // Only a show found in shows.json and no longer open is dropped: an empty or
  // partial list, or an id the data no longer has, keeps the row visible.
  const statusById = new Map((Array.isArray(shows) ? shows : []).filter(Boolean).map((s) => [s.id, s.status]));
  const stillOpen = (c) => !statusById.has(c.showId) || statusById.get(c.showId) === 'open';
  const candidates = [
    ...(report.reviewTextSweep.candidates || []),
    ...((report.todaytixStaleness && report.todaytixStaleness.candidates) || []),
  ].filter(stillOpen);
  // Open shows neither signal can watch (BRO-3086, Spellbound): listed even
  // when there are no candidates, or the blind spot stays a JSON-only fact.
  const blind = (report.unmonitoredOpenShows || []).filter(stillOpen);
  // BRO-3833: a report that was read and found nothing emits an explicit pass
  // row under each flaggable name, so a card targeting either row can verify
  // its own fix ('absent') via health-row-probe.js instead of reading
  // 'unknown' forever. An absent report still returns [] above (never a pass).
  const blindResult = blind.length ? [{
    name: 'Data: OB shows no closing signal can detect',
    status: 'warn',
    message: `${blind.length} open Off-Broadway show(s) have no TodayTix id, no review texts and no closingDate, so a closure would go unnoticed. Oldest: ${blind.reduce((a, b) => (b.daysOpen > a.daysOpen ? b : a)).showId}`,
    hint: 'Verify each on its venue/ticketing page; set closingDate (and status if closed) in shows.json (data repo), or add closingDate once announced.',
  }] : Array.isArray(report.unmonitoredOpenShows)
    ? [{ name: 'Data: OB shows no closing signal can detect', status: 'pass', message: 'Every open Off-Broadway show has a closing signal the detector can watch' }]
    : []; // older report without the field: this row was never computed, so no pass
  if (candidates.length === 0) {
    return [...blindResult, { name: 'Data: OB closing candidates awaiting review', status: 'pass', message: 'No open Off-Broadway show looks closed per the weekly detector' }];
  }

  const { oldest, ageDays, status } = rankByAge(candidates, 'firstMissingDate', OB_CLOSING_AGED_DAYS_ERROR, now);
  const label = oldest.proposedClosingDate
    ? `${oldest.showId} → ${oldest.proposedClosingDate} [${oldest.confidence}]`
    : `${oldest.showId}${ageDays != null ? ` (missing ${ageDays}d)` : ''}`;

  return [...blindResult, {
    name: 'Data: OB closing candidates awaiting review',
    status,
    message: `${new Set(candidates.map((c) => c.showId)).size} open Off-Broadway show(s) look closed per the weekly detector. Oldest: ${label}`,
    hint: 'Review data/audit/ob-closing-candidates.json; confirm evidence quotes, then set closingDate/status in shows.json (data repo).',
  }];
}

/**
 * National-tour automation (BRO-4262): what the unattended tour writers did or
 * could not do, from their own audit files. Pure: takes the parsed reports.
 * - a held sweep (it refused to move a flood of reviews) is an error: intake or
 *   a rule broke and tour reviews are stuck on a Broadway page;
 * - a date problem (schedule page unreadable, stored launch disagrees) is a warn;
 * - tours created automatically are reported so the owner sees them land.
 */
// How long each tour job may go without leaving a report before the digest
// says it has stopped. All three run daily (auto-create rides the daily BWW
// landing job since BRO-4325; it was weekly before).
const TOUR_JOB_MAX_AGE_HOURS = { sweep: 36, dates: 36, autocreate: 48 };
// Before this, a missing report just means the job hasn't had its first run.
const TOUR_JOBS_EXPECTED_FROM = '2026-10-06';

function tourAutomationResults({ sweep, dates, autocreate } = {}, now = new Date()) {
  const out = [];
  // BRO-3833: a pass row is a verification ('absent' in health-row-probe.js),
  // so it is only issued while all three reports are present and fresh. A
  // stale or missing report keeps the row but marks it "Skipped", which the
  // probe reads as 'unknown': the last clean report never verifies a fix
  // after its producer stopped writing.
  let allFresh = true;
  const pass = (name, message) => ({ name, status: 'pass',
    message: allFresh ? message : `Skipped (a tour job report is missing or stale): ${message}` });
  const jobs = [
    ['sweep', sweep, 'daily tour review mover (rebuild-reviews.yml)'],
    ['dates', dates, 'daily tour dates check (update-show-status.yml)'],
    ['autocreate', autocreate, 'daily new-tour check (scrape-new-aggregators.yml, BWW landing job)'],
  ];
  const quiet = [];
  for (const [key, report, label] of jobs) {
    const at = report && report.generatedAt ? new Date(report.generatedAt) : null;
    if (!at || Number.isNaN(at.getTime())) {
      allFresh = false;
      if (now.toISOString().slice(0, 10) >= TOUR_JOBS_EXPECTED_FROM) quiet.push(`${label}: no report yet`);
    } else {
      const hours = (now - at) / 3600000;
      if (hours > TOUR_JOB_MAX_AGE_HOURS[key]) allFresh = false;
      if (hours > TOUR_JOB_MAX_AGE_HOURS[key]) quiet.push(`${label}: last report ${Math.round(hours / 24)} day(s) ago`);
    }
  }
  if (quiet.length) {
    out.push({
      name: 'Data: tour automation stopped reporting',
      status: 'warn',
      message: `A national-tour job has not run on schedule: ${quiet.join('; ')}.`,
      hint: 'Check that workflow\'s recent runs; the step may be failing or the kill switch (TOUR_SWEEP / TOUR_DATES_MODE / TOUR_AUTOCREATE) set to off.',
    });
  } else if (allFresh) {
    // BRO-3833: pass rows only when the report each row reads was actually
    // present — a missing report never yields a pass (that would be a false
    // 'absent' in health-row-probe.js). Before TOUR_JOBS_EXPECTED_FROM a
    // missing report is not flagged, but it is not proof of health either.
    out.push(pass('Data: tour automation stopped reporting', 'All three national-tour jobs reported on schedule'));
  }
  const held = (sweep && sweep.held) || [];
  if (held.length) {
    out.push({
      name: 'Data: tour review sweep held',
      status: 'error',
      message: `The daily tour sweep refused to move reviews for ${held.join(', ')}: more than it should ever need to, so nothing was moved.`,
      hint: `Look at: node scripts/sweep-tour-reviews.js --tour=${held[0]} (dry run). If the moves are right, run it with --execute.`,
    });
  } else if (sweep) {
    out.push(pass('Data: tour review sweep held', 'The daily tour sweep held nothing back'));
  }
  const problems = ((dates && dates.tours) || []).filter(t => t.problem);
  if (problems.length) {
    out.push({
      name: 'Data: tour dates need a look',
      status: 'warn',
      message: `${problems.length} tour(s) could not be dated automatically: ${problems.map(p => `${p.id} (${p.problem})`).join('; ')}`,
      hint: 'See data/audit/tour-dates.json. A page that parses to nothing usually means Tours To You changed layout or the slug differs (set tourScheduleSlug on the entry).',
    });
  } else if (dates) {
    out.push(pass('Data: tour dates need a look', 'Every tour was dated automatically'));
  }
  // Running-tour discovery (BRO-4325) fails soft so roundups still get
  // created; this is where a Tours To You change shows up.
  const discovery = autocreate && autocreate.discovery;
  if (discovery && discovery.error) {
    out.push({
      name: 'Data: running-tour discovery failed',
      status: 'warn',
      message: `Finding national tours on Tours To You failed: ${discovery.error}. New running tours won't be added until it works again.`,
      hint: 'Run node scripts/discover-running-tours.js locally; the Tours To You pages API or page layout may have changed (scripts/lib/tour-discovery.js).',
    });
  } else if (discovery) {
    out.push(pass('Data: running-tour discovery failed', 'Running-tour discovery on Tours To You succeeded'));
  }
  // Every Broadway-titled Tours To You page should be read every couple of
  // days (BRO-4725); one that isn't is a tour that could appear late or never.
  const coverage = discovery && discovery.coverage;
  if (coverage && Object.keys(coverage).length) {
    const { stalePages, STALE_DAYS } = require('./lib/tours-to-you-coverage');
    const stale = stalePages(coverage, now);
    if (stale.length) {
      const total = Object.keys(coverage).length;
      out.push({
        name: 'Data: Tours To You pages not checked',
        status: 'warn',
        message: `${stale.length} of ${total} Tours To You show pages have not been read in over ${STALE_DAYS} days (${stale.slice(0, 8).map(r => r.slug).join(', ')}${stale.length > 8 ? ', ...' : ''}). A tour on one of them can't be added until it is.`,
        hint: 'See discovery in data/audit/tour-autocreate.json (rateLimited, failed). The daily BWW landing job reads the oldest pages first; repeated 429s mean Tours To You wants a slower pace (GAP_MS in scripts/lib/tours-to-you.js).',
      });
    } else {
      out.push(pass('Data: Tours To You pages not checked', `All ${Object.keys(coverage).length} Tours To You show pages read within ${STALE_DAYS} days`));
    }
  }
  const created = (autocreate && autocreate.created) || [];
  if (created.length) {
    out.push({
      name: 'Data: national tours added automatically',
      status: 'warn',
      message: `Added ${created.join(', ')} from BroadwayWorld tour roundups or Tours To You schedules (dates from Tours To You + Wikipedia).`,
      hint: 'Nothing to do unless one is wrong; see data/audit/tour-autocreate.json.',
    });
  } else if (autocreate) {
    out.push(pass('Data: national tours added automatically', 'No national tours added automatically this run'));
  }
  // A closed tour its page lists again (BRO-4724): reopened when the page's
  // history says it is the same tour, left closed when it can't tell.
  const reopened = (autocreate && autocreate.reopened) || [];
  if (reopened.length) {
    out.push({
      name: 'Data: closed national tours reopened automatically',
      status: 'warn',
      message: `Reopened ${reopened.join(', ')}: Tours To You lists new dates and its history names them as the same tour.`,
      hint: 'Nothing to do unless one is wrong; see lifecycle in data/audit/tour-autocreate.json.',
    });
  } else if (autocreate) {
    out.push(pass('Data: closed national tours reopened automatically', 'No closed national tours reopened'));
  }
  const undecided = (autocreate && autocreate.lifecycle && autocreate.lifecycle.undecided) || [];
  if (undecided.length) {
    out.push({
      name: 'Data: closed national tour lists new dates',
      status: 'warn',
      message: `${undecided.map(u => `${u.id} (closed ${u.closingDate}, listed again from ${u.resumes}: ${u.reason})`).join('; ')}. Left closed: the page doesn't say whether it is the same tour.`,
      hint: 'If it is the same tour, clear its closingDate; if a new one, it is created once the Tours To You history names it.',
    });
  } else if (autocreate) {
    out.push(pass('Data: closed national tour lists new dates', 'No closed national tour lists new dates'));
  }
  return out;
}

function checkTourAutomation() {
  const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, '../data/audit', f), 'utf8')); } catch { return null; } };
  return tourAutomationResults({ sweep: read('tour-sweep.json'), dates: read('tour-dates.json'), autocreate: read('tour-autocreate.json') });
}

// Reads data/audit/ob-closing-candidates.json off disk and surfaces it via
// obClosingBacklogResults. Pure local-file read — unlike feedbackBacklogResults
// (needs a live GitHub API call via getOpenFeedbackReviewIssues), this has no
// CI-only dependency, so it belongs in computeCoreHealthResults rather than
// gated behind `if (isCI)` in main(): that gate meant a card targeting this
// row could never confirm its own fix same-day, because
// scripts/lib/health-row-probe.js's live re-check only re-runs
// computeCoreHealthResults (task #799 — moved here so the live probe can see
// it, same file main() and the probe already share for exactly this reason).
function checkObClosingBacklog() {
  try {
    const obReport = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/audit/ob-closing-candidates.json'), 'utf8'));
    let shows = null;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/shows.json'), 'utf8'));
      shows = Array.isArray(raw) ? raw : raw.shows;
    } catch { /* no shows.json: report the snapshot as-is */ }
    return obClosingBacklogResults(obReport, new Date(), shows);
  } catch {
    return []; // report absent (detector not yet run) — nothing to surface
  }
}

// Cloud-memory mirror drift (BRO-5074). cloud-memory-reconcile.yml keeps
// cloud-memory/ current from claude-config every 6h and records in
// data/audit/cloud-memory-drift.json what still differs (cloud-written or
// cloud-edited notes the Mac's own sync has not picked up yet). A note
// waiting more than 48h means the Mac is not receiving what cloud sessions
// learn; a recorded error means the reconcile could not read claude-config.
// The workflow's own staleness is a DIGEST_CRONS row (health-digest-crons.js).
const CLOUD_MEMORY_DRIFT_MAX_HOURS = 48;
function cloudMemoryDriftResults(report, now = new Date()) {
  if (!report) return [];
  const out = [];
  if (report.error) {
    out.push({
      name: 'Memory: cloud mirror reconcile failing',
      status: 'warn',
      message: `cloud-memory/ is not being refreshed from claude-config: ${report.error}`,
      hint: 'Check the latest Cloud Memory Reconcile run; REVIEW_TEXTS_TOKEN must be able to read thomaspryor/claude-config.',
    });
  } else {
    // BRO-3833: explicit pass rows so a fixed drift can verify 'absent'.
    out.push({ name: 'Memory: cloud mirror reconcile failing', status: 'pass', message: 'cloud-memory/ reconcile read claude-config cleanly' });
  }
  // A failed reconcile could not compare against claude-config, so an empty
  // waitingForMac then proves nothing: no pass row for the second name.
  if (report.error) return out;
  const aged = (report.waitingForMac || [])
    .map((d) => ({ ...d, hours: (now - new Date(d.firstSeenAt)) / 36e5 }))
    .filter((d) => d.hours > CLOUD_MEMORY_DRIFT_MAX_HOURS)
    .sort((a, b) => b.hours - a.hours);
  if (aged.length) {
    out.push({
      name: 'Memory: cloud notes not reaching the Mac',
      status: 'warn',
      message: `${aged.length} cloud-memory note(s) differ from the Mac's memory for over ${CLOUD_MEMORY_DRIFT_MAX_HOURS}h. Oldest: ${aged[0].name} (${aged[0].reason}, ${Math.round(aged[0].hours)}h)`,
      hint: "The Mac's session-stop sync (scripts/sync-memory-to-repo.sh --commit from ~/Broadwayscore) is not adopting them; check that checkout is on main and can pull. List: data/audit/cloud-memory-drift.json.",
    });
  } else {
    out.push({ name: 'Memory: cloud notes not reaching the Mac', status: 'pass', message: `No cloud-memory note has waited more than ${CLOUD_MEMORY_DRIFT_MAX_HOURS}h for the Mac` });
  }
  return out;
}

function checkCloudMemoryDrift() {
  try {
    return cloudMemoryDriftResults(JSON.parse(fs.readFileSync(path.join(__dirname, '../data/audit/cloud-memory-drift.json'), 'utf8')));
  } catch {
    return []; // reconcile has not run yet
  }
}

// Daily-digest surfacing for reverse-discovery missing-show candidates
// (data/audit/reverse-discovery-candidates.json, written daily by
// audit-reverse-discovery.yml). This is the detector's ONLY human-facing
// channel — sendAlert in the CLI is log-only by alert-volume policy.
// Re-confirm a reverse-discovery candidate against LIVE shows.json before
// letting it escalate. The candidates report is up to 6h old and can name a
// show that has already been added (Mad King, 2026-09-10) — escalating that
// would be the false alarm that teaches everyone to ignore the row.
// Uses the detector's OWN matcher so the digest and the audit agree on what
// "missing" means; hand-rolled title matching gets this wrong (verified).
function buildStillMissingPredicate() {
  try {
    const { buildShowTitleIndex, resolveMatchedShowId } = require('./lib/reverse-discovery');
    const shows = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../data/shows.json'), 'utf8')
    ).shows;
    const nycIndex = buildShowTitleIndex(shows, 'nyc');
    const weIndex = buildShowTitleIndex(shows, 'we'); // 'we' is the market key; 'west-end' indexed every category
    const ukGuardian = require('./lib/uk-regional-guardian'); // uk-regional Guardian items (BRO-4923)
    const ukShows = ukGuardian.ukFlagshipShows(shows);
    const { bwwRoundupCataloguedElsewhere } = require('./lib/reverse-discovery');
    return (c) => {
      if (c && c.market === 'uk-regional') return !ukShows.some((s) => ukGuardian.isSameProduction(c, s));
      const index = c && c.market === 'west-end' ? weIndex : nycIndex;
      if (resolveMatchedShowId(c && c.title, index)) return false;
      // BWW files West End / tour roundups as 'nyc' (see the helper).
      if (c && c.source === 'bww-roundup' && bwwRoundupCataloguedElsewhere(c.title, shows, c.date)) return false;
      return true;
    };
  } catch {
    // shows.json unreadable — do not silence the backlog, just stop gating.
    return undefined;
  }
}

function reverseDiscoveryBacklogResults(report, state, now = new Date()) {
  const { rankReverseDiscoveryBacklog, describeCandidate, RD_AGED_DAYS_ERROR } =
    require('./lib/reverse-discovery-backlog');
  // Only REVIEWED shows belong on a row named "reviewed shows missing": the
  // nyt-theater openings calendar lists unreviewed fringe events (Eventbrite
  // pages, festivals) that kept this row permanently warning (BRO-4689). They
  // stay in the candidates JSON. Candidates already catalogued (stale report)
  // are dropped too, so the count is real.
  const { EVIDENCE_SOURCES } = require('./lib/reverse-discovery-backlog');
  const isStillMissing = buildStillMissingPredicate();
  const reviewed = ((report && report.candidates) || []).filter(
    (c) => c && EVIDENCE_SOURCES.has(c.source) && (!isStillMissing || isStillMissing(c)) &&
      // Candidates written before extractGuardianReview learned to drop
      // cross-tagged film/TV reviews stay in the report until the next audit run.
      !(c.source === 'guardian-review' && c.url && !/^https?:\/\/[^/]*theguardian\.com\/stage\//.test(c.url))
  );
  const ranked = rankReverseDiscoveryBacklog({
    candidates: reviewed,
    state,
    nowMs: now.getTime(),
    isStillMissing,
  });
  if (!ranked) {
    // An explicit pass row once the report exists, so a fixed backlog can
    // verify 'absent' (check-health-row-absent --live; BRO-3833 pattern).
    // No report, an undated one, or a stale one proves nothing: no row
    // (BRO-4689 review: a week-old empty report must not verify a fix).
    if (!report || !Array.isArray(report.candidates) || !Number.isFinite(Date.parse(report.generatedAt))) return [];
    const { checkReverseDiscoveryFreshness } = require('./lib/reverse-discovery-freshness');
    if (checkReverseDiscoveryFreshness(report, now.getTime())) return [];
    return [{ name: 'Data: reviewed shows missing from shows.json', status: 'pass', message: 'No aggregator-reviewed show is missing from the catalogue' }];
  }

  // Named-first-in-array is not named-most-urgent — the same lesson
  // obClosingBacklogResults learned. Rhinoceros sat 12 days behind an
  // unchanging "First: ..." line that read identically on day 1 and day 12.
  const aged = ranked.agedEvidence.length;
  const message =
    `${ranked.count} aggregator-reviewed show(s) not in the catalogue. ` +
    `Oldest: ${describeCandidate(ranked.oldest)}` +
    (aged
      ? ` — ${aged} review-backed candidate(s) past ${RD_AGED_DAYS_ERROR}d, so the daily promotion run has already had ${RD_AGED_DAYS_ERROR} chances at them.`
      : '');

  return [{
    name: 'Data: reviewed shows missing from shows.json',
    status: ranked.status,
    message,
    hint: 'Review data/audit/reverse-discovery-candidates.json; validate each via node scripts/validate-show-venue.js, then add per CLAUDE.md §3.',
  }];
}

// Freshness/backfill visibility for reverse-discovery (BRO-114): the audit's
// own state-diff design naturally "backfills" a missed run's window on the
// next run, EXCEPT when downtime exceeds BWW's ~5-day rolling window — that
// failure mode was previously silent (see scripts/lib/reverse-discovery-
// freshness.js for the full rationale). This surfaces it in the same daily
// digest as reverseDiscoveryBacklogResults, independent of candidate count
// (a stale-but-empty candidates file is exactly the dangerous case: it looks
// clean but may just not have run).
function reverseDiscoveryFreshnessResults(report, nowMs) {
  const { checkReverseDiscoveryFreshness } = require('./lib/reverse-discovery-freshness');
  const stale = checkReverseDiscoveryFreshness(report, nowMs);
  if (!stale) return [];
  return [{
    name: 'Data: BWW reverse-discovery audit stale',
    status: stale.severity,
    message: `reverse-discovery-candidates.json is ${stale.hoursStale.toFixed(1)}h old (audit-reverse-discovery.yml runs every 6h) — a delayed/skipped run risks missing a BWW roundup that rotates out of its ~5-day window before ever being seen.`,
    hint: 'Check audit-reverse-discovery.yml run history; dispatch manually if the cron is stuck: gh workflow run audit-reverse-discovery.yml. See docs/bww-reverse-discovery-backfill-visibility.md.',
  }];
}

// Freshness guard for data/audit/worktree-gc.log (BRO-2608) — see
// scripts/lib/worktree-gc-freshness.js for the incident this closes. This is
// the only automated brake on disk growth from abandoned worktrees; a
// silently-stopped log previously went five days unnoticed while disk fell
// from 88Gi to 26Gi free.
function worktreeGcFreshnessResults(lastLineTimestamp, nowMs) {
  const { checkWorktreeGcFreshness } = require('./lib/worktree-gc-freshness');
  const stale = checkWorktreeGcFreshness(lastLineTimestamp, nowMs);
  if (!stale) return [];
  return [{
    name: 'Infra: worktree GC log stale',
    status: stale.severity,
    message: `worktree-gc.log has no line in the last ${stale.hoursStale.toFixed(1)}h (launchd runs gc-merged-worktrees.sh hourly) — the only automatic disk brake may have stopped firing.`,
    hint: 'BRO-3635: a stopped StartInterval timer does not show up in `launchctl print` (job stays "loaded", last exit code 0) and running the script by hand only refreshes the log without fixing the schedule — reload the agent instead: launchctl bootout gui/$(id -u)/com.broadwayscore.worktree-gc 2>/dev/null; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.broadwayscore.worktree-gc.plist; launchctl kickstart -k gui/$(id -u)/com.broadwayscore.worktree-gc. Plist tracked at scripts/launchd/com.broadwayscore.worktree-gc.plist. BRO-2608.',
  }];
}

// Digest surfacing for data/audit/notion-schedule-coupling.json (BRO-3431
// reopen prevention requirement) — written by data-health-check.yml's
// "Notion-schedule-coupling audit (shadow mode)" step. Report-only, same
// non-blocking contract as every sibling shadow-mode sweep this function's
// neighbors surface: a finding here is a candidate for a human to look at
// (see the script's own NOTION_COUPLING_ALLOWLIST), not an accusation, and
// this check is what makes "is the Linear migration actually done" a
// digest line instead of a raw JSON file nobody reads.
function notionScheduleCouplingResults(snap) {
  const name = 'Infra: notion-schedule-coupling audit';
  if (!snap) {
    return [{ name, status: 'warn', message: 'No notion-schedule-coupling snapshot yet (cron not yet run)', hint: 'node scripts/audit-notion-schedule-coupling.js' }];
  }
  const age = snap.generatedAt ? hoursAgo(snap.generatedAt) : Infinity;
  if (age > 48) {
    return [{ name, status: 'error', message: `notion-schedule-coupling snapshot is ${formatAge(age)} old (>48h) — the daily sweep itself has stopped running`, hint: 'Check the "Notion-schedule-coupling audit (shadow mode)" step in data-health-check.yml' }];
  }
  const workflowFailed = snap.workflowHalf && snap.workflowHalf.ok === false;
  if (workflowFailed) {
    return [{ name, status: 'error', message: `Workflow-schedule scan itself failed: ${snap.workflowHalf.reason}`, hint: 'node scripts/audit-notion-schedule-coupling.js — investigate the scan failure, not just the finding count' }];
  }
  const total = snap.totalFindings || 0;
  if (total > 0) {
    return [{ name, status: 'warn', message: `${total} live schedule(s) still reference the frozen Notion mirror (${formatAge(age)} ago)`, hint: 'node scripts/audit-notion-schedule-coupling.js --dry-run to see which; port to Linear or add to NOTION_COUPLING_ALLOWLIST if intentional' }];
  }
  // BRO-5845: this snapshot comes from CI, where the launchd half cannot run;
  // say so instead of passing it off as a full-coverage clean result.
  const launchdNote = snap.launchdHalf && snap.launchdHalf.ok === false
    ? ' — GitHub workflow schedules only; Mac launchd agents not scanned on this host'
    : '';
  return [{ name, status: 'pass', message: `No live schedules coupled to the frozen Notion mirror (${formatAge(age)} ago)${launchdNote}` }];
}

// Daily-digest surfacing for uncollected-live-review strands (data/audit/
// uncollected-live-reviews.json, written hourly by
// audit-uncollected-live-reviews.js — card #1408). That script's own --alert
// flag already pages the totalBlackout case in real time via
// routeAlert(disposition:'auto'); this is the digest-only backstop for
// ordinary strands (a live show still has some coverage, just not every
// discovered URL fetched yet) so the backlog stays visible daily instead of
// silent between hourly runs. 'error' when any show is a total blackout — a
// live show with zero usable critic reviews on site at all, the exact shape
// that let The Winter's Tale and An American Daughter reach opening night
// uncollected on 2026-08-12 — else 'warn' for ordinary strands.
//
// BRO-5164: each name gets a pass row only while the report is fresh (the
// audit runs hourly; past UNCOLLECTED_STRAND_STALE_HOURS its last clean result
// proves nothing), so a fixed row reads 'absent' and a stale one 'unknown'.
const UNCOLLECTED_STRAND_STALE_HOURS = 26;
function uncollectedStrandResults(report, now = Date.now()) {
  if (!report || !Array.isArray(report.findings)) return [];
  const at = Date.parse(report.generatedAt);
  const fresh = Number.isFinite(at) && now - at <= UNCOLLECTED_STRAND_STALE_HOURS * 3600000;
  const blackouts = Array.isArray(report.blackoutShows) ? report.blackoutShows : null;
  const out = [];
  if (fresh && blackouts && blackouts.length === 0) {
    out.push({ name: 'Data: live show with zero critic reviews on site', status: 'pass', message: 'No live show is missing every discovered critic review' });
  }
  if (report.findings.length === 0) {
    if (fresh) out.push({ name: 'Data: uncollected live review strands', status: 'pass', message: 'Every discovered review URL for live shows was fetched' });
    return out;
  }
  const first = report.findings[0];
  if (blackouts && blackouts.length > 0) {
    return [{
      name: 'Data: live show with zero critic reviews on site',
      status: 'error',
      message: `${blackouts.length} live show(s) have discovered review URL(s) but NOTHING collected. First: ${blackouts[0]}`,
      hint: 'data/audit/uncollected-live-reviews.json has the per-outlet list. Recover: gh workflow run opening-night-express.yml -f show_id=<id> -f market=<market>.',
    }];
  }
  return [...out, {
    name: 'Data: uncollected live review strands',
    status: 'warn',
    message: `${report.strandedFiles} discovered review URL(s) across ${report.findings.length} live show(s) were never fetched. First: ${first.showId} (${first.stranded.length} stranded)`,
    hint: 'data/audit/uncollected-live-reviews.json has the per-outlet list. Recover: gh workflow run opening-night-express.yml -f show_id=<id> -f market=<market>.',
  }];
}

// BRO-5164: a tracked local-file read, so it is a core check the live probe can see.
function checkUncollectedStrands() {
  let report;
  try { report = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/audit/uncollected-live-reviews.json'), 'utf8')); } catch { return []; /* audit not yet run */ }
  return uncollectedStrandResults(report);
}

// Daily-digest surfacing for T1/T2 silent review gaps (data/audit/
// t1-silent-gaps.json, written hourly by audit-t1-silent-gaps.js). Real-time
// CRITICAL email only fires for gaps on near-opening shows; everything else
// lands here so the back-catalogue backlog is visible once a day instead of
// one email per discovery (2026-07-19 alert-volume fix).
// A review file discovered under SILENT_GAP_IN_FLIGHT_HOURS ago is still in
// flight (fetch, then the audit's own 12h scoring grace), not silent: BRO-5166
// found the row firing on files 0-30 minutes old. Ages from firstSeen, the
// immutable file-creation stamp, never gapSeenAt: that clock restarts whenever
// a gap clears for one audit run, so a flapping gap would hide forever.
// Fail open when unstamped.
const SILENT_GAP_IN_FLIGHT_HOURS = 24;
const { isFetchAbandonedAwaitingManual } = require('./lib/t1-silent-gap.js');
function silentGapBacklogResults(report, now = new Date()) {
  if (!report || !Array.isArray(report.gaps) || report.gaps.length === 0) return [];
  // BRO-6082: gaps with no automated path left (needsManualRecovery, stamped
  // by audit-t1-silent-gaps.js) reach the owner as the audit's FYI digest line.
  // Counting them here kept this row warn forever, and digest-autofix sent
  // cloud sessions that cannot reach a paywall or the Mac cookie jar.
  // BRO-6632: also gaps whose fetch is already abandoned and that nothing can
  // dispatch (isFetchAbandonedAwaitingManual), before the 7-day manual clock above elapses.
  // A dispatched session has nothing to run for them either; they join the FYI
  // line when the clock does. Without this the row fired on day one.
  const automatable = report.gaps.filter((g) => g.needsManualRecovery !== true && !isFetchAbandonedAwaitingManual(g));
  const gaps = automatable.filter((g) => {
    const seen = Date.parse(g.firstSeen || '');
    return Number.isNaN(seen) || now.getTime() - seen >= SILENT_GAP_IN_FLIGHT_HOURS * 3600000;
  });
  if (gaps.length === 0) return [];
  const inFlight = automatable.length - gaps.length;
  const t1 = gaps.filter((g) => g.tier === 1).length;
  // Rank by firstSeen (how long the gap has gone unactioned), not openingDate:
  // most back-catalogue shows opened long ago, so show age would page on day one.
  const { oldest, status } = rankByAge(gaps, 'firstSeen', 21, now);
  return [{
    name: 'Data: T1/T2 silent review gaps',
    status,
    message: `${gaps.length} discovered review(s) not reaching the composite score (${t1} T1). Oldest: ${oldest.showId} — ${oldest.outletId} (${oldest.type})${inFlight ? `; ${inFlight} newer still in flight` : ''}`,
    hint: 'Each entry in data/audit/t1-silent-gaps.json carries its fix command (run locally — cookie jar). Sweep card: Silent-gap 120d sweep remainder.',
  }];
}

// Daily-digest surfacing for undispatchable backlog cards (data/audit/
// card-verifiability-linear.json, written by audit-card-verifiability.js
// --source linear — task #646, BRO-3619). A card with no runnable
// acceptance-criteria command is refused by the dispatcher, but that refusal
// has no channel of its own, so a card can sit stuck indefinitely with nobody
// noticing. enrich-card-acceptance.js is the fix; these warn rows are the
// visibility. BRO-4717 retired the Notion-board twin of these rows (it read
// card-verifiability.json, regenerated daily from the frozen Notion mirror);
// only the Linear report is read now.
const LINEAR_VERIFIABILITY_STALE_MS = 3 * 24 * 60 * 60 * 1000; // the audit runs daily; 3 days means it stopped
const { ownerJudgmentLimboResults } = require('./lib/owner-judgment-limbo-guard.js');

// BRO-5164: a report count that can back a pass row: a real number (or a
// numeric string), never null/''/[]/{} that the ||0 coercions turn into 0.
function isCountValue(v) {
  return (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(Number(v));
}

const COVERAGE_HOLES_STALE_MS = 3 * 24 * 60 * 60 * 1000; // audit-coverage-holes.js runs daily in data-health-check.yml

/**
 * BRO-4861: surface the daily coverage-holes audit (classes A-D) in the digest.
 * Advisory: warn only. A published blocked-URL review (D) is the one live harm.
 */
function coverageHolesResults(report, now = Date.now()) {
  if (!report || typeof report !== 'object' || !report.counts) return [];
  const c = report.counts;
  const t = (k) => (c[k] && Number(c[k].total)) || 0;
  const unexplained = (k) => Math.max(0, t(k) - ((c[k] && Number(c[k].explained)) || 0));
  const at = Date.parse(report.generatedAt);
  const out = [];
  const total = unexplained('A') + unexplained('B') + unexplained('C') + ((c.D && Number(c.D.published)) || 0);
  if (total > 0) {
    out.push({
      name: 'Data: review coverage holes',
      status: 'warn',
      message: `${t('A')} review(s) with no usable text, ${t('B')} rejected although verified as a review, ${t('C')} never scored, ${t('D')} with a blocked URL (${(c.D && c.D.published) || 0} published on the site), across ${report.shows != null ? report.shows : '?'} current shows`,
      hint: 'node scripts/audit-coverage-holes.js --list=B (or A, C, D) prints the rows; fix them via data/pending-fixes (BRO-4838, BRO-4849).',
    });
  }
  const fresh = Number.isFinite(at) && now - at <= COVERAGE_HOLES_STALE_MS;
  // BRO-5164: a fresh clean report is the pass row a fixed card verifies against.
  // Every field coerced with ||0 above must be a real number, or a 0 is a guess.
  const num = isCountValue;
  const allClasses = ['A', 'B', 'C'].every((k) => c[k] && num(c[k].total) && num(c[k].explained))
    && !!c.D && num(c.D.total) && num(c.D.published);
  if (total === 0 && fresh && allClasses) {
    out.push({ name: 'Data: review coverage holes', status: 'pass', message: `No unexplained coverage holes across ${report.shows != null ? report.shows : '?'} current shows` });
  }
  if (!fresh) {
    out.push({
      name: 'Data: review coverage holes',
      status: 'warn',
      message: 'data/audit/coverage-holes.json is missing a readable generatedAt or is more than 3 days old',
      hint: 'data-health-check.yml refreshes it daily (its "Coverage holes on current shows" step); check that workflow\'s last runs.',
    });
  }
  return out;
}

const STAR_BAND_DRIFT_STALE_MS = 3 * 24 * 60 * 60 * 1000; // audit-star-band-drift.js runs daily in data-health-check.yml

/**
 * BRO-4840: surface the daily published-score audit in the digest. A review whose PUBLISHED score contradicts the
 * critic's own rating is the live harm (a printed 2/5 shown as 91). Warn only; the audit step itself runs --strict.
 */
function starBandDriftResults(report, now = Date.now()) {
  if (!report || typeof report !== 'object') return [];
  const out = [];
  const n = Number(report.publishedOutOfBand) || 0;
  if (n > 0) {
    out.push({
      name: 'Data: published scores outside the critic\'s rating',
      status: 'warn',
      message: `${n} published review score(s) contradict the critic's own rating or every model's verdict (${Number(report.queuedForRescore) || 0} more already queued for rescore), of ${report.publishedJoined != null ? report.publishedJoined : '?'} checked`,
      hint: 'node scripts/audit-star-band-drift.js --json=/tmp/drift.json lists the rows (publishedOutOfBand); rebuild-reviews clamps model scores into band, so what remains is a human override, an adjudication or a wrong stored rating (BRO-4840).',
    });
  }
  const at = Date.parse(report.generatedAt);
  const fresh = Number.isFinite(at) && now - at <= STAR_BAND_DRIFT_STALE_MS;
  // BRO-5164: same-name pass row from a fresh clean report only.
  if (n === 0 && fresh && isCountValue(report.publishedOutOfBand)) {
    out.push({ name: 'Data: published scores outside the critic\'s rating', status: 'pass', message: `No published review score contradicts the critic's rating (${report.publishedJoined != null ? report.publishedJoined : '?'} checked)` });
  }
  if (!fresh) {
    out.push({
      name: 'Data: published scores outside the critic\'s rating',
      status: 'warn',
      message: 'data/audit/star-band-drift.json is missing a readable generatedAt or is more than 3 days old',
      hint: 'data-health-check.yml refreshes it daily (its "Published score star-band audit" step); check that workflow\'s last runs.',
    });
  }
  return out;
}

const EARLY_PUBLISH_DATES_STALE_MS = 3 * 24 * 60 * 60 * 1000; // audit-early-unmarked-publish-dates.js runs daily in data-health-check.yml

/**
 * BRO-5769: early or carried publish dates still awaiting the page-date recheck. backfill-review-dates.yml sweeps
 * them weekly; a count above the audit's own --max means the sweep is not keeping up (or its ingest sources are
 * writing faster than it clears).
 */
function earlyPublishDatesResults(report, now = Date.now()) {
  if (!report || typeof report !== 'object') return [];
  const name = 'Data: early publish dates awaiting page-date recheck';
  const out = [];
  const n = Number(report.awaiting) || 0;
  const max = isCountValue(report.max) ? report.max : 40;
  const at = Date.parse(report.generatedAt);
  const fresh = Number.isFinite(at) && now - at <= EARLY_PUBLISH_DATES_STALE_MS;
  if (n > max) {
    out.push({
      name,
      status: 'warn',
      message: `${n} review(s) carry an early or carried publish date no page read has confirmed (limit ${max}; ${Number(report.attempted) || 0} more already attempted)`,
      hint: 'node scripts/audit-early-unmarked-publish-dates.js lists counts by ingest source; backfill-review-dates.yml (weekly, recheck_dates) clears them (BRO-5769).',
    });
  } else if (fresh && isCountValue(report.awaiting)) {
    out.push({ name, status: 'pass', message: `${n} early publish date(s) awaiting recheck (limit ${max}); ${Number(report.attempted) || 0} already attempted and not yet confirmed` });
  }
  if (!fresh) {
    out.push({
      name,
      status: 'warn',
      message: 'data/audit/early-publish-dates.json is missing a readable generatedAt or is more than 3 days old',
      hint: 'data-health-check.yml refreshes it daily (its "Early publish date audit" step); check that workflow\'s last runs.',
    });
  }
  return out;
}

function cardVerifiabilityBacklogResults(drainMetric, linearReport, now = Date.now()) {
  const results = [];
  // BRO-5164: pass rows only from a fresh Linear report whose bucket was
  // actually written; a missing, stale or older-shape report never verifies.
  const linearAt = linearReport && typeof linearReport === 'object' ? Date.parse(linearReport.generatedAt) : NaN;
  const linearFresh = Number.isFinite(linearAt) && now - linearAt <= LINEAR_VERIFIABILITY_STALE_MS;
  // An empty sweep (no cards read) cannot vouch that the buckets are clean.
  const linearSwept = linearFresh && isCountValue(linearReport.total) && Number(linearReport.total) > 0;
  // BRO-3619: the armed-but-vacuous bucket (a `test -f` on a file already on main passes before any work is done).
  const vacuous = linearReport && Array.isArray(linearReport.vacuousChecks) ? linearReport.vacuousChecks : [];
  if (vacuous.length === 0 && linearSwept && Array.isArray(linearReport.vacuousChecks)) {
    results.push({ name: 'Data: armed-but-vacuous backlog cards', status: 'pass', message: 'No Linear card carries an acceptance check that cannot tell done from not done' });
  }
  if (vacuous.length > 0) {
    const neverFails = vacuous.filter((c) => c.polarity === 'never-fails').length;
    const neverPasses = vacuous.filter((c) => c.polarity === 'never-passes').length;
    const first = vacuous[0];
    results.push({
      name: 'Data: armed-but-vacuous backlog cards',
      status: 'warn',
      message: `${vacuous.length} Linear card(s) carry an acceptance check that cannot tell done from not done (${neverFails} can never fail, ${neverPasses} can never pass). First: ${first.id || '?'} ${first.name || ''}`.trim(),
      hint: 'node scripts/enrich-card-acceptance.js --source linear --rearm --dry-run shows the rewrite; drop --dry-run to apply (BRO-3395).',
    });
  }
  if (linearReport && typeof linearReport === 'object') {
    const refusedL = Array.isArray(linearReport.refused) ? linearReport.refused : [];
    if (refusedL.length === 0 && linearSwept && Array.isArray(linearReport.refused)) {
      results.push({ name: 'Data: undispatchable Linear backlog cards', status: 'pass', message: `All ${linearReport.total != null ? linearReport.total : '?'} open Linear card(s) have a runnable acceptance-criteria command` });
    }
    if (refusedL.length > 0) {
      const f = refusedL[0];
      results.push({
        name: 'Data: undispatchable Linear backlog cards',
        status: 'warn',
        message: `${refusedL.length} of ${linearReport.total != null ? linearReport.total : "?"} open Linear card(s) have no runnable acceptance-criteria command (workers would skip them). First: [${f.priority || '?'}] ${f.id || ''} ${f.name || ''}`.trim(),
        hint: 'node scripts/enrich-card-acceptance.js --source linear drafts missing criteria; re-run node scripts/audit-card-verifiability.js --source linear after to confirm.',
      });
    }
    const at = linearAt;
    if (linearFresh) {
      results.push({ name: 'Data: Linear card-verifiability report stale', status: 'pass', message: `data/audit/card-verifiability-linear.json generated ${new Date(at).toISOString().slice(0, 10)}` });
    } else {
      results.push({
        name: 'Data: Linear card-verifiability report stale',
        status: 'warn',
        message: Number.isFinite(at) ? `data/audit/card-verifiability-linear.json was generated ${new Date(at).toISOString().slice(0, 10)}, more than 3 days ago` : 'data/audit/card-verifiability-linear.json has no readable generatedAt',
        hint: 'card-verifiability-audit.yml refreshes it daily (its "Audit Linear cards" step); check that workflow\'s last runs.',
      });
    }
  }
  // Task #1004's sibling bucket: cards the drain scanned and skipped because an
  // UNATTENDED session structurally cannot finish them (owner visual-qa
  // approval, an owner decision, a completion deferred past the session). The
  // classifier writes humanGatedSkips into the drain metric; without this row
  // that field is write-only and a MISCLASSIFIED card would be skipped silently
  // on every tick forever, its only trace a launchd log nobody reads — the exact
  // #689/#690 write-only class.
  const gated = (drainMetric && Array.isArray(drainMetric.humanGatedSkips)) ? drainMetric.humanGatedSkips : [];
  if (gated.length > 0) {
    const codes = [...new Set(gated.flatMap(g => g.codes || []))].join(', ');
    results.push({
      name: 'Data: cards the drain cannot finish unattended',
      status: 'warn',
      message: `backlog-drain skipped ${gated.length} card(s) needing a human to finish (#${gated.map(g => g.id).join(', #')}) — blockers: ${codes || 'unspecified'}. These will never drain headlessly.`,
      hint: 'Dispatch them to a cmux tab (node scripts/bsc-next.js --id <n>, no --headless) where you can clear the gate. If a card is MISCLASSIFIED, check it against node scripts/lib/headless-dispatchability.js --subject="..." --notes="..." and fix the classifier, not the card.',
    });
  }
  return results;
}

// BRO-5164: the daily audit reports below are tracked local files (the drain
// metric is a Mac-local extra), so they are core checks the live probe can see
// rather than rows gated behind `if (isCI)` in main().
function readAuditJsonOrNull(file) {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '../data/audit', file), 'utf8')); } catch { return null; }
}
function checkCardVerifiabilityBacklog() {
  const cvLinear = readAuditJsonOrNull('card-verifiability-linear.json');
  const drainMetric = readAuditJsonOrNull('backlog-drain-metric.json');
  return [
    ...cardVerifiabilityBacklogResults(drainMetric, cvLinear),
    ...ownerJudgmentLimboResults(cvLinear),
  ];
}
function checkCoverageHoles() {
  const report = readAuditJsonOrNull('coverage-holes.json');
  return report ? coverageHolesResults(report) : [];
}
// BRO-5510: corpus audits for the BRO-5501 class (a wrong twin's content flag
// dropping a good review). `runs` are the audit scripts' exit status and
// stdout; a red audit becomes a digest row because a continue-on-error step
// reaches nobody. Pure so tests can feed it.
function corpusAuditResults(runs) {
  const out = [];
  const dup = runs && runs.duplicateFlag;
  const NAME = 'Data: duplicate-flag leaks (a wrong twin dropping a good review)';
  if (dup) {
    if (dup.status === 0) {
      out.push({ name: NAME, status: 'pass', message: 'duplicate-flag inheritance audit is within its committed floor' });
    } else {
      const line = String(dup.output || '').split('\n').find((l) => /Found \d+ live|regressed|corpus/i.test(l)) || 'audit exited non-zero';
      out.push({
        name: NAME,
        status: 'warn',
        message: `scripts/audit-duplicate-flag-inheritance.js failed: ${line.trim().slice(0, 200)}`,
        hint: 'node scripts/cloud-run-script.js --review-texts scripts/audit-duplicate-flag-inheritance.js lists the files; see BRO-5501 for the cause and fix.',
      });
    }
  }
  const sq = runs && runs.squatters;
  const SQ = 'Data: stale-slot squatters (current-year review slots held by another production)';
  if (sq) {
    let count = null;
    try { count = JSON.parse(sq.output).count; } catch { /* unreadable: fall through */ }
    // 587 findings on 2026-10-19 are almost all correct exclusions of earlier productions (the 2026 article does not exist yet), so a count alone must not warn; the row exists so the audit demonstrably ran, and a failed run warns.
    if (sq.status === 0 && Number.isInteger(count)) {
      out.push({ name: SQ, status: 'pass', message: `audit ran: ${count} candidate slot(s) in current-year shows (mostly correct exclusions; node scripts/audit-stale-slot-squatters.js lists them)` });
    } else {
      out.push({ name: SQ, status: 'warn', message: 'scripts/audit-stale-slot-squatters.js did not produce a readable result', hint: 'check the corpus checkout in data-health-check.yml.' });
    }
  }
  return out;
}
function runCorpusAudit(script, args) {
  const r = require('child_process').spawnSync(process.execPath, [path.join(__dirname, script), ...args], { encoding: 'utf8', timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status === null ? 1 : r.status, output: `${r.stdout || ''}${r.stderr || ''}` };
}
function checkCorpusAudits() {
  if (!fs.existsSync(path.join(__dirname, '..', 'data', 'review-texts'))) return [];
  return corpusAuditResults({
    duplicateFlag: runCorpusAudit('audit-duplicate-flag-inheritance.js', []),
    squatters: runCorpusAudit('audit-stale-slot-squatters.js', ['--json']),
  });
}
function checkStarBandDrift() {
  const report = readAuditJsonOrNull('star-band-drift.json');
  return report ? starBandDriftResults(report) : [];
}

function checkEarlyPublishDates() {
  const report = readAuditJsonOrNull('early-publish-dates.json');
  return report ? earlyPublishDatesResults(report) : [];
}

// Daily-digest surfacing for stalled pipeline surfaces (data/audit/
// progress-watch-state.json, written by check-progress-stalls.js — task
// #597). Existing audits (repeatFailureResults et al above) only ever assert
// a SAFETY property (present / under threshold); this is the one LIVENESS
// check — has a registered counter actually moved across recent runs, not
// just stayed within bounds. A queue depth pinned at the same number for
// days passes every other check in this file.
function progressWatchResults(report) {
  if (!report || !report.surfaces) return [];
  const stalled = Object.values(report.surfaces).filter((s) => s.stalled);
  if (stalled.length === 0) return [];
  // report.lastSummary carries whatever extra context a surface's loadData()
  // returned beyond the tracked value itself (e.g. check-progress-stalls.js's
  // raw/notScoreable/blocked breakdown, task #751) — surfaced generically
  // here rather than as named fields so this function stays metric-agnostic
  // as new monitors attach their own context shapes (task #761). Guarded:
  // lastSummary is producer-supplied and unvalidated, so a JSON.stringify
  // failure (circular ref, BigInt) must not take down the whole alert — the
  // caller's try/catch would otherwise swallow value/cycles/hint too, silently
  // disabling the file's one liveness check (adversarial review, task #761).
  let context = '';
  if (report.lastSummary) {
    try {
      const serialized = JSON.stringify(report.lastSummary);
      context = ` Context: ${serialized.length > 500 ? `${serialized.slice(0, 500)}…` : serialized}`;
    } catch { /* unserializable lastSummary — omit context, don't drop the alert */ }
  }
  return stalled.map((s) => ({
    name: `Progress watch: ${s.label} stalled`,
    status: 'warn',
    message: `${s.label} is at ${s.value} and hasn't moved in ${s.cycles} consecutive check(s).${context}`,
    hint: s.hint || 'Investigate whether the producer/consumer for this surface is actually running.',
  }));
}

// Daily-digest surfacing for BWW-roundup discovery misses near opening (task
// #692). data/audit/bww-roundup-miss-ledger.jsonl (Scraping v2 Sprint 1 T6)
// is append-only and, until now, had exactly one reader — the write path's
// own cooldown check. A show that keeps missing discovery INSIDE its
// opening-window (where the miss-cooldown deliberately never suppresses
// retries — see OPENING_WINDOW_DAYS in bww-roundup-persistence.js) is
// worth a look after the first reviews land. Until then a missing roundup
// is expected, including on opening morning (CLAUDE.md rule 14).
function bwwRoundupMissBacklogResults(summary, now = new Date()) {
  if (!summary || summary.length === 0) return [];
  const { oldest, status } = rankByAge(summary, 'lastMissTs', 21, now);
  return [{
    name: 'Data: BWW roundup discovery misses near opening',
    status,
    message: `${summary.length} show(s) with 2+ BWW-roundup discovery misses in the trailing 48h, inside their opening window. Oldest: ${oldest.showId} (${oldest.missCount} misses, last ${oldest.lastMissTs}).`,
    hint: 'Check data/audit/bww-roundup-miss-ledger.jsonl. Per CLAUDE.md rule 14, a pre-opening 404 is normal — confirm the roundup genuinely hasn\'t published before treating this as a discovery bug.',
  }];
}

// task #707 telemetry, widened to fleet scale by task #1847 (2026-08-20):
// info-only — the fallback firing is EXPECTED and healthy under real
// contention, not a problem. This exists so the owner can tell "fallback
// fixed an occasional race" (a few entries, a handful of workflows) from
// "normal pushes are now always exhausting first" (most/all attempts, a
// concentrated set of workflows) now that eligibility defaults ON for
// ~130 callers instead of 2 opt-in canaries (weekly-grosses.yml,
// outlet-registry-baseline-maintenance.yml — both since had their
// PUSH_VIA_API_FALLBACK opt-in stripped as redundant). `workflow: ''`
// (rendered '(unknown workflow)' below) is a local/headless caller.
function pushFallbackUsageResults(entries) {
  if (!entries || entries.length === 0) return [];
  const byWorkflow = new Map();
  for (const e of entries) {
    const key = e.workflow || '(unknown workflow)';
    byWorkflow.set(key, (byWorkflow.get(key) || 0) + 1);
  }
  const parts = [...byWorkflow.entries()].map(([wf, n]) => `${wf}: ${n}`).join(', ');
  return [{
    // 'pass' (not 'error'/'warn' — those are the only two the digest
    // renders as alarming lines; this is expected/healthy telemetry, not
    // something to flag). Ship-check finding (2026-08-16, still true at
    // fleet scale): the rendered digest table only ever shows a category's
    // PASSED/TOTAL count, never an individual pass-status check's message —
    // so this row surfaces as its own named "Push" category line but the
    // per-workflow breakdown in `message` only reaches someone who reads
    // data/audit/health-*-snapshot.json directly. A real digest section
    // showing the per-workflow breakdown would be more valuable now that
    // this is fleet-wide telemetry rather than a 2-canary sample — flagged
    // as a follow-up, not built here (out of scope for the eligibility
    // flip itself).
    name: 'Push: Git Data API fallback usage (24h)',
    status: 'pass',
    message: `${entries.length} push(es) landed via the API fallback instead of a normal local push in the last 24h — ${parts}.`,
    hint: 'Expected now that the fallback defaults on fleet-wide (task #1847). A sudden jump, or a jump concentrated on one workflow, means contention got materially worse there — check data/audit/*.json glob scope (reconcile-merged-json.js MANAGED list), or set PUSH_API_FALLBACK_DISABLE=1 for that caller if it needs to opt back out.',
  }];
}

// --- Email Digest ---

/**
 * Subject line spec:
 *   Green: 0 errors, <=2 warnings → "BSC Daily: All clear (27/27 passed)"
 *   Yellow: 1+ warnings OR 1-2 errors → "BSC Daily: 2 warnings — [first warning name]"
 *   Red: 3+ errors OR any error 2+ consecutive days → "BSC Daily: ACTION NEEDED — [first error name]"
 */
// Fingerprint of the actionable, un-auto-fixed error set — the unit of "is this
// the same bad news as yesterday". Sorted names only (not messages) so a count
// drifting inside one check doesn't read as new news, but a NEW failing check or
// a recovery always changes the print.
function errorSetFingerprint(unfixedErrors) {
  return unfixedErrors.map(r => r.name).sort().join('|');
}

// Escalation milestones: an UNCHANGED error set screams on day 1 (implicit —
// it's new), day 3, day 7, then weekly. Every other day it rides the calm
// daily subject. This is what makes "BSC URGENT (day 6)" AND "(day 7)" on
// consecutive mornings structurally impossible (owner escalation 2026-07-25:
// 7 straight URGENT days for the same unresolved set).
function isEscalationDay(days) {
  return days === 3 || days === 7 || (days > 7 && (days - 7) % 7 === 0);
}

// BRO-3444: URGENT is kept for errors a site visitor could notice
// (lib/digest-audience.js). The escalation milestones alone let an
// internal-only set that changed daily say URGENT for 61 straight days.
function getDigestSubject(results, history, autoFixResults) {
  const errors = results.filter(r => r.status === 'error');
  const warns = results.filter(r => r.status === 'warn');
  const total = results.length;
  const passed = results.filter(r => r.status === 'pass').length;
  const fixMap = autoFixResults || {};

  // Only count items that are NOT auto-fixed AND are actionable (not LOW priority)
  const unfixedErrors = errors.filter(r => !fixMap[r.name]?.fixed && isActionableResult(r));
  const unfixedWarns = warns.filter(r => !fixMap[r.name]?.fixed && isActionableResult(r));
  const autoFixedCount = Object.values(fixMap).filter(f => f.fixed).length;

  const days = history.consecutiveErrorDays || 0;
  const sameSetAsYesterday = unfixedErrors.length > 0
    && history.lastErrorFingerprint === errorSetFingerprint(unfixedErrors);

  if (unfixedErrors.length > 0 && days >= 5) {
    const visitorErrors = unfixedErrors.filter(r => classifyHealthCheck(r) === 'visitors');
    if (visitorErrors.length === 0) {
      return `BSC Daily: ${unfixedErrors.length} internal issue${unfixedErrors.length > 1 ? 's' : ''}, no visitor-facing errors (day ${days})`;
    }
    // "New news" is judged on the visitor-facing errors alone, so internal
    // rows churning daily cannot re-trigger URGENT on a stable visitor set.
    // History written before this field existed falls back to the full set.
    const sameVisitorSet = history.lastVisitorErrorFingerprint === undefined
      ? sameSetAsYesterday
      : history.lastVisitorErrorFingerprint === errorSetFingerprint(visitorErrors);
    if (!sameVisitorSet || isEscalationDay(days)) {
      return `BSC URGENT (day ${days}): ${unfixedErrors.length} unresolved error${unfixedErrors.length > 1 ? 's' : ''}`;
    }
    // Same unresolved set, non-milestone day: calm subject, no repeat scream.
    return `BSC Daily: ${unfixedErrors.length} known issue${unfixedErrors.length > 1 ? 's' : ''} (unchanged, day ${days})`;
  }
  if (unfixedErrors.length >= 3 || (unfixedErrors.length > 0 && days >= 2)) {
    if (sameSetAsYesterday && days >= 2 && !isEscalationDay(days)) {
      return `BSC Daily: ${unfixedErrors.length} known issue${unfixedErrors.length > 1 ? 's' : ''} (unchanged, day ${days})`;
    }
    const first = unfixedErrors[0]?.name || 'unknown';
    return `BSC Daily: ACTION NEEDED — ${first}`;
  }
  if (unfixedErrors.length > 0) {
    return `BSC Daily: ${unfixedErrors.length} error${unfixedErrors.length > 1 ? 's' : ''} need attention`;
  }
  if (unfixedWarns.length > 0) {
    const autoNote = autoFixedCount > 0 ? ` (${autoFixedCount} auto-fixed)` : '';
    return `BSC Daily: ${unfixedWarns.length} warning${unfixedWarns.length > 1 ? 's' : ''}${autoNote}`;
  }
  if (autoFixedCount > 0) {
    return `BSC Daily: All clear — ${autoFixedCount} issue${autoFixedCount > 1 ? 's' : ''} auto-fixed`;
  }
  return `BSC Daily: All clear (${passed}/${total} passed)`;
}

// Post-digest: persist today's unfixed-actionable error set so tomorrow's
// subject can tell "unchanged" from "new/worse/recovered". Mirrors the exact
// filter getDigestSubject applies (auto-fixed and low-urgency excluded).
function updateErrorFingerprint(history, results, autoFixResults) {
  const fixMap = autoFixResults || {};
  const unfixedErrors = results.filter(r => r.status === 'error' && !fixMap[r.name]?.fixed && isActionableResult(r));
  history.lastErrorFingerprint = unfixedErrors.length ? errorSetFingerprint(unfixedErrors) : '';
  const visitorErrors = unfixedErrors.filter(r => classifyHealthCheck(r) === 'visitors');
  history.lastVisitorErrorFingerprint = visitorErrors.length ? errorSetFingerprint(visitorErrors) : '';
  return history;
}

function getStatusColor(status) {
  return status === 'pass' ? '#2ecc71' : status === 'warn' ? '#f39c12' : '#e74c3c';
}

function getStatusIcon(status) {
  return status === 'pass' ? '&#9989;' : status === 'warn' ? '&#9888;&#65039;' : '&#10060;';
}

function purgeOldExclusionLogs(retentionDays = 30) {
  try {
    if (!fs.existsSync(AUDIT_DIR)) return;
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const deleted = [];
    for (const f of fs.readdirSync(AUDIT_DIR)) {
      const m = f.match(/^exclusions-(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (!m) continue;
      if (new Date(m[1]).getTime() < cutoff) {
        fs.unlinkSync(path.join(AUDIT_DIR, f));
        deleted.push(f);
      }
    }
    if (deleted.length) console.log(`[Exclusion Logs] Purged ${deleted.length} file(s) older than ${retentionDays}d: ${deleted.join(', ')}`);
  } catch (err) {
    console.warn(`[Exclusion Logs] Purge failed (non-fatal): ${err.message}`);
  }
}

/**
 * Render the "OB Discovery — Action Needed" digest section. Pure (no IO) so it
 * can be unit-tested: returns '' when there's nothing to surface (silent zero
 * weeks), otherwise an HTML block naming the staged count + promoter command.
 */
function buildObCandidatesHtml(staged, typoCount) {
  const list = Array.isArray(staged) ? staged : [];
  const typos = Number(typoCount) || 0;
  const stagedCount = list.length;
  if (stagedCount === 0 && typos === 0) return '';

  const color = stagedCount >= 5 ? '#f39c12' : '#aaa';
  const parts = [];
  if (stagedCount > 0) {
    parts.push(`<p style="color:#ccc;margin:4px 0;font-size:13px;">
        ${stagedCount} OB candidate${stagedCount === 1 ? '' : 's'} staged for review — promotion is human-gated.
        Run <code style="color:#fff;">node scripts/promote-ob-venue-candidates.js --dry-run</code> to review, then drop <code>--dry-run</code> to add.
      </p>`);
    const top = list.slice(0, 5).map(c =>
      `<li style="color:#ccc;margin-bottom:4px;font-size:13px;">${c.title || '?'} <span style="color:#666;">@ ${c.venue || '?'}</span> <span style="color:#666;">· ${c.source || 'venue-scan'}</span></li>`
    ).join('');
    if (top) parts.push(`<ul style="padding-left:20px;margin:4px 0;">${top}</ul>`);
  }
  if (typos > 0) {
    parts.push(`<p style="color:#f39c12;margin:4px 0;font-size:13px;">
        ${typos} aggregator slug typo${typos === 1 ? '' : 's'} need${typos === 1 ? 's' : ''} a source fix (e.g. a BWW Review-Roundup slug) — see data/audit/ob-aggregator-rejections.json.
      </p>`);
  }
  return `
        <h3 style="color:${color};margin:24px 0 8px;">OB Discovery — Action Needed</h3>
        ${parts.join('')}
      `;
}

function buildExclusionSummaryHtml({ auditDir = AUDIT_DIR, todayPath = getTodayJsonlPath(), now = Date.now() } = {}) {
  try {
    const cutoff = now - 24 * 60 * 60 * 1000;
    const summaryFile = path.join(auditDir, 'exclusion-summary-yesterday.json');

    // Read today's and yesterday's JSONL files
    const yesterday = new Date(now - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const yesterdayPath = path.join(path.dirname(todayPath), `exclusions-${yesterday}.jsonl`);

    // BRO-3598: CI runs this on a fresh checkout where the JSONL never
    // exists, so this section always printed the "no log" warning. Fall back
    // to rebuild-all-reviews.js's committed per-reason daily totals.
    let counts = {};
    let showIdsByReason = {};
    let yesterday_counts = {};
    let heading = 'Exclusion summary (last 24h)';
    if (!fs.existsSync(todayPath)) {
      const { readDailyTotals } = require('./lib/rebuild-exclusion-audit');
      const totals = readDailyTotals(auditDir);
      const days = Object.keys(totals.days).sort();
      const latest = days[days.length - 1];
      if (!latest || latest < yesterday) {
        return '<p style="color:#e74c3c;font-size:13px;margin:4px 0;">⚠️ No exclusion log or rebuild exclusion totals for the last day — rebuild may not have run.</p>';
      }
      for (const [reason, t] of Object.entries(totals.days[latest])) {
        counts[reason] = t.files;
        showIdsByReason[reason] = new Set(Object.keys(t.topShows || {}));
      }
      const prevDay = days[days.length - 2];
      if (prevDay) for (const [reason, t] of Object.entries(totals.days[prevDay])) yesterday_counts[reason] = t.files;
      heading = `Rebuild exclusions (distinct files, latest full rebuild ${latest}${prevDay ? ` vs ${prevDay}` : ''})`;
      return renderExclusionSummaryHtml(heading, counts, showIdsByReason, yesterday_counts);
    }

    const records = [];
    for (const p of [yesterdayPath, todayPath]) {
      if (!fs.existsSync(p)) continue;
      for (const line of fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean)) {
        try {
          const r = JSON.parse(line);
          if (new Date(r.ts).getTime() >= cutoff) records.push(r);
        } catch {}
      }
    }

    // Count by reason
    for (const r of records) {
      counts[r.reason] = (counts[r.reason] || 0) + 1;
      if (!showIdsByReason[r.reason]) showIdsByReason[r.reason] = new Set();
      if (r.showId && r.showId !== 'unknown') showIdsByReason[r.reason].add(r.showId);
    }

    // Load yesterday's counts for spike detection
    try {
      if (fs.existsSync(summaryFile)) {
        yesterday_counts = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
      }
    } catch {}

    // Persist today's counts for tomorrow
    try { fs.writeFileSync(summaryFile, JSON.stringify(counts, null, 2)); } catch {}

    return renderExclusionSummaryHtml(heading, counts, showIdsByReason, yesterday_counts);
  } catch (e) {
    return `<p style="color:#888;font-size:13px;">Exclusion summary unavailable: ${e.message}</p>`;
  }
}

function renderExclusionSummaryHtml(heading, counts, showIdsByReason, yesterday_counts) {
  try {
    if (Object.keys(counts).length === 0) {
      return '<p style="color:#888;font-size:13px;margin:4px 0;">No exclusions logged in last 24h.</p>';
    }

    const top10 = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const rows = top10.map(([reason, count]) => {
      const prev = yesterday_counts[reason];
      let badge = '';
      if (prev == null) {
        badge = ' <span style="color:#3498db;font-size:11px;">🆕 NEW</span>';
      } else if (prev > 0 && count / prev > 1.5) {
        badge = ` <span style="color:#e74c3c;font-size:11px;">⚠️ SPIKE (was ${prev})</span>`;
      }
      const topShows = Array.from(showIdsByReason[reason] || []).slice(0, 3).join(', ') || '—';
      return `<tr>
        <td style="padding:4px 8px;color:#ccc;font-size:12px;font-family:monospace;">${reason}${badge}</td>
        <td style="padding:4px 8px;color:#fff;text-align:center;font-size:12px;">${count}</td>
        <td style="padding:4px 8px;color:#888;font-size:11px;">${topShows}</td>
      </tr>`;
    }).join('');

    return `
      <h3 style="color:#aaa;margin:24px 0 8px;">${heading}</h3>
      <table style="width:100%;border-collapse:collapse;background:#16213e;border-radius:6px;overflow:hidden;">
        <thead>
          <tr style="border-bottom:1px solid #333;">
            <th style="padding:4px 8px;text-align:left;color:#888;font-size:11px;text-transform:uppercase;">Reason</th>
            <th style="padding:4px 8px;text-align:center;color:#888;font-size:11px;text-transform:uppercase;">Count</th>
            <th style="padding:4px 8px;text-align:left;color:#888;font-size:11px;text-transform:uppercase;">Top Shows</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  } catch (err) {
    return `<p style="color:#e74c3c;font-size:13px;margin:4px 0;">⚠️ Exclusion summary error: ${err.message}</p>`;
  }
}

// Card #364 (owner merge decision 2026-07-26 — "I don't like getting emails
// unless they're urgent. I want things to self handle."): this function used
// to email its own "BSC Daily"/"BSC URGENT" digest via Resend, landing
// separately from the autonomous loop's morning email. It no longer sends
// mail at all — it still runs every check, still dispatches Action Queue
// cards for humanAction items via routeAlert (disposition='auto', unrelated
// to email delivery), and now WRITES its results to
// HEALTH_DIGEST_SNAPSHOT_FILE instead. autonomous-email.js reads that
// snapshot and folds it into the one scheduled morning email, so the owner
// gets exactly one scheduled email/day instead of two.
async function sendEmailDigest(results, history, workflowSummary, autoFixResults) {
  // Drain owner-alert-router's digest queue (data/audit/alert-digest-queue.json)
  // — the ONE consumer, since drainDigestQueue() had no production caller
  // before this (card #475 ship-check finding): every disposition='digest'
  // routeAlert() call was queuing a line that nothing ever read back out, so
  // those conditions were silently dropped rather than reaching the owner in
  // the digest as the router's own design intends. Drained here, once per
  // real send (this function is the single production call site), so a
  // condition queued between digests always appears in the next one.
  // PEEK, don't drain: ~430 lines of rendering run before the snapshot below
  // is written, and a read-and-clear here loses every queued line permanently
  // if any of that throws (the ledger already marked those conditions
  // notified, so they are never re-queued). Cleared only after the snapshot
  // file is on disk.
  const queuedDigestItems = peekDigestQueue();
  const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const subject = getDigestSubject(results, history, autoFixResults);
  const errors = results.filter(r => r.status === 'error');
  const warns = results.filter(r => r.status === 'warn');
  const passed = results.filter(r => r.status === 'pass');
  // BRO-2458: close the loop on the `health-check:<row>` conditions filed
  // below once their row has been green past the incident gap, so
  // sweep-resolved-alert-cards.js can cancel the card. Debounced: a row that
  // flaps fail/pass is still one incident and keeps its card.
  try {
    const cleared = resolveQuietConditions(clearedHealthCheckKeys(results), { reason: 'health-check row passing' });
    if (cleared.length) console.log(`[Alert Router] resolved ${cleared.length} cleared health-check condition(s): ${cleared.join(', ')}`);
  } catch (err) {
    console.error(`[Alert Router] resolving cleared health-check conditions failed: ${err.message}`);
  }

  // Group by category
  const categories = {};
  for (const r of results) {
    const cat = r.name.split(':')[0].trim();
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(r);
  }

  // Build category summary rows
  const catRows = Object.entries(categories).map(([cat, checks]) => {
    const catPassed = checks.filter(c => c.status === 'pass').length;
    const catTotal = checks.length;
    const worst = checks.some(c => c.status === 'error') ? 'error' : checks.some(c => c.status === 'warn') ? 'warn' : 'pass';
    return `<tr>
      <td style="padding:6px 12px;border-bottom:1px solid #333;color:#ccc;">${getStatusIcon(worst)} ${cat}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #333;color:${getStatusColor(worst)};text-align:center;">${catPassed}/${catTotal}</td>
    </tr>`;
  }).join('');

  // Action section — split into auto-fixed and needs-your-attention
  let actionHtml = '';
  const actionItems = [...errors, ...warns];
  const autoFixMap = autoFixResults || {};

  if (actionItems.length > 0) {
    const URGENCY_LABELS = {
      'fix-now': { label: 'FIX NOW', bg: '#e74c3c', color: '#fff' },
      'this-week': { label: 'THIS WEEK', bg: '#f39c12', color: '#fff' },
      'low': { label: 'LOW', bg: '#555', color: '#ccc' },
    };

    const autoFixed = [];
    const needsAttention = [];
    for (const r of actionItems) {
      const fix = autoFixMap[r.name];
      if (fix && fix.fixed) {
        autoFixed.push(r);
      } else {
        needsAttention.push(r);
      }
    }

    // Auto-fixed section (green — no action needed from user)
    let autoFixedHtml = '';
    if (autoFixed.length > 0) {
      const items = autoFixed.map(r => {
        const fix = autoFixMap[r.name];
        return `<div style="padding:8px 12px;margin-bottom:6px;background:#1a3a1a;border-left:3px solid #2ecc71;border-radius:4px;">
          <span style="color:#2ecc71;font-weight:bold;">&#9989; Auto-fixed</span>
          <span style="color:#ccc;margin-left:8px;">${r.name.split(': ').pop()}</span>
          <br><span style="color:#888;font-size:12px;">Triggered ${fix.workflow} — should resolve within ~30 min</span>
        </div>`;
      }).join('');
      autoFixedHtml = `
        <h3 style="color:#2ecc71;margin:24px 0 8px;">Auto-Fixed (no action needed)</h3>
        ${items}
      `;
    }

    // Needs attention section — only FIX NOW and THIS WEEK shown; LOW items just get a count
    let needsAttentionHtml = '';
    if (needsAttention.length > 0) {
      const actionable = [];
      const lowCount = { count: 0 };
      for (const r of needsAttention) {
        const entry = getPlaybookEntry(r.name);
        let urgencyLevel = entry ? entry.urgency : 'low';

        // Smart escalation: if auto-fix was attempted but issue persists 3+ days, upgrade urgency
        const fix = autoFixMap[r.name];
        if (fix && !fix.fixed && fix.message) {
          // Auto-fix failed — escalate
          if (urgencyLevel === 'low') urgencyLevel = 'this-week';
        }
        // Check triage history for persistent issues
        const checkSlug = r.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
        try {
          const triageFile = path.join(TRIAGE_DIR, `autofix-${checkSlug}.json`);
          if (fs.existsSync(triageFile)) {
            const triage = readJSON(triageFile);
            if ((triage.autoFixAttempts || 0) >= 2 && urgencyLevel === 'low') {
              urgencyLevel = 'this-week'; // Tried to auto-fix twice and still broken
            }
          }
        } catch {}

        urgencyLevel = effectiveUrgencyLevel(urgencyLevel, r);

        if (urgencyLevel === 'low') {
          lowCount.count++;
        } else {
          actionable.push({ ...r, _escalatedUrgency: urgencyLevel });
        }
      }

      // Owner-alert-router migration (Notion 3a4637c5-416f-81eb, #279): every
      // playbook entry with a `humanAction` (no `workflow` — those already
      // auto-fix via GH workflow dispatch above) used to render a raw
      // "open Claude Code and say: ..." paste-prompt in the email. Instead,
      // file an Action Queue card once per open incident so
      // notion-action-poll.js works it hands-free; the email links the card
      // instead of asking the owner to paste anything. Runs BEFORE the
      // synchronous items.map() below so the (async) dispatch result is
      // available to it.
      //
      // Capped at MAX_CARD_DISPATCHES_PER_RUN: each dispatch shells out to
      // notion-brain.js (up to a few seconds, more if Notion is degraded) —
      // sequential dispatch of a large first-run/post-outage backlog could
      // otherwise eat into this job's 10-min timeout. Anything past the cap
      // still gets its playbook instruction text in the email (uncapped),
      // just without a filed card this run; it'll dispatch next run.
      const MAX_CARD_DISPATCHES_PER_RUN = 8;
      const dispatchedCards = {};
      let dispatchBudget = MAX_CARD_DISPATCHES_PER_RUN;
      let dispatchCapped = false;
      for (const r of actionable) {
        const entry = getPlaybookEntry(r.name);
        if (!entry || entry.workflow || !hasPlaybookAction(entry)) continue;
        // BRO-2603: entry.ledger names the frozen ledger this check is
        // sourced from (see AUTO_FIX_PLAYBOOK above). Skip filing — falls
        // back to the same "no card, raw instruction only" render as the
        // MAX_CARD_DISPATCHES_PER_RUN cap just below.
        if (entry.ledger && isLedgerFrozenNow(entry.ledger)) {
          console.log(`[Alert Router] ${freezeSkipMessage(entry.ledger)} — skipping "${r.name}"`);
          continue;
        }
        if (dispatchBudget <= 0) { dispatchCapped = true; continue; }
        dispatchBudget--;
        try {
          const result = await routeAlert({
            conditionKey: `health-check:${r.name}`,
            title: `BSC Daily: ${r.name}`,
            description: `${r.message}${r.hint ? `\n\n${r.hint}` : ''}`,
            hint: playbookWorkerHint(entry),
            severity: r.status === 'error' ? 'error' : 'warning',
            disposition: 'auto',
            // BRO-4487: a stable, daily-checked condition. File its card only
            // once it has persisted 3 days; most health rows clear sooner.
            deferFilingHours: 72,
            // BRO-6471: an entry marked workerFixable is a worker's job, so its card files START-NOW, not parked.
            ...(entry.workerFixable ? { workerFixable: true } : {}),
            fields: [{ name: 'Check', value: r.name }],
          });
          dispatchedCards[r.name] = result;
        } catch (err) {
          console.error(`[Alert Router] dispatch failed for "${r.name}": ${err.message}`);
        }
      }
      if (dispatchCapped) {
        console.log(`[Alert Router] hit MAX_CARD_DISPATCHES_PER_RUN=${MAX_CARD_DISPATCHES_PER_RUN} — remaining humanAction items will dispatch next run`);
      }

      // BRO-5168: failing rows with no playbook route reached no tracker from
      // CI, so with the Mac's digest-autofix down they were never carded at
      // all. Route the ones a worker can fix (start-now-filing.js) the same
      // deferred way: a card only after 3 days, and the router files it
      // START-NOW so the cloud worker can take it. Budget counts only calls
      // that may file; a deferred or silent result gives its slot back.
      let unroutedBudget = MAX_UNROUTED_FILINGS_PER_RUN;
      for (const r of selectUnroutedVisitorRows(needsAttention, { getPlaybookEntry })) {
        if (unroutedBudget <= 0) break;
        unroutedBudget--;
        try {
          const result = await routeAlert({
            conditionKey: `health-check:${r.name}`,
            title: `BSC Daily: ${r.name}`,
            description: `${r.message}${r.hint ? `\n\n${r.hint}` : ''}`,
            hint: 'Find and fix the cause of this daily health row; done when the row no longer appears in the health check.',
            severity: r.status === 'error' ? 'error' : 'warning',
            disposition: 'auto',
            deferFilingHours: 72,
            workerFixable: true,
            fields: [{ name: 'Check', value: r.name }],
          });
          if (result && (result.deferred || result.action === 'silent')) unroutedBudget++;
        } catch (err) {
          console.error(`[Alert Router] unrouted-row dispatch failed for "${r.name}": ${err.message}`);
        }
      }

      const items = actionable.map(r => {
        const entry = getPlaybookEntry(r.name);
        const urgency = URGENCY_LABELS[r._escalatedUrgency || (entry ? entry.urgency : 'low')] || URGENCY_LABELS['low'];
        const dispatch = dispatchedCards[r.name];
        // BRO-5543: the owner reads ownerText plus the tracker status, never
        // the worker hint (scripts/lib/playbook-copy.js ownerDigestInstruction).
        const instruction = ownerDigestInstruction(entry, r, dispatch);
        const fix = autoFixMap[r.name];
        const failNote = fix && fix.message
          ? `<br><span style="color:#e74c3c;font-size:11px;">Couldn't auto-fix. ${entry?.workflow ? `<a href="https://github.com/thomaspryor/Broadwayscore/actions/workflows/${entry.workflow}" style="color:#e74c3c;text-decoration:underline;">Tap to retry manually</a>` : ''}</span>`
          : '';

        // Show per-cookie countdowns if available
        const countdowns = (entry?.useCountdown && r.cookieCountdowns?.length > 0)
          ? `<p style="color:#f39c12;margin:4px 0 0;font-size:12px;">${r.cookieCountdowns.join(' · ')}</p>`
          : '';

        // One-tap approve button for fix-now items with a known fix workflow
        const urgencyLevel = r._escalatedUrgency || (entry ? entry.urgency : 'low');
        const approveUrl = urgencyLevel === 'fix-now' && entry?.workflow
          ? generateApproveUrl(entry.workflow, r.name)
          : '';
        const approveButton = approveUrl
          ? `<div style="margin-top:10px;">
              <a href="${approveUrl}" style="display:inline-block;background:#27ae60;color:white;padding:8px 18px;border-radius:5px;text-decoration:none;font-weight:bold;font-size:13px;">Run Fix</a>
              <span style="color:#666;font-size:11px;margin-left:8px;">Triggers ${entry.workflow} &nbsp;·&nbsp; Link expires in 24h</span>
            </div>`
          : '';

        return `<div style="padding:10px 12px;margin-bottom:8px;background:#2a1a1a;border-left:3px solid ${urgency.bg};border-radius:4px;">
          <span style="display:inline-block;padding:2px 8px;border-radius:3px;background:${urgency.bg};color:${urgency.color};font-size:11px;font-weight:bold;">${urgency.label}</span>
          <span style="color:#ddd;margin-left:8px;font-weight:bold;">${r.name.split(': ').pop()}</span>
          ${countdowns}
          <p style="color:#bbb;margin:6px 0 0;font-size:13px;line-height:1.4;">${instruction}</p>
          ${failNote}
          ${approveButton}
        </div>`;
      }).join('');

      const lowNote = lowCount.count > 0
        ? `<p style="color:#666;font-size:12px;margin-top:8px;">+ ${lowCount.count} low-priority item${lowCount.count > 1 ? 's' : ''} monitoring themselves (no action needed)</p>`
        : '';

      if (actionable.length > 0) {
        needsAttentionHtml = `
          <h3 style="color:#f39c12;margin:24px 0 8px;">Needs Your Attention</h3>
          ${items}
          ${lowNote}
        `;
      } else if (lowCount.count > 0) {
        needsAttentionHtml = `
          <p style="color:#666;font-size:12px;margin:24px 0 8px;">${lowCount.count} low-priority item${lowCount.count > 1 ? 's' : ''} monitoring themselves (no action needed)</p>
        `;
      }
    }

    actionHtml = autoFixedHtml + needsAttentionHtml;
  }

  // Mezzanine title-coverage drift section. Surfaces likely-mismatched titles
  // that the scraper failed to bridge (normalize gap or missing override).
  // Audit file is written by scripts/scrape-mezzanine-audience.js on every
  // full run. Wired to email after the 2026-04-28 What Happened Was incident.
  let mezzanineCoverageHtml = '';
  try {
    const mezzAuditPath = path.join(__dirname, '..', 'data', 'audit', 'mezzanine-coverage.json');
    if (fs.existsSync(mezzAuditPath)) {
      const audit = JSON.parse(fs.readFileSync(mezzAuditPath, 'utf8'));
      const count = audit.count || 0;
      if (count > 0) {
        const ageMs = Date.now() - new Date(audit.lastUpdated || 0).getTime();
        const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
        const stale = ageDays > 14;
        const color = count >= 10 ? '#e74c3c' : count >= 5 ? '#f39c12' : '#aaa';
        const heading = count >= 10
          ? '⚠️ Mezzanine Coverage Drift (action recommended)'
          : count >= 5
          ? 'Mezzanine Coverage — Review When Convenient'
          : 'Mezzanine Coverage';
        const top = (audit.flagged || []).slice(0, 5).map(f =>
          `<li style="color:#ccc;margin-bottom:4px;font-size:13px;">${f.ratingsCount} ratings · ${f.ourTitle} <span style="color:#666;">↔</span> ${f.mezzName} <span style="color:#666;">@ ${f.theater || '?'}</span></li>`
        ).join('');
        mezzanineCoverageHtml = `
          <h3 style="color:${color};margin:24px 0 8px;">${heading}</h3>
          <p style="color:#ccc;margin:4px 0;font-size:13px;">
            ${count} Mezzanine production${count === 1 ? '' : 's'} fuzzy-matches an open/recent show but didn't link.
            Likely a missing MEZZANINE_OVERRIDES entry or a normalize gap in scripts/lib/title-match.js.
            ${stale ? `<br><span style="color:#888;">Last audit run ${ageDays}d ago — Mezzanine cron may be stuck.</span>` : ''}
          </p>
          ${top ? `<ul style="padding-left:20px;margin:4px 0;">${top}</ul>` : ''}
          <p style="color:#666;font-size:12px;margin:4px 0;">Full list: data/audit/mezzanine-coverage.json</p>
        `;
      }
    }
  } catch (e) {
    console.log(`[Mezzanine Coverage] Skipped — ${e.message}`);
  }

  // OB-discovery candidates awaiting human promotion. extract-aggregator-
  // candidates.js + the venue-listing scrapers stage candidates into
  // ob-venue-candidates.json weekly, but promotion to shows.json is human-gated
  // (CLAUDE.md §3) — the whole bridge is inert if nobody runs the promoter.
  // Surface the backlog (+ any aggregator slug typos that need a source fix)
  // until it's acted on. Silent when both counts are zero.
  let obCandidatesHtml = '';
  try {
    const stagingPath = path.join(__dirname, '..', 'data', 'audit', 'ob-venue-candidates.json');
    const rejectionsPath = path.join(__dirname, '..', 'data', 'audit', 'ob-aggregator-rejections.json');
    let staged = [];
    if (fs.existsSync(stagingPath)) {
      const d = JSON.parse(fs.readFileSync(stagingPath, 'utf8'));
      if (Array.isArray(d)) staged = d;
    }
    let typoCount = 0;
    if (fs.existsSync(rejectionsPath)) {
      const rj = JSON.parse(fs.readFileSync(rejectionsPath, 'utf8'));
      typoCount = (rj.counts && rj.counts.byReason && rj.counts.byReason['typo-detected']) || 0;
    }
    obCandidatesHtml = buildObCandidatesHtml(staged, typoCount);
  } catch (e) {
    console.log(`[OB Candidates] Skipped — ${e.message}`);
  }

  // Workflow runs section
  let workflowHtml = '';
  if (workflowSummary && !workflowSummary.skipped) {
    const repeats = workflowSummary.repeatFailures || [];
    const repeatHtml = repeats.length > 0
      ? `
        <h3 style="color:#e74c3c;margin:24px 0 8px;">⚠️ Repeat Workflow Failures (24h)</h3>
        <p style="color:#ccc;margin:4px 0;">
          These workflow/job/step groups failed 2+ times in the last 24 hours. Entries without a self-healed note are likely broken, not transient.
        </p>
        <ul style="padding-left:20px;margin:4px 0;">
          ${repeats.map(r => `<li style="color:${r.selfHealed ? '#f1c40f' : '#e74c3c'};margin-bottom:4px;"><strong>${escapeHtml(repeatFailureLabel(r))}</strong>: ${r.count} failures${r.detailsUnavailable ? ' (failed-step details unavailable; causes may differ)' : ''}${r.selfHealed ? '; likely self-healed (2+ green runs since)' : ''}; <a href="${r.latestUrl}" style="color:${r.selfHealed ? '#f1c40f' : '#e74c3c'};">latest run</a></li>`).join('')}
        </ul>
      `
      : '';
    const failedList = workflowSummary.failedRuns.length > 0
      ? workflowSummary.failedRuns.map(r => `<li style="color:#e74c3c;margin-bottom:4px;"><a href="${r.url}" style="color:#e74c3c;">${r.name}</a></li>`).join('')
      : '';
    workflowHtml = `
      ${repeatHtml}
      <h3 style="color:#aaa;margin:24px 0 8px;">Workflow Runs (24h)</h3>
      <p style="color:#ccc;margin:4px 0;">
        ${workflowSummary.succeeded} succeeded, ${workflowSummary.failed} failed (${workflowSummary.total} total)
        ${workflowSummary.partial ? ' <span style="color:#f1c40f;">(partial — a later page of results failed to load, counts may undercount)</span>' : ''}
      </p>
      ${failedList ? `<ul style="padding-left:20px;margin:4px 0;">${failedList}</ul>` : ''}
    `;
  }

  // Render whatever queued this run (or a prior run, if this is the first
  // digest since — the queue survives until drained). Escaped: titles/
  // descriptions originate from repo code, not user input, but several carry
  // LLM-authored or aggregator-sourced text (e.g. UX walkthrough findings).
  const digestQueueHtml = queuedDigestItems.length > 0
    ? `
      <h3 style="color:#aaa;margin:24px 0 8px;">Automation (queued)</h3>
      <ul style="padding-left:20px;margin:4px 0;">
        ${queuedDigestItems.map(q => `<li style="color:#ccc;margin-bottom:4px;"><strong>${escapeHtml(q.title)}</strong>${q.description ? ` — ${escapeHtml(q.description)}` : ''}${Array.isArray(q.fields) && q.fields.length ? ` (${q.fields.map(f => `${escapeHtml(f.name)}: ${escapeHtml(f.value)}`).join(', ')})` : ''}</li>`).join('')}
      </ul>
    `
    : '';

  // Owner email volume (7d) — card #475 regression guard: makes creep in the
  // number of CRITICAL emails visible in the ONE place already read daily,
  // instead of requiring a manual inbox comb the next time volume spikes.
  let ownerEmailHtml = '';
  try {
    const sent = readOwnerEmailLog({ days: 7 });
    if (sent.length > 0) {
      const bySender = new Map();
      for (const e of sent) {
        // Bucket by the text before the first colon (e.g. "Secret Health
        // Check — 2 Failed" has none, so falls back to the full title) —
        // good enough to spot one sender dominating the week's volume
        // without needing per-caller instrumentation.
        const key = (e.title || 'unknown').split(':')[0].trim().slice(0, 60);
        bySender.set(key, (bySender.get(key) || 0) + 1);
      }
      const rows = [...bySender.entries()].sort((a, b) => b[1] - a[1]);
      const rowsHtml = rows.map(([name, count]) =>
        `<li style="color:#ccc;margin-bottom:2px;">${count}&times; — ${name}</li>`).join('');
      ownerEmailHtml = `
        <h3 style="color:#aaa;margin:24px 0 8px;">Owner Emails (7d): ${sent.length} total</h3>
        <ul style="padding-left:20px;margin:4px 0;">${rowsHtml}</ul>
      `;
    }
  } catch (e) {
    console.log(`[Owner Email Volume] Skipped — ${e.message}`);
  }

  // Overall status banner. Same isActionableResult filter getDigestSubject()
  // uses (ship-check finding, card #364): without it, the merged email's
  // subject line ("BSC Daily: All clear") could contradict its own site-health
  // block ("2 errors, 1 warning") whenever the only unfixed items are
  // low-urgency playbook entries — exactly the noise the owner asked this
  // merge to kill.
  const unfixedErrors = errors.filter(r => !autoFixResults?.[r.name]?.fixed && isActionableResult(r));
  const unfixedWarns = warns.filter(r => !autoFixResults?.[r.name]?.fixed && isActionableResult(r));
  const overallStatus = unfixedErrors.length > 0 ? 'error' : unfixedWarns.length > 0 ? 'warn' : 'pass';
  const bannerColor = getStatusColor(overallStatus);
  const bannerText = errors.length > 0
    ? `${errors.length} error${errors.length > 1 ? 's' : ''}, ${warns.length} warning${warns.length > 1 ? 's' : ''}`
    : warns.length > 0
    ? `${warns.length} warning${warns.length > 1 ? 's' : ''}`
    : `All ${passed.length} checks passed`;

  const consecutiveInfo = history.consecutiveErrorDays > 0
    ? `<p style="color:#e74c3c;font-size:13px;margin:4px 0;">&#9888;&#65039; Day ${history.consecutiveErrorDays} of consecutive errors</p>`
    : history.lastCleanStreak > 1
    ? `<p style="color:#2ecc71;font-size:13px;margin:4px 0;">&#9989; ${history.lastCleanStreak} day clean streak</p>`
    : '';

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#1a1a2e;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:20px;">
    <!-- Banner -->
    <div style="background:#16213e;border-left:4px solid ${bannerColor};padding:16px 20px;border-radius:8px;margin-bottom:20px;">
      <h2 style="color:${bannerColor};margin:0 0 4px;font-size:18px;">${bannerText}</h2>
      ${consecutiveInfo}
      <p style="color:#666;font-size:12px;margin:4px 0 0;">broadwayscorecard.com &middot; ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}</p>
    </div>

    <!-- Health Status Table -->
    <table style="width:100%;border-collapse:collapse;background:#16213e;border-radius:8px;overflow:hidden;">
      <thead>
        <tr style="border-bottom:2px solid #333;">
          <th style="padding:8px 12px;text-align:left;color:#888;font-size:12px;text-transform:uppercase;">Category</th>
          <th style="padding:8px 12px;text-align:center;color:#888;font-size:12px;text-transform:uppercase;">Status</th>
        </tr>
      </thead>
      <tbody>${catRows}</tbody>
    </table>

    ${actionHtml}
    ${mezzanineCoverageHtml}
    ${obCandidatesHtml}
    ${workflowHtml}
    ${digestQueueHtml}
    ${ownerEmailHtml}
    ${buildExclusionSummaryHtml()}

    <!-- Footer -->
    <p style="color:#555;font-size:11px;margin-top:24px;text-align:center;">
      Broadway Scorecard Daily Digest &middot; <a href="https://github.com/thomaspryor/Broadwayscore/actions" style="color:#555;">Actions</a>
    </p>
  </div>
</body>
</html>`;

  // Write the snapshot instead of emailing (see the function-level comment
  // above). `html` above is built but no longer sent anywhere — kept for a
  // future debug dump, not wasted: writing it out would bloat a file the
  // owner never opens, so it deliberately does NOT go into the snapshot.
  const autoFixedCount = Object.values(autoFixMap).filter(f => f.fixed).length;
  const snapshot = {
    generatedAt: new Date().toISOString(),
    subject,
    bannerText,
    consecutiveErrorDays: history.consecutiveErrorDays || 0,
    errors: unfixedErrors.map(r => ({ name: r.name, message: r.message })),
    warns: unfixedWarns.map(r => ({ name: r.name, message: r.message })),
    // owner-alert-router's disposition='digest' queue (ship-check finding,
    // card #364): whatever it held only ever reaches the owner if it's
    // carried here. Losing it would silently reintroduce the exact bug card
    // #475 fixed (routed conditions vanishing into a queue nothing reads back
    // out of). The queue is cleared just after this snapshot is written.
    // url is carried too: routeAlert() accepts one and queueDigestLine()
    // persists it, but projecting it away here made renderHealthDigestBlock's
    // link unreachable in production — a digest line whose whole point is
    // "go look at this page" (regional show going live) arrived unclickable.
    // BRO-5099: toSnapshotQueuedRow carries every field the digest reads.
    queued: queuedDigestItems.map(toSnapshotQueuedRow),
    autoFixedCount,
    passedCount: passed.length,
    totalCount: results.length,
  };
  fs.mkdirSync(path.dirname(HEALTH_DIGEST_SNAPSHOT_FILE), { recursive: true });
  fs.writeFileSync(HEALTH_DIGEST_SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2) + '\n');
  // Only now is it safe to clear: the queued lines are durably in the snapshot
  // the morning email reads from. Clearing any earlier (as the old
  // drainDigestQueue() call did) meant a throw anywhere above lost them for
  // good, since the ledger had already marked those conditions notified.
  if (queuedDigestItems.length > 0) clearDigestQueue();
  console.log(`[Health Digest] Snapshot written (${snapshot.errors.length} error(s), ${snapshot.warns.length} warning(s), ${snapshot.queued.length} queued) — folds into the morning email, not sent separately`);
  return true;
}

// Console line for one result. 'ok' is a pass-equivalent status a few checks
// return (off-season Tony freshness rows, audience coverage, ...); it printed
// an `undefined` icon before BRO-2476. Unknown statuses get a '?' rather than
// the literal string "undefined".
const RESULT_ICONS = { pass: '\u2705', ok: '\u2705', warn: '\u26A0\uFE0F', error: '\u274C' };
function formatResultLine(r) {
  return `  ${RESULT_ICONS[r.status] || '?'} ${r.name}: ${r.message}`;
}

// --- Triage State (per-system files) ---

function writeTriageState(allResults) {
  fs.mkdirSync(TRIAGE_DIR, { recursive: true });

  // Group results by system category
  const systems = {};
  for (const r of allResults) {
    const category = r.name.split(':')[0].trim().toLowerCase();
    if (!systems[category]) systems[category] = { results: [], worstStatus: 'pass' };
    systems[category].results.push(r);
    if (r.status === 'error') systems[category].worstStatus = 'error';
    else if (r.status === 'warn' && systems[category].worstStatus !== 'error') systems[category].worstStatus = 'warn';
  }

  for (const [system, data] of Object.entries(systems)) {
    const triageFile = path.join(TRIAGE_DIR, `${system}.json`);
    let existing = {};
    try {
      if (fs.existsSync(triageFile)) existing = readJSON(triageFile);
    } catch {}

    const now = new Date().toISOString();
    const state = {
      system,
      status: data.worstStatus,
      lastChecked: now,
      lastAlertTimestamp: existing.lastAlertTimestamp || null,
      autoFixAttempts: data.worstStatus === 'pass' ? 0 : (existing.autoFixAttempts || 0),
      escalationState: data.worstStatus === 'pass' ? 'resolved' : (existing.escalationState || 'monitoring'),
      details: data.results.map(r => ({ name: r.name, status: r.status, message: r.message })),
    };

    fs.writeFileSync(triageFile, JSON.stringify(state, null, 2) + '\n');
  }
}

// --- Auto-Triage Issue Creation ---

async function createTriageIssue(allResults, history) {
  // Only create issues for persistent errors (2+ days)
  if (history.consecutiveErrorDays < 2) return;
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) return;

  const errors = allResults.filter(r => r.status === 'error');
  if (errors.length === 0) return;

  // Dedup: check for existing open auto-triage issues
  try {
    const existing = execSync(
      `gh issue list --label auto-triage --state open --json number -q 'length'`,
      { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    if (parseInt(existing, 10) > 0) {
      console.log(`[Triage] ${existing} open auto-triage issue(s) already exist, skipping creation`);
      return;
    }
  } catch {}

  const issueBody = JSON.stringify({
    type: 'health-check-digest',
    timestamp: new Date().toISOString(),
    consecutiveErrorDays: history.consecutiveErrorDays,
    errors: errors.map(e => ({
      name: e.name,
      message: e.message,
      hint: e.hint || null,
      category: e.name.split(':')[0].trim().toLowerCase(),
    })),
  }, null, 2);

  const title = `Auto-Triage: ${errors.length} persistent error${errors.length > 1 ? 's' : ''} (day ${history.consecutiveErrorDays})`;

  try {
    // Write body to temp file to avoid shell escaping issues
    const bodyFile = '/tmp/triage-issue-body.json';
    fs.writeFileSync(bodyFile, issueBody);
    execSync(
      `gh issue create --title "${title}" --label auto-triage --label automated --body-file "${bodyFile}"`,
      { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    console.log(`[Triage] Created auto-triage issue: ${title}`);
  } catch (err) {
    console.error(`[Triage] Failed to create issue: ${err.message.substring(0, 100)}`);
  }
}

// --- Progressive Alerting ---

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return readJSON(HISTORY_FILE);
    }
  } catch (e) { /* ignore */ }
  return { lastRun: null, consecutiveErrorDays: 0, results: {} };
}

function saveHistory(history) {
  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2) + '\n');
}

// --- Main ---

async function checkNeverRunWorkflowHealth() {
  try {
    const {
      checkNeverRunWorkflowCoverage,
      NEVER_RUN_MIN_AGE_DAYS,
      NEVER_RUN_SNAPSHOT_PATH,
    } = require('./audit-workflow-hygiene.js');
    const workflowDir = path.join(__dirname, '../.github/workflows');
    const workflowFiles = readWorkflowFilesOrFailClosed(workflowDir, { includeYaml: true });
    const neverRun = await checkNeverRunWorkflowCoverage(workflowFiles);
    if (neverRun.skipped) {
      console.log(`[Workflow coverage] Skipped — ${neverRun.reason}`);
    } else {
      console.log(`[Workflow coverage] ${neverRun.offenders.length} never-run offender(s) among ${neverRun.totalChecked} checked`);
      const neverRunReport = {
        generatedAt: new Date().toISOString(),
        minAgeDays: NEVER_RUN_MIN_AGE_DAYS,
        totalChecked: neverRun.totalChecked,
        unknownCount: neverRun.unknownCount,
        offenders: neverRun.offenders,
      };
      fs.mkdirSync(path.dirname(NEVER_RUN_SNAPSHOT_PATH), { recursive: true });
      fs.writeFileSync(NEVER_RUN_SNAPSHOT_PATH, JSON.stringify(neverRunReport, null, 2) + '\n');
      return neverRunWorkflowResults(neverRunReport);
    }
  } catch (err) {
    console.log(`[Workflow coverage] error: ${err.message}`);
    return [{ name: 'Workflow coverage: never-run', status: 'error', message: `Cannot scan workflows: ${err.message}` }];
  }
  return [];
}

// The checks that make up the CORE digest (isCI-gated side effects, plus
// checkDispatchOutcomes' own state-cache write, are opt-out via `dryRun` so
// this same list can be re-run live and read-only by
// scripts/lib/health-row-probe.js — see its header for why check-health-row-
// absent.js can't just re-run scripts/health-check.js wholesale). This is the
// ONLY place the check list is enumerated; main() and the probe both call it
// so the two can never drift apart.
// Reads only committed audit files, so it lives in computeCoreHealthResults
// where the live probe (check-health-row-absent --live) sees it; it used to
// run in main()'s CI-only block and could never be verified fixed (BRO-4689).
function checkReverseDiscovery() {
  try {
    const rdReport = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/audit/reverse-discovery-candidates.json'), 'utf8'));
    // firstSeen lives in the STATE file, not the candidates report — without
    // it every candidate looks brand new and nothing can ever escalate.
    let rdState = {};
    try {
      rdState = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/audit/reverse-discovery-state.json'), 'utf8'));
    } catch { /* state absent on a first run — ages stay unknown, status stays warn */ }
    return [
      ...reverseDiscoveryBacklogResults(rdReport, rdState),
      ...reverseDiscoveryFreshnessResults(rdReport, Date.now()),
    ];
  } catch {
    return []; // report absent (detector not yet run) — nothing to surface
  }
}

async function computeCoreHealthResults(isCI, { dryRun = false } = {}) {
  return [
    ...checkFreshness(),
    ...checkAuditFreshness(),
    ...checkPushVerification(),
    ...checkOpeningNightHistoryFreshness(),
    ...checkSync(),
    ...checkPipelines(),
    ...checkBatchState(),
    ...checkQuality(),
    ...checkObClosingBacklog(),
    ...checkCloudMemoryDrift(),
    ...checkTourAutomation(),
    ...checkOutletHealth(),
    ...checkCommercialPendingQueue(),
    ...checkCommercialModelDrift(),
    checkBizOgCoverage(),
    ...checkCookieExpiration(),
    ...checkCWV(),
    ...checkSEO(),
    ...checkCronHealth(),
    ...checkExemptCronLiveness(),
    ...checkScheduledFailureStreak(),
    ...(await checkMainRedStreak(isCI)),
    ...checkCiGreenRate(isCI),
    ...checkCiMidSetupCancels(),
    ...checkSecretsHealth(),
    ...checkAPICredits(),
    ...checkDeployFreshness(),
    ...(await checkAlertRouterDeadman(isCI)),
    ...(await checkCodexRunner()),
    ...checkPushRetryDeadman(dryRun),
    ...checkInfraReviewGate(),
    ...checkSharedCheckoutShallow(),
    ...checkDispatchOutcomes(dryRun),
    ...checkDispatchHealth(),
    ...(await checkCmuxReachability()),
    ...checkAutofixEffectiveness(isCI),
    ...checkAutofixCanary(isCI),
    ...checkAutofixThroughput(isCI),
    ...(await checkUntrackedPersistentRows()),
    ...checkDigestInvariantFail(isCI),
    ...checkStuckPipelineItems(),
    ...checkDataFreshnessGaps(),
    // BRO-5164: moved out of main()'s CI-only block so the live probe sees them.
    ...(await checkFeedbackBacklog()),
    ...checkUncollectedStrands(),
    ...checkCardVerifiabilityBacklog(),
    ...checkCoverageHoles(),
    ...checkStarBandDrift(),
    ...checkEarlyPublishDates(),
    ...checkCorpusAudits(),
    ...checkReverseDiscovery(),
  ];
}

async function main() {
  const isCI = !!process.env.CI || !!process.env.GITHUB_ACTIONS;

  if (!isCI) {
    console.log('⚠️  LOCAL RUN — history/triage/alerts will NOT be updated (stale local data would corrupt CI state)\n');
  }

  console.log('=== Broadway Scorecard Daily Health Check ===\n');

  purgeOldExclusionLogs();

  const allResults = await computeCoreHealthResults(isCI);

  // Workflow run summary (last 24h) \u2014 fetched here, before the alerting block,
  // so repeat failures can be promoted into allResults and escalate like any
  // other check (subject line, consecutive-error days, auto-triage). CI-only:
  // the summary is only ever consumed by the alerting/digest path (which the
  // !isCI early return below skips), and gating the fetch keeps this summary's
  // calls off local runs. Core checks above still make token-gated, cached,
  // headroom-gated GitHub calls locally (checkMainRedStreak, checkFeedbackBacklog).
  let workflowSummary = null;
  if (isCI) {
    workflowSummary = await getWorkflowRunSummary();
    if (workflowSummary.skipped) {
      console.log('[Workflows] Skipped \u2014 no GH_TOKEN available');
    } else {
      console.log(`[Workflows] ${workflowSummary.succeeded} succeeded, ${workflowSummary.failed} failed (${workflowSummary.total} total in last 24h)`);
    }
    allResults.push(...repeatFailureResults(workflowSummary));
    // Feedback backlog, uncollected strands, card verifiability, coverage holes
    // and star-band drift are core checks now (BRO-5164): computeCoreHealthResults.

    // Never-run workflow coverage (task #737): computed HERE, not read from a
    // file lint-workflows wrote — that CI job checks out code but has no
    // commit step, so a snapshot written there would never leave the
    // ephemeral runner (ship-check finding). This job already commits
    // data/audit/* daily, so it's the one job that can actually persist the
    // result for the digest to see on the NEXT run and for an operator to
    // inspect directly.
    allResults.push(...await checkNeverRunWorkflowHealth());

    // Disk space on the machine running the local automation. Cheap, no network.
    try {
      const { execSync } = require('child_process');
      const df = execSync(`df -h ${JSON.stringify(path.join(__dirname, '..'))}`, { encoding: 'utf8', timeout: 10000 });
      const { free, total } = readDiskSpace(df);
      allResults.push(...diskSpaceResults(free, total));
    } catch (err) {
      console.log(`[Disk space] error: ${err.message}`);
    }

    try {
      const gapReport = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/audit/t1-silent-gaps.json'), 'utf8'));
      allResults.push(...silentGapBacklogResults(gapReport));
    } catch { /* report absent (audit not yet run) — nothing to surface */ }

    // worktree-gc.log freshness moved to the Mac-local scripts/check-worktree-gc-freshness.js
    // (BRO-2719): the log is gitignored now, so this CI runner can never see it.

    try {
      const couplingSnap = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/audit/notion-schedule-coupling.json'), 'utf8'));
      allResults.push(...notionScheduleCouplingResults(couplingSnap));
    } catch {
      allResults.push(...notionScheduleCouplingResults(null));
    }

    try {
      const progressReport = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/audit/progress-watch-state.json'), 'utf8'));
      allResults.push(...progressWatchResults(progressReport));
    } catch { /* report absent (monitor not yet run) — nothing to surface */ }

    try {
      const { readRoundupMisses, summarizeBwwRoundupMisses } = require('./lib/bww-roundup-persistence');
      const misses = readRoundupMisses();
      if (misses.length > 0) {
        const { loadShows } = require('./lib/shows-write-guard');
        const { shows } = loadShows();
        const { reviews } = readJSON(path.join(DATA_DIR, 'reviews.json'));
        allResults.push(...bwwRoundupMissBacklogResults(summarizeBwwRoundupMisses(misses, shows, Date.now(), reviews)));
      }
    } catch { /* ledger absent or unreadable — nothing to surface */ }

    try {
      const { readLedger } = require('./lib/push-ledger-store');
      const { parseLedgerLines, selectEntriesInWindow } = require('./lib/push-ledger');
      const { content } = readLedger(path.join(__dirname, '..'));
      const entries = parseLedgerLines(content);
      const recentFallbacks = selectEntriesInWindow(entries, {
        nowMs: Date.now(), minAgeMs: 0, maxAgeMs: 24 * 60 * 60 * 1000,
      }).filter(e => e.fallbackUsed);
      allResults.push(...pushFallbackUsageResults(recentFallbacks));
    } catch { /* push-ledger branch absent/unreadable — nothing to surface */ }
  }

  // Print console summary
  for (const r of allResults) {
    console.log(formatResultLine(r));
  }

  // 'ok' (off-season skips) prints with the pass icon, so count it as passed.
  const totalPassed = allResults.filter(r => r.status === 'pass' || r.status === 'ok').length;
  const totalWarn = allResults.filter(r => r.status === 'warn').length;
  const totalError = allResults.filter(r => r.status === 'error').length;

  console.log(`\n--- Summary: ${totalPassed} passed, ${totalWarn} warnings, ${totalError} errors (${allResults.length} total) ---\n`);

  // Local runs: print results only, skip all side effects
  if (!isCI) {
    console.log('ℹ️  Run in CI (data-health-check.yml) for full alerting and triage state updates.');
    return;
  }

  // Progressive alerting (CI only)
  const history = loadHistory();
  const hadErrors = totalError > 0;

  if (hadErrors) {
    history.consecutiveErrorDays = (history.consecutiveErrorDays || 0) + 1;
    history.lastCleanStreak = 0;
  } else {
    history.lastCleanStreak = (history.lastCleanStreak || 0) + 1;
    history.consecutiveErrorDays = 0;
  }
  history.lastRun = new Date().toISOString();
  history.results = allResults.map(r => ({ name: r.name, status: r.status, message: r.message }));
  saveHistory(history);

  // Write per-system triage state files
  writeTriageState(allResults);

  // Auto-fix: attempt to dispatch fix workflows for known issues
  const autoFixResults = {};
  const dispatchedWorkflows = new Set();
  const fixableResults = allResults.filter(r => r.status === 'error' || r.status === 'warn');
  for (const r of fixableResults) {
    const entry = getPlaybookEntry(r.name);
    if (entry && entry.workflow) {
      // Skip if same workflow already dispatched this run (dedup Pipeline vs Freshness)
      if (dispatchedWorkflows.has(entry.workflow)) {
        autoFixResults[r.name] = { fixed: true, workflow: entry.workflow, deduped: true };
        continue;
      }
      const result = await tryAutoFix(r);
      autoFixResults[r.name] = result;
      if (result.fixed) dispatchedWorkflows.add(entry.workflow);
    }
  }
  const autoFixedCount = Object.values(autoFixResults).filter(f => f.fixed).length;
  if (autoFixedCount > 0) {
    console.log(`[Auto-Fix] Fixed ${autoFixedCount} issue(s) automatically`);
  }

  // workflowSummary was fetched earlier (before the alerting block) so repeat
  // failures could be promoted into allResults; reuse it for the digest body.

  // Write the digest snapshot (card #364: no longer emails on its own —
  // autonomous-email.js folds this into the single scheduled morning email).
  // history.lastErrorFingerprint still holds YESTERDAY's error set here —
  // getDigestSubject compares against it to detect "same bad news as yesterday".
  await sendEmailDigest(allResults, history, workflowSummary, autoFixResults);

  // Daily router lifecycle sweep, after this run refreshed live conditions.
  // data-health-check.yml already commits the router ledger in this job.
  const absentConditions = await resolveAbsentConditions();
  console.log(`[Alert Router] resolved ${absentConditions.length} absent condition(s)`);

  // Only after the digest used yesterday's fingerprint: record today's set.
  updateErrorFingerprint(history, allResults, autoFixResults);
  saveHistory(history);

  // Create auto-triage issue for persistent errors
  await createTriageIssue(allResults, history);

  // Exit code: always 0 for expected results (even persistent errors).
  // Email digest handles all daily alerting. notify-failure only fires on actual crashes.
  if (hadErrors && history.consecutiveErrorDays >= 2) {
    console.log(`\n\u274C Persistent errors (${history.consecutiveErrorDays} consecutive days). Reported via email digest.`);
  } else if (hadErrors) {
    console.log(`\n\u26A0\uFE0F First-day errors detected. Monitoring — will escalate if repeated tomorrow.`);
  } else {
    console.log('\u2705 All healthy.');
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('Health check crashed:', err);
    process.exit(1);
  });
}

module.exports = { evaluateOutletFeedHealth, checkScheduledFailureStreak, checkNeverRunWorkflowHealth, checkAPICredits, corpusAuditResults, generateApproveUrl, checkAuditFreshness, checkFreshness, freshnessValue, FRESHNESS_CHECKS, formatResultLine, buildExclusionSummaryHtml, providerSpendLedgerResult, hoursAgo, ghRunsQuery, sortRunsNewestFirst, firstRunCreatedAt, runCacheKey, RUN_CACHE_VERSION, diskSpaceResults, readDiskSpace, buildObCandidatesHtml, censusRecallResult, coverageProbeResult, getWorkflowRunSummary, repeatFailureResults, isRepeatFailureSelfHealed, isGateWorkflowBroken, GATE_WORKFLOWS, summarizeRepeatFailures, effectiveUrgencyLevel, feedbackBacklogResults, obClosingBacklogResults, cloudMemoryDriftResults, tourAutomationResults, neverRunWorkflowResults, silentGapBacklogResults, uncollectedStrandResults, reverseDiscoveryBacklogResults, reverseDiscoveryFreshnessResults, worktreeGcFreshnessResults, notionScheduleCouplingResults, cardVerifiabilityBacklogResults, coverageHolesResults, starBandDriftResults, earlyPublishDatesResults, progressWatchResults, bwwRoundupMissBacklogResults, pushFallbackUsageResults, getDigestSubject, getPlaybookEntry, isActionableResult, errorSetFingerprint, isEscalationDay, updateErrorFingerprint, sendEmailDigest, HEALTH_DIGEST_SNAPSHOT_FILE, batchStateResult, checkBatchState, checkMainRedStreak, checkCiGreenRate, checkCiMidSetupCancels, checkSharedCheckoutShallow, computeCoreHealthResults, checkQuality, checkStuckPipelineItems, checkDataFreshnessGaps, dataFreshnessGapsResult, DATA_FRESHNESS_GAPS_CHECK, checkAutofixEffectiveness, checkAutofixCanary, checkAutofixThroughput, checkUntrackedPersistentRows, checkDigestInvariantFail, checkAlertRouterDeadman, checkCommercialModelDrift, checkCommercialPendingQueue, checkExemptCronLiveness, checkUncollectedStrands };
