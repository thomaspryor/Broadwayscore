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
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SHOWS_PATH = path.join(DATA_DIR, 'shows.json');
const PENDING_PATH = path.join(DATA_DIR, 'commercial-pending-review.json');
const ARCHIVE_PATH = path.join(DATA_DIR, 'commercial-pending-archive.json');
const QUEUE_PATH = path.join(DATA_DIR, 'commercial-research-queue.json');

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
const { hasRecoupedClaim } = require('./lib/commercial-apply-gate');
const { isCommercialScope, resolveScopeShow } = require('./lib/commercial-scope');

function classifyEntry(slug, entry, showsBySlug) {
  // Out-of-scope (Off-Broadway / West End) entries must never re-enter the
  // research queue — archive them so the leak drains instead of cycling.
  // Deliberately checked BEFORE hasRecoupedClaim: an out-of-scope recouped
  // claim is archived, not surfaced to Notion for human review.
  const scopeShow = resolveScopeShow(showsBySlug, slug, entry);
  if (scopeShow && !isCommercialScope(scopeShow)) {
    return { action: 'archive', reason: `out of commercial scope (${scopeShow.category})` };
  }

  if (hasRecoupedClaim(entry)) {
    return { action: 'report', reason: 'recouped-claim — needs human review' };
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

  const pending = loadJSON(PENDING_PATH, { shows: {} });
  const archive = loadJSON(ARCHIVE_PATH, { shows: {} });
  const queueFile = loadJSON(QUEUE_PATH, { shows: [], triggers: {} });

  pending.shows = pending.shows || {};
  archive.shows = archive.shows || {};
  queueFile.shows = queueFile.shows || [];
  queueFile.triggers = queueFile.triggers || {};

  const buckets = { requeue: [], archive: [], report: [], keep: [] };
  for (const [slug, entry] of Object.entries(pending.shows)) {
    const { action, reason } = classifyEntry(slug, entry, showsBySlug);
    buckets[action].push({ slug, entry, reason });
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
  console.log(`  report (recouped-claim → Notion): ${buckets.report.length}`);
  console.log(`  keep: ${buckets.keep.length}`);
  console.log('');

  if (DRY_RUN) {
    console.log('[dry-run] no writes. Sample of each bucket:');
    for (const k of ['archive', 'requeue', 'report']) {
      for (const it of buckets[k].slice(0, 3)) {
        console.log(`  [${k}] ${it.slug} — ${it.reason}`);
      }
    }
    return;
  }

  const now = new Date().toISOString();

  // Archive
  for (const { slug, entry, reason } of archivedActions) {
    archive.shows[slug] = {
      ...entry,
      archivedAt: now,
      archivedReason: reason.startsWith('out of commercial scope')
        ? 'out-of-commercial-scope'
        : 'low-confidence-aged-out',
    };
    delete pending.shows[slug];
  }
  if (archivedActions.length > 0) {
    archive.lastUpdated = now;
    writeJSON(ARCHIVE_PATH, archive);
  }

  // Requeue (push into commercial-research-queue.json, tag with trigger reason).
  // The queue is consumed by deep-research-commercial.js at its next run.
  for (const { slug, entry } of requeuedActions) {
    if (!queueFile.shows.includes(slug)) queueFile.shows.push(slug);
    queueFile.triggers[slug] = 'sweep-requeue-low-conf';
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
    recoupedClaims: buckets.report.map(({ slug, entry, reason }) => ({
      slug,
      reason,
      confidence: entry.confidence,
      sourceHost: entry.sourceHost || null,
      recoupedDate: entry.recoupedDate || null,
      recoupedSource: entry.recoupedSource || null,
      evidence: entry.evidence || null,
      detectedBy: entry.detectedBy || null,
      researchedAt: entry.researchedAt || null,
    })),
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

main();
