'use strict';

/**
 * BWW Review Roundup count mismatch — also produces `details.missingReviews`
 * so the checklist runner can proactively create stub review files via
 * createReviewFile (the canonical review-write primitive).
 *
 * Behavior:
 *   - Fetches the BWW RR page
 *   - Extracts the full review list via extractBWWRoundupReviews (includes
 *     outlet + critic metadata that countBwwRrOutlets can't give us)
 *   - Diffs against local review-texts/{showId}/ via findExistingReviewFile
 *     (3-pass dedup — filename, internal outletId, shared-domain) so we don't
 *     re-stub every hour when a URL is still pending discovery.
 *   - Returns details.missingReviews for the checklist runner to act on
 *   - Keeps the existing Discord 'error' severity at gap >= 3 (noisy alert
 *     threshold); stub-writing fires on gap > 0 via the runner.
 */

const fs = require('fs');
const path = require('path');

const { fetchPage } = require('../scraper');
const { extractBWWRoundupReviews } = require('../../gather-reviews');
const { normalizeOutlet, findExistingReviewFile } = require('../review-normalization');
const { discoverBwwRoundupUrl } = require('../bww-rr-discover');

const name = 'bww-rr-count-mismatch';
const description = 'BWW Review Roundup lists more reviews than we have in our database (>3 gap)';

const ALERT_THRESHOLD = 3;

/**
 * @param {Object} show
 * @param {import('./types').CheckContext} context
 * @returns {Promise<import('./types').CheckResult>}
 */
async function run(show, context) {
  let rrUrl = show.bwwRoundupUrl;

  // Fallback: if shows.json doesn't have the RR URL yet, try live discovery
  // via reviews.php (same primitive the poller uses). Requires Browserbase.
  // Off-Broadway / West End shows rarely have BWW RRs — skip for them.
  if (!rrUrl) {
    const cat = show.category || 'broadway'; // default broadway — that's where BWW RRs live
    // BWW RRs are Broadway-focused. Off-Broadway rare; West End doesn't get RRs.
    if (cat !== 'broadway' && cat !== 'off-broadway') {
      return {
        ok: true,
        severity: 'ok',
        message: `BWW RR doesn't apply to ${cat} shows — skipping`,
      };
    }
    if (!process.env.BROWSERBASE_API_KEY || !process.env.BROWSERBASE_PROJECT_ID) {
      return {
        ok: true,
        severity: 'warning',
        message: 'No bwwRoundupUrl on show + Browserbase not configured — cannot verify RR parity',
      };
    }
    try {
      const discovery = await discoverBwwRoundupUrl(show);
      if (discovery.url) {
        rrUrl = discovery.url;
      } else {
        return {
          ok: true,
          severity: 'ok',
          message: `No BWW RR for ${show.id} yet (reviews.php doesn't list it) — checked live`,
        };
      }
    } catch (err) {
      return {
        ok: true,
        severity: 'warning',
        message: `BWW RR discovery error (${err?.message || String(err)}) — skipping parity check`,
      };
    }
  }

  // Note: the old check counted reviews with outletId === 'broadway-world', but
  // BWW RR is an AGGREGATOR of OTHER outlets' reviews — nothing is attributed to
  // 'broadway-world' itself. The correct metric is: of the reviews BWW RR lists,
  // how many do we already have in our review-texts folder? That's computed
  // below via findExistingReviewFile, after extraction.

  let html;
  try {
    const res = await fetchPage(rrUrl);
    // fetchPage returns { content, format, source } on success, null on total failure.
    // Legacy callers passed the result as html directly — accept both shapes.
    html = res?.content || (typeof res === 'string' ? res : null);
    if (!html) {
      return {
        ok: true,
        severity: 'warning',
        message: `BWW RR fetch returned no content — skipping parity check`,
        details: { rrUrl },
      };
    }
  } catch (err) {
    return {
      ok: true,
      severity: 'warning',
      message: `Could not fetch BWW RR page (${err?.message || String(err)}) — skipping parity check`,
      details: { rrUrl },
    };
  }

  // Extract full review metadata (not just count) so we can diff by (outlet, critic).
  let extracted;
  try {
    extracted = extractBWWRoundupReviews(html, show.id, rrUrl, show.title) || [];
  } catch (err) {
    return {
      ok: true,
      severity: 'warning',
      message: `BWW RR extractor threw (${err?.message || String(err)}) — skipping parity check`,
      details: { rrUrl, ourBwwCount },
    };
  }

  const rrCount = extracted.length;
  if (rrCount === 0) {
    return {
      ok: true,
      severity: 'warning',
      message: `BWW RR page fetched but extractor found 0 reviews — manual check needed: ${rrUrl}`,
      details: { rrUrl },
    };
  }

  // Diff: for each extracted review, see if we already have a review file
  // for that (outletId, criticName). Use the 3-pass findExistingReviewFile
  // to catch filename/outlet-alias collisions — URL-only diff would
  // re-stub every hour for stubs that don't yet have a URL attached.
  const showDir = path.join(context.reviewTextsRoot, show.id);
  const dirExists = fs.existsSync(showDir);
  const missingReviews = [];

  for (const r of extracted) {
    // extractBWWRoundupReviews returns outletRaw (display name like "The New York Times")
    // not a canonical outletId. Normalize to the registry's outletId.
    const outletRaw = r.outletId || r.outlet || r.outletRaw || null;
    const normalized = outletRaw ? normalizeOutlet(outletRaw) : null;
    const outletId = normalized?.id || outletRaw || null;
    const criticName = r.criticName || null;
    const url = r.url || r.reviewUrl || null;

    if (!outletId) continue; // can't dedup without at least an outlet
    const existingFile = dirExists
      ? findExistingReviewFile(showDir, outletId, criticName)
      : null;
    if (existingFile) continue;

    missingReviews.push({
      outletId,
      outlet: normalized?.displayName || outletRaw,
      criticName,
      url,
      source: 'bww-rr-remediation',
    });
  }

  // gap = number of BWW-listed reviews we don't have a local file for
  const gap = missingReviews.length;
  const haveCount = rrCount - gap;
  const details = {
    rrUrl,
    rrCount,
    haveCount,
    gap,
    missingReviews,  // ← consumed by opening-night-checklist.js post-check step
  };

  // Severity = warning (NOT error) even when gap is large. Reason: this check
  // emits details.missingReviews, which the checklist's remediation step uses
  // to auto-create stubs. Stubs flow through the existing 10-min poller →
  // collect → rebuild → score chain. Using 'error' would block the broadcast
  // workflow (which gates on any error in the checklist) during the normal
  // ingestion catch-up window where gap can legitimately hit 5+ for minutes.
  if (gap > ALERT_THRESHOLD) {
    return {
      ok: true,
      severity: 'warning',
      message: `BWW Review Roundup shows ${rrCount} reviews, we have ${haveCount} — gap of ${gap} missing (stubs queued for remediation): ${rrUrl}`,
      details,
    };
  }

  return {
    ok: true,
    severity: 'ok',
    message: `BWW RR parity ok — RR: ${rrCount}, ours: ${haveCount}, gap: ${gap}${gap > 0 ? ` (queued for stub)` : ''}`,
    details,
  };
}

module.exports = { name, description, run };
