#!/usr/bin/env node
/**
 * Sweep Pending Commercial — TTL + archival
 *
 * The pending-review file accumulates indefinitely: deep-research finds with
 * low confidence sit forever, scraper finds rot, and there's no human-attention
 * surfacing path for the high-signal entries. This sweep runs from the Sunday
 * orchestrator and does three things:
 *
 *   1. REQUEUE  — low-confidence entries that have been pending >14 days and
 *                 whose show opened >30 days ago get pushed back into
 *                 commercial-research-queue.json for the next deep-research
 *                 pass. Cooldown via `lastRequeuedAt` so the same show doesn't
 *                 re-queue every Sunday.
 *
 *   2. ARCHIVE  — low-confidence entries that have been pending >180 days AND
 *                 still claim recouped:false get moved to
 *                 commercial-pending-archive.json (so the scraper can detect
 *                 prior rejections — see scrape-recoupment-announcements.js
 *                 isRejectedInArchive). Deleted from pending.
 *
 *   3. REPORT   — recouped-claim entries (entry.recouped===true ||
 *                 entry._recoupedClaim===true) are emitted to stdout as JSON
 *                 for the Notion sweep step to consume. Sweep doesn't touch
 *                 these — humans (via Notion) decide.
 *
 * Per-action budgets prevent the first-ever run from spiking spend or flooding
 * Notion when the 554-entry backlog hits the rules simultaneously.
 *
 * Usage:
 *   node scripts/sweep-pending-commercial.js                   # live sweep
 *   node scripts/sweep-pending-commercial.js --dry-run         # print plan
 *   node scripts/sweep-pending-commercial.js --report-json=/tmp/r.json
 *   node scripts/sweep-pending-commercial.js --requeue-cap=20 --archive-cap=50
 *   node scripts/sweep-pending-commercial.js --reject=<pending-key> --reason="<why>"
 *       A person rejects one recouped claim. The claim's source URLs go into
 *       the archive under the show slug (rejectedSources), which the Friday
 *       scraper and deep research both check before filing the same claim
 *       again. A held backfill row (BRO-4990) keeps its research and loses
 *       only the claim; any other row moves to the archive.
 *
 * Recouped claims are triaged first (lib/commercial-claim-triage.js): a stale
 * duplicate is left for reconcile-recoupment-claims.js to close (or, on a held
 * row the reconciler skips, has its claim stripped), and a wrong-production
 * claim is rejected. Only the rest are reported for a person.
 */

require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const { buildShowKeyIndex, resolveCommercialSlug } = require('./lib/commercial-slug-key');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SHOWS_PATH = path.join(DATA_DIR, 'shows.json');
const PENDING_PATH = path.join(DATA_DIR, 'commercial-pending-review.json');
const ARCHIVE_PATH = path.join(DATA_DIR, 'commercial-pending-archive.json');
const QUEUE_PATH = path.join(DATA_DIR, 'commercial-research-queue.json');
const COMMERCIAL_PATH = path.join(DATA_DIR, 'commercial.json');

const args = process.argv.slice(2);
const flags = {};
for (const a of args) {
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    flags[k] = v === undefined ? true : v;
  }
}
const DRY_RUN = flags['dry-run'] === true;
const REPORT_JSON_PATH = flags['report-json'] || null;
const REJECT_KEY = typeof flags['reject'] === 'string' ? flags['reject'] : null;
const REJECT_REASON = typeof flags['reason'] === 'string' ? flags['reason'] : null;
// Use intOr() (not `parseInt(...) || default`) so `--archive-cap=0` doesn't get
// silently coerced to the default — 0 is a valid cap meaning "no archive this
// run." Same trap as `parseInt(x) || 30` silently coercing 0 to 30 in
// batch-commercial-research.js:67-69.
const intOr = (k, def) => {
  if (flags[k] === undefined || flags[k] === true) return def;
  const n = parseInt(flags[k], 10);
  return Number.isNaN(n) ? def : n;
};
const REQUEUE_CAP = intOr('requeue-cap', 20);
const ARCHIVE_CAP = intOr('archive-cap', 50);
const REQUEUE_AGE_DAYS = intOr('requeue-age-days', 14);
const ARCHIVE_AGE_DAYS = intOr('archive-age-days', 180);
const SHOW_OPENED_MIN_DAYS = intOr('show-opened-min-days', 30);
const REQUEUE_COOLDOWN_DAYS = intOr('requeue-cooldown-days', 30);

function loadJSON(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function writeJSON(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}

function daysAgo(isoString) {
  if (!isoString) return Infinity;
  const t = new Date(isoString).getTime();
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / 86_400_000;
}

// Shared with apply-commercial-pending.js — same `_recoupedClaim || recouped`
// semantics. Don't redefine inline; reuse so the rules stay in lockstep.
const { hasRecoupedClaim, isReviewHold, requiresHumanReview, withoutRecoupmentClaim } = require('./lib/commercial-apply-gate');
const { triageRecoupedClaim, recordRejection, writeArchiveRecord } = require('./lib/commercial-claim-triage');
const { isCommercialScope, resolveScopeShow } = require('./lib/commercial-scope');

// ctx (optional): {commercialShows, showKeyIndex}, for recouped-claim triage.
// Without it every claim is reported, the pre-triage behavior.
function classifyEntry(slug, entry, showsBySlug, ctx) {
  // Out-of-scope (Off-Broadway / West End) entries must never re-enter the
  // research queue — archive them so the leak drains instead of cycling.
  // Deliberately checked BEFORE hasRecoupedClaim: an out-of-scope recouped
  // claim is archived, not surfaced to Notion for human review.
  const scopeShow = resolveScopeShow(showsBySlug, slug, entry);
  if (scopeShow && !isCommercialScope(scopeShow)) {
    return { action: 'archive', reason: `out of commercial scope (${scopeShow.category})` };
  }

  if (hasRecoupedClaim(entry)) {
    const triage = triageRecoupedClaim(slug, entry, ctx);
    // Same skip set as reconcile-recoupment-claims.js: it never closes these,
    // so a 'keep' would leave the claim uncarded forever.
    const held = requiresHumanReview(entry) || isReviewHold(entry);
    if (triage && triage.verdict === 'wrong-production') {
      // A held row keeps its unreviewed research for --release-held; only the claim goes.
      return held
        ? { action: 'strip', reason: triage.reason, rejectAs: triage.slug }
        : { action: 'archive', reason: triage.reason, rejectAs: triage.slug };
    }
    if (triage && triage.verdict === 'stale-duplicate') {
      // The reconciler closes unheld duplicates; it skips held rows, so strip those here.
      return held
        ? { action: 'strip', reason: triage.reason }
        : { action: 'keep', reason: `${triage.reason}; reconciler closes it` };
    }
    return { action: 'report', reason: 'recouped-claim — needs human review' };
  }

  // BRO-4990: held backfill rows (and their noData attempt records) wait for
  // a human. Archiving one would drop its attempt count and the Saturday
  // sweep would re-research the show at full price every ~180 days.
  if (requiresHumanReview(entry)) {
    return { action: 'keep', reason: 'held for human review (backfill)' };
  }

  const ageDays = daysAgo(entry.researchedAt);
  // Prefer the entry's own openingDate (always present from deep-research) over
  // shows.json lookup. Pending keys can be year-suffixed (ragtime-2025) while
  // shows.json keys aren't (ragtime), so key-based lookup misses. Fall back to
  // entry.slug → shows.json if the entry lacks an openingDate.
  let opened = entry.openingDate || null;
  if (!opened && entry.slug) {
    const show = showsBySlug[entry.slug];
    opened = show?.openingDate || show?.previewsStartDate || null;
  }
  if (!opened) {
    const show = showsBySlug[slug];
    opened = show?.openingDate || show?.previewsStartDate || null;
  }
  const showOpenedDays = daysAgo(opened);

  // Orphan: no opening date anywhere → don't sweep blindly. Surface in keep.
  if (showOpenedDays === Infinity) {
    return { action: 'keep', reason: 'no openingDate — orphan slug, manual cleanup' };
  }

  // Skip non-low confidence — only low-conf gets swept. Medium/high are kept
  // as-is and (if unapplied) surfaced by the Notion sweep separately.
  if (entry.confidence !== 'low') {
    return { action: 'keep', reason: `confidence=${entry.confidence}` };
  }

  if (ageDays > ARCHIVE_AGE_DAYS) {
    return { action: 'archive', reason: `pending ${Math.floor(ageDays)}d > ${ARCHIVE_AGE_DAYS}d` };
  }

  if (ageDays > REQUEUE_AGE_DAYS && showOpenedDays > SHOW_OPENED_MIN_DAYS) {
    const requeueAgeDays = daysAgo(entry.lastRequeuedAt);
    if (requeueAgeDays <= REQUEUE_COOLDOWN_DAYS) {
      return { action: 'keep', reason: `re-queued ${Math.floor(requeueAgeDays)}d ago (cooldown ${REQUEUE_COOLDOWN_DAYS}d)` };
    }
    return { action: 'requeue', reason: `low-conf ${Math.floor(ageDays)}d pending, show open ${Math.floor(showOpenedDays)}d` };
  }

  return { action: 'keep', reason: 'within thresholds' };
}

function main() {
  const allShows = loadJSON(SHOWS_PATH, { shows: [] });
  const showsArray = allShows.shows || allShows;
  const showsBySlug = {};
  for (const s of showsArray) {
    if (s.slug) showsBySlug[s.slug] = s;
    if (s.id) showsBySlug[s.id] = s;
  }
  const showKeyIndex = buildShowKeyIndex(showsArray);

  const pending = loadJSON(PENDING_PATH, { shows: {} });
  const archive = loadJSON(ARCHIVE_PATH, { shows: {} });
  const queueFile = loadJSON(QUEUE_PATH, { shows: [], triggers: {} });
  const commercialData = loadJSON(COMMERCIAL_PATH, null);
  if (!commercialData) console.log(`::warning::${COMMERCIAL_PATH} not readable; stale-duplicate triage off this run`);
  const ctx = { commercialShows: commercialData ? (commercialData.shows || commercialData) : null, showKeyIndex };

  pending.shows = pending.shows || {};
  archive.shows = archive.shows || {};
  queueFile.shows = queueFile.shows || [];
  queueFile.triggers = queueFile.triggers || {};

  if (REJECT_KEY) {
    rejectOne({ pending, archive, key: REJECT_KEY, reason: REJECT_REASON, showKeyIndex });
    return;
  }

  const buckets = { requeue: [], archive: [], strip: [], report: [], keep: [] };
  for (const [slug, entry] of Object.entries(pending.shows)) {
    const { action, reason, rejectAs } = classifyEntry(slug, entry, showsBySlug, ctx);
    buckets[action].push({ slug, entry, reason, rejectAs });
  }

  // Apply caps by priority: report has no cap (just listed), archive before
  // requeue (archive is cheaper / read-only on commercial data).
  const archivedActions = buckets.archive.slice(0, ARCHIVE_CAP);
  const requeuedActions = buckets.requeue.slice(0, REQUEUE_CAP);
  const archiveOverflow = buckets.archive.length - archivedActions.length;
  const requeueOverflow = buckets.requeue.length - requeuedActions.length;

  console.log('=== Sweep plan ===');
  console.log(`Pending total: ${Object.keys(pending.shows).length}`);
  console.log(`  archive: ${archivedActions.length} (overflow: ${archiveOverflow})`);
  console.log(`  requeue: ${requeuedActions.length} (overflow: ${requeueOverflow})`);
  console.log(`  strip claim (held rows): ${buckets.strip.length}`);
  console.log(`  report (recouped-claim → Linear): ${buckets.report.length}`);
  console.log(`  keep: ${buckets.keep.length}`);
  console.log('');

  if (DRY_RUN) {
    console.log('[dry-run] no writes. Sample of each bucket:');
    for (const k of ['archive', 'requeue', 'strip', 'report']) {
      for (const it of buckets[k].slice(0, 3)) {
        console.log(`  [${k}] ${it.slug} — ${it.reason}`);
      }
    }
    return;
  }

  const now = new Date().toISOString();

  // Archive
  for (const { slug, entry, reason, rejectAs } of archivedActions) {
    if (rejectAs) {
      recordRejection(archive, { slug: rejectAs, pendingKey: slug, entry, detail: reason, now });
    } else {
      writeArchiveRecord(archive, slug, {
        ...entry,
        archivedAt: now,
        archivedReason: reason.startsWith('out of commercial scope')
          ? 'out-of-commercial-scope'
          : 'low-confidence-aged-out',
      });
    }
    delete pending.shows[slug];
  }
  // Held rows (BRO-4990): drop only the claim, keep the research for a person.
  for (const { slug, entry, reason, rejectAs } of buckets.strip) {
    if (rejectAs) recordRejection(archive, { slug: rejectAs, pendingKey: slug, entry, detail: reason, now });
    pending.shows[slug] = { ...withoutRecoupmentClaim(entry), claimStripped: { at: now, reason } };
  }
  if (archivedActions.length > 0 || buckets.strip.some((it) => it.rejectAs)) {
    archive.lastUpdated = now;
    writeJSON(ARCHIVE_PATH, archive);
  }

  // Requeue (push into commercial-research-queue.json, tag with trigger reason).
  // The queue is consumed by deep-research-commercial.js at its next run.
  // Pending keys are often show IDs (batch research keys by show.id); the
  // queue must carry the SLUG, or deep-research researches "<id>" and writes
  // it back as entry.slug / commercial.shows[<id>] (BRO-4623).
  for (const { slug, entry } of requeuedActions) {
    const queueSlug = resolveCommercialSlug(slug, entry, showKeyIndex).slug;
    if (!queueFile.shows.includes(queueSlug)) queueFile.shows.push(queueSlug);
    queueFile.triggers[queueSlug] = 'sweep-requeue-low-conf';
    pending.shows[slug] = { ...entry, lastRequeuedAt: now };
  }
  if (requeuedActions.length > 0) {
    queueFile.updatedAt = now;
    writeJSON(QUEUE_PATH, queueFile);
  }

  pending.lastUpdated = now;
  writeJSON(PENDING_PATH, pending);

  // Emit report for Notion sweep step
  const report = {
    sweptAt: now,
    // Keyed by show SLUG so an ID-keyed row and its slug twin share one
    // Linear card; pendingKey is what --show / --reject take.
    recoupedClaims: dedupeBySlug(buckets.report.map(({ slug, entry, reason }) => ({
      slug: resolveCommercialSlug(slug, entry, showKeyIndex).slug,
      pendingKey: slug,
      reason,
      confidence: entry.confidence,
      sourceHost: entry.sourceHost || null,
      recoupedDate: entry.recoupedDate || null,
      recoupedSource: entry.recoupedSource || null,
      evidence: entry.evidence || null,
      detectedBy: entry.detectedBy || null,
      researchedAt: entry.researchedAt || null,
    }))),
    overflow: { archive: archiveOverflow, requeue: requeueOverflow },
  };
  if (REPORT_JSON_PATH) {
    writeJSON(REPORT_JSON_PATH, report);
    console.log(`Wrote sweep report → ${REPORT_JSON_PATH}`);
  }

  console.log(`✓ archived ${archivedActions.length}, requeued ${requeuedActions.length}`);
  if (buckets.report.length > 0) {
    console.log(`⚠ ${buckets.report.length} recouped-claim entries need human review (see Notion sweep step)`);
  }
}

function dedupeBySlug(items) {
  const seen = new Set();
  return items.filter((it) => (seen.has(it.slug) ? false : seen.add(it.slug)));
}

function rejectOne({ pending, archive, key, reason, showKeyIndex }) {
  const entry = pending.shows[key];
  if (!entry) {
    console.error(`FATAL: no pending entry "${key}"`);
    process.exit(1);
  }
  if (!hasRecoupedClaim(entry)) {
    console.error(`FATAL: "${key}" carries no recouped claim`);
    process.exit(1);
  }
  if (!reason || reason.length < 10) {
    console.error('FATAL: --reason="<why>" (10+ chars) is required with --reject');
    process.exit(1);
  }
  const slug = resolveCommercialSlug(key, entry, showKeyIndex).slug;
  const held = requiresHumanReview(entry) || isReviewHold(entry);
  console.log(`reject ${key} (show ${slug}, ${held ? 'held row: claim stripped, research kept' : 'row archived'}): ${reason}`);
  if (DRY_RUN) return;
  const now = new Date().toISOString();
  recordRejection(archive, { slug, pendingKey: key, entry, detail: reason, now });
  if (held) pending.shows[key] = { ...withoutRecoupmentClaim(entry), claimStripped: { at: now, reason } };
  else delete pending.shows[key];
  archive.lastUpdated = now;
  pending.lastUpdated = now;
  writeJSON(ARCHIVE_PATH, archive);
  writeJSON(PENDING_PATH, pending);
}

if (require.main === module) main();

module.exports = { classifyEntry };
