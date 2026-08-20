'use strict';

/**
 * DTLI count mismatch — same shape as bww-rr-count-mismatch.
 *
 * Resolves the DTLI page from data/dtli-slug-map.json (already populated
 * weekly by scripts/discover-dtli-slugs.js). Does NOT call the live
 * discoverDtliSlug here — that would fire from the hourly checklist and
 * burn credits; the poller already runs discover on its 10-min cadence.
 *
 * For shows with a mapped slug: fetchPage (DTLI is open web, no Browserbase)
 * → extractDTLIReviews → diff against local via findExistingReviewFile →
 * return details.missingReviews for the checklist runner to act on.
 */

const fs = require('fs');
const path = require('path');

const { fetchPage } = require('../scraper');
const { extractDTLIReviews } = require('../../gather-reviews');
const { normalizeOutlet, findExistingReviewFile } = require('../review-normalization');
const { llmFallbackExtractIfNeeded } = require('../llm-extractor');

const DTLI_SLUG_MAP_PATH = path.join(__dirname, '..', '..', '..', 'data', 'dtli-slug-map.json');

const name = 'dtli-count-mismatch';
const description = 'DTLI lists more reviews than we have in our database (>3 gap)';

const ALERT_THRESHOLD = 3;

// Broadway + off-Broadway only — DTLI doesn't cover West End
function isInDtliScope(show) {
  const cat = show.category || 'broadway';
  return cat === 'broadway' || cat === 'off-broadway';
}

function getDtliUrlForShow(showId) {
  try {
    const raw = JSON.parse(fs.readFileSync(DTLI_SLUG_MAP_PATH, 'utf8'));
    const map = raw.shows || raw;
    let slug = map[showId];
    if (!slug) return null;
    if (slug.startsWith('shows/')) slug = slug.slice(6);
    return `https://didtheylikeit.com/shows/${slug}/`;
  } catch (_) {
    return null;
  }
}

/**
 * @param {Object} show
 * @param {import('./types').CheckContext} context
 * @returns {Promise<import('./types').CheckResult>}
 */
async function run(show, context) {
  if (!isInDtliScope(show)) {
    return {
      ok: true,
      severity: 'ok',
      message: `DTLI not applicable for ${show.category || 'unknown'} market`,
    };
  }

  const dtliUrl = getDtliUrlForShow(show.id);
  if (!dtliUrl) {
    return {
      ok: true,
      severity: 'warning',
      message: `No DTLI slug for ${show.id} in dtli-slug-map.json — weekly discover may not have run yet, or show predates DTLI coverage`,
    };
  }

  // Note: DTLI is an aggregator of other outlets' reviews. Like BWW RR, the
  // correct metric is "of the reviews DTLI lists, how many do we already have"
  // — computed via findExistingReviewFile below after extraction.

  let html;
  try {
    const res = await fetchPage(dtliUrl);
    html = res?.content || (typeof res === 'string' ? res : null);
    if (!html) {
      return {
        ok: true,
        severity: 'warning',
        message: `DTLI fetch returned no content — skipping parity check`,
        details: { dtliUrl },
      };
    }
  } catch (err) {
    return {
      ok: true,
      severity: 'warning',
      message: `Could not fetch DTLI page (${err?.message || String(err)}) — skipping parity check`,
      details: { dtliUrl },
    };
  }

  let extracted;
  try {
    extracted = extractDTLIReviews(html, show.id, dtliUrl, show.title) || [];
    // Same LLM fallback gather-reviews.js uses (zero AND partial triggers) — this
    // check calls the same regex extractor, so it's blind to the exact format
    // changes it exists to catch unless it gets the same resilience.
    extracted = await llmFallbackExtractIfNeeded(html, extracted, {
      aggregator: 'dtli', showTitle: show.title, showId: show.id,
    });
  } catch (err) {
    return {
      ok: true,
      severity: 'warning',
      message: `DTLI extractor threw (${err?.message || String(err)}) — skipping parity check`,
      details: { dtliUrl },
    };
  }

  const dtliCount = extracted.length;
  if (dtliCount === 0) {
    return {
      ok: true,
      severity: 'warning',
      message: `DTLI page fetched but extractor found 0 reviews — manual check needed: ${dtliUrl}`,
      details: { dtliUrl },
    };
  }

  const showDir = path.join(context.reviewTextsRoot, show.id);
  const dirExists = fs.existsSync(showDir);
  const missingReviews = [];

  for (const r of extracted) {
    const outletRaw = r.outletId || r.outlet || r.outletRaw || null;
    const normalized = outletRaw ? normalizeOutlet(outletRaw) : null;
    const outletId = normalized?.id || outletRaw || null;
    const criticName = r.criticName || null;
    const url = r.url || r.reviewUrl || null;

    if (!outletId) continue;
    const existingFile = dirExists
      ? findExistingReviewFile(showDir, outletId, criticName)
      : null;
    if (existingFile) continue;

    missingReviews.push({
      outletId,
      outlet: normalized?.displayName || outletRaw,
      criticName,
      url,
      source: 'dtli-remediation',
    });
  }

  const gap = missingReviews.length;
  const haveCount = dtliCount - gap;
  const details = { dtliUrl, dtliCount, haveCount, gap, missingReviews };

  // See bww-rr-count-mismatch: severity stays at warning even for large gaps
  // because auto-remediation queues stubs immediately.
  if (gap > ALERT_THRESHOLD) {
    return {
      ok: true,
      severity: 'warning',
      message: `DTLI shows ${dtliCount} reviews, we have ${haveCount} — gap of ${gap} missing (stubs queued for remediation): ${dtliUrl}`,
      details,
    };
  }

  return {
    ok: true,
    severity: 'ok',
    message: `DTLI parity ok — DTLI: ${dtliCount}, ours: ${haveCount}, gap: ${gap}${gap > 0 ? ` (queued for stub)` : ''}`,
    details,
  };
}

module.exports = { name, description, run };
