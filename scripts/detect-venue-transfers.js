#!/usr/bin/env node
/**
 * detect-venue-transfers.js
 *
 * Surfaces shows whose EARLIER-VENUE reviews are being silently discarded as
 * wrongProduction because the production transferred venues (e.g. My Neighbour
 * Totoro: Barbican 2022 → Gillian Lynne 2025) but the single show entry carries
 * only the current run's openingDate.
 *
 * The fix for a confirmed transfer is to declare the earlier run in the show's
 * `priorRuns: [{ venue, openingDate, closingDate }]` array — the rebuild's
 * production-continuity auto-clear (scripts/lib/wrong-production-autoclear.js)
 * then re-includes the in-window reviews automatically.
 *
 * This script does NOT auto-edit shows.json: a cluster of pre-opening
 * wrongProduction reviews can be EITHER a venue transfer of the same production
 * OR a genuinely separate revival years earlier. The decisive signal we CAN
 * compute is "does a separate show entry already exist that houses those
 * reviews?" — if yes, they're correctly routed elsewhere; if no, they're being
 * lost and a human should confirm transfer vs separate-revival.
 *
 * Output:
 *   - data/audit/possible-venue-transfers.json  (machine-readable, ranked)
 *   - ranked console report
 *
 * Modes:
 *   (default)        write audit + print report
 *   --json           print the audit JSON to stdout only
 *   --ci             exit 1 if any NEW high-confidence candidate exists that is
 *                    not yet covered by priorRuns (use as a non-silent gate so
 *                    future transfers get noticed instead of dropping reviews)
 *   --min-reviews=N  minimum discarded reviews to flag a show (default 3)
 *   --gap-days=N     minimum days a discarded review must predate opening (default 180)
 *   --show=ID        restrict to one show (debugging)
 */

const fs = require('fs');
const path = require('path');
const { parseDate } = require('./lib/date-utils');
const { normalizeTitle } = require('./lib/title-normalization');
const { isWithinPriorRun } = require('./lib/wrong-production-autoclear');

let getTier;
try { ({ getTier } = require('./lib/outlet-tiers')); } catch { getTier = () => 3; }

const ROOT = path.resolve(__dirname, '..');
const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');
const TEXTS_DIR = path.join(ROOT, 'data', 'review-texts');
const OUT_PATH = path.join(ROOT, 'data', 'audit', 'possible-venue-transfers.json');

const argv = process.argv.slice(2);
const getOpt = (name, def) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : def;
};
const MIN_REVIEWS = parseInt(getOpt('min-reviews', '3'), 10);
const GAP_DAYS = parseInt(getOpt('gap-days', '180'), 10);
const ONLY_SHOW = getOpt('show', null);
const JSON_ONLY = argv.includes('--json');
const CI_MODE = argv.includes('--ci');

const DAY_MS = 86400000;

// Recover the date a date-guard flagger acted on: publishDate when parseable,
// else the first ISO date embedded in the flag note/reason (premiere-era files
// often have a null/year-less publishDate but the note records the real date).
function effectiveDate(d) {
  if (d.publishDate) {
    const pd = parseDate(d.publishDate);
    if (pd && !isNaN(pd.getTime())) return pd;
  }
  const blob = `${d.wrongProductionNote || ''} ${d.wrongProductionReason || ''}`;
  const m = blob.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (m) {
    const pd = parseDate(m[1]);
    if (pd && !isNaN(pd.getTime())) return pd;
  }
  return null;
}

// A genuine venue transfer / return engagement clusters tightly (one run, or a
// premiere + return a year or two apart). A wide span on a common revival title
// (Hamlet, Romeo & Juliet, A Christmas Carol) instead signals MANY distinct
// productions with no per-production sibling entry — a blanket priorRuns would
// wrongly inherit unrelated reviews, so those need a manual split. The tight
// threshold admits double-run productions but excludes decade-spanning title
// collisions.
const SPAN_TIGHT_DAYS = 550;

/**
 * Pure classification: given whether a same-title sibling entry already houses
 * the discarded reviews, and how wide the discarded cluster spans, decide what
 * kind of candidate this is.
 *   - 'routed-elsewhere'  → reviews belong to an existing sibling entry (no loss)
 *   - 'likely-transfer'   → tight cluster, no sibling → confirm + add priorRuns
 *   - 'wide-span-review'  → wide cluster → multi-production OR long tour, manual
 * @param {{ sibling: string|null, spanDays: number }} o
 * @returns {string}
 */
function classifyCandidate({ sibling, spanDays }) {
  if (sibling) return 'routed-elsewhere';
  if (spanDays <= SPAN_TIGHT_DAYS) return 'likely-transfer';
  return 'wide-span-review';
}

// A note/reason that says the review's URL belongs in a named sibling entry is
// already recoverable elsewhere — not a lost transfer.
function isRoutedToSibling(d) {
  const blob = `${d.wrongProductionNote || ''} ${d.wrongProductionReason || ''}`;
  return /belongs in\b|correctly belongs|routed to\b/i.test(blob);
}

function main() {
  const showsRaw = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const shows = Array.isArray(showsRaw) ? showsRaw : showsRaw.shows;

  // Index shows by normalized title for sibling lookup.
  const byTitle = new Map();
  for (const s of shows) {
    if (!s || !s.title) continue;
    const key = normalizeTitle(s.title);
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(s);
  }

  // Does a DIFFERENT same-title show entry plausibly house a review at `date`?
  // We treat a sibling as covering the date if it falls within
  // [previewsStartDate||openingDate - 30d .. closingDate||openingDate + 365d].
  function siblingCovers(show, date) {
    const sibs = byTitle.get(normalizeTitle(show.title)) || [];
    for (const sib of sibs) {
      if (sib.id === show.id) continue;
      const open = parseDate(sib.previewsStartDate || sib.openingDate);
      if (!open || isNaN(open.getTime())) continue;
      const lo = open.getTime() - 30 * DAY_MS;
      const closeRaw = parseDate(sib.closingDate);
      const hi = (closeRaw && !isNaN(closeRaw.getTime()))
        ? closeRaw.getTime() + 30 * DAY_MS
        : open.getTime() + 365 * DAY_MS;
      if (date.getTime() >= lo && date.getTime() <= hi) return sib.id;
    }
    return null;
  }

  const candidates = [];
  const showList = ONLY_SHOW ? shows.filter((s) => s && s.id === ONLY_SHOW) : shows;

  for (const show of showList) {
    if (!show || !show.id || !show.openingDate) continue;
    const opening = parseDate(show.openingDate);
    if (!opening || isNaN(opening.getTime())) continue;
    const dir = path.join(TEXTS_DIR, show.id);
    if (!fs.existsSync(dir)) continue;

    let files;
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { continue; }

    const discarded = [];
    let majorCount = 0;
    let routedAway = 0;
    for (const f of files) {
      let d;
      try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      if (d.wrongProduction !== true) continue;
      // Already recoverable via a declared priorRun → not a loss.
      const eff = effectiveDate(d);
      if (eff && isWithinPriorRun(eff, show.priorRuns)) continue;
      // Already routed to a named sibling entry → not a loss.
      if (isRoutedToSibling(d)) { routedAway++; continue; }
      // Content problems (wrong SHOW, roundup) are not transfer losses.
      if (d.wrongShow === true || d.isRoundupArticle === true) continue;
      if (d.contentVerification?.wrongArticle === true) continue;
      if (!eff) continue;
      const gap = (opening.getTime() - eff.getTime()) / DAY_MS;
      if (gap < GAP_DAYS) continue; // not a clearly-earlier run

      const tier = (() => { try { return getTier(d.outletId || d.outlet) || 3; } catch { return 3; } })();
      if (tier <= 2) majorCount++;
      discarded.push({ file: f.replace('.json', ''), date: eff.toISOString().slice(0, 10), tier, outlet: d.outlet || d.outletId });
    }

    if (discarded.length < MIN_REVIEWS) continue;

    discarded.sort((a, b) => a.date.localeCompare(b.date));
    const dates = discarded.map((x) => x.date);
    const median = dates[Math.floor(dates.length / 2)];
    const sibling = siblingCovers(show, parseDate(median));
    const spanDays = Math.round(
      (parseDate(dates[dates.length - 1]).getTime() - parseDate(dates[0]).getTime()) / DAY_MS
    );
    const classification = classifyCandidate({ sibling, spanDays });

    candidates.push({
      showId: show.id,
      title: show.title,
      openingDate: show.openingDate,
      currentVenue: show.venue || null,
      hasPriorRuns: Array.isArray(show.priorRuns) && show.priorRuns.length > 0,
      discardedCount: discarded.length,
      majorOutletCount: majorCount,
      routedToSibling: routedAway,
      dateRange: `${dates[0]} .. ${dates[dates.length - 1]}`,
      spanDays,
      siblingEntryCovers: sibling, // if set → reviews likely belong to that entry, NOT a transfer
      classification,
      // weight: more discarded + more major outlets ranks higher
      weight: discarded.length * (1 + majorCount),
      discarded,
    });
  }

  candidates.sort((a, b) => b.weight - a.weight);

  const likelyTransfers = candidates.filter((c) => c.classification === 'likely-transfer' && !c.hasPriorRuns);

  const audit = {
    generatedAt: new Date().toISOString().slice(0, 10),
    params: { minReviews: MIN_REVIEWS, gapDays: GAP_DAYS },
    summary: {
      totalCandidates: candidates.length,
      likelyTransfersNeedingPriorRuns: likelyTransfers.length,
    },
    candidates,
  };

  if (JSON_ONLY) {
    process.stdout.write(JSON.stringify(audit, null, 2) + '\n');
  } else {
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, JSON.stringify(audit, null, 2) + '\n');
    console.log(`\nVenue-transfer scan — ${candidates.length} candidate show(s), ${likelyTransfers.length} likely transfer(s) needing priorRuns\n`);
    const top = candidates.slice(0, 30);
    for (const c of top) {
      let tag;
      if (c.classification === 'routed-elsewhere') tag = `routed→${c.siblingEntryCovers}`;
      else if (c.classification === 'wide-span-review') tag = 'wide-span (manual: multi-production?)';
      else tag = c.hasPriorRuns ? 'has-priorRuns' : 'NEEDS priorRuns';
      console.log(
        `${String(c.weight).padStart(4)}  ${c.showId}`.padEnd(58) +
        `| ${c.discardedCount} disc (${c.majorOutletCount} maj) | ${c.dateRange} | ${String(c.spanDays).padStart(4)}d | ${tag}`
      );
    }
    console.log(`\nWrote ${OUT_PATH}`);
    if (likelyTransfers.length) {
      console.log('\nLikely transfers to confirm + add priorRuns (same production, earlier venue, no sibling entry):');
      likelyTransfers.slice(0, 15).forEach((c) =>
        console.log(`  • ${c.showId} — ${c.discardedCount} reviews (${c.majorOutletCount} major), ${c.dateRange}`));
    }
  }

  if (CI_MODE) {
    // Non-silent gate: a NEW high-confidence transfer (≥1 major outlet) with no
    // priorRuns means reviews are being dropped — surface it loudly.
    const blocking = likelyTransfers.filter((c) => c.majorOutletCount >= 1);
    if (blocking.length) {
      console.error(`\n::warning::${blocking.length} show(s) appear to be venue transfers dropping major-outlet reviews — add priorRuns: ${blocking.map((c) => c.showId).join(', ')}`);
      process.exit(1);
    }
  }
}

module.exports = { classifyCandidate, effectiveDate, SPAN_TIGHT_DAYS };

if (require.main === module) main();
