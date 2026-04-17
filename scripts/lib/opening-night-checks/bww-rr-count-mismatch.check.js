'use strict';

const { fetchPage } = require('../scraper');
const { countBwwRrOutlets } = require('../bww-rr-scraper');

const name = 'bww-rr-count-mismatch';
const description = 'BWW Review Roundup lists more reviews than we have in our database (>3 gap)';

const MISMATCH_THRESHOLD = 3;

/**
 * @param {Object} show
 * @param {import('./types').CheckContext} context
 * @returns {Promise<import('./types').CheckResult>}
 */
async function run(show, context) {
  const rrUrl = show.bwwRoundupUrl;

  if (!rrUrl) {
    return {
      ok: true,
      severity: 'warning',
      message: 'No bwwRoundupUrl on show — checklist cannot verify RR parity',
    };
  }

  // Count our BWW reviews (included, not wrongProduction)
  const allReviews = context.reviewsDoc[show.id] || [];
  const ourBwwCount = allReviews.filter(
    r => r.outletId === 'broadway-world' && r.wrongProduction !== true
  ).length;

  let rrCount;
  try {
    const html = await fetchPage(rrUrl);
    rrCount = countBwwRrOutlets(html);
  } catch (err) {
    return {
      ok: true,
      severity: 'warning',
      message: `Could not fetch BWW RR page (${err.message}) — skipping parity check`,
      details: { rrUrl },
    };
  }

  if (rrCount === 0) {
    return {
      ok: true,
      severity: 'warning',
      message: `BWW RR page fetched but could not parse review count — manual check needed: ${rrUrl}`,
      details: { rrUrl, ourBwwCount },
    };
  }

  const gap = rrCount - ourBwwCount;

  if (gap > MISMATCH_THRESHOLD) {
    return {
      ok: false,
      severity: 'error',
      message: `BWW Review Roundup shows ${rrCount} reviews but we have ${ourBwwCount} — gap of ${gap} exceeds threshold ${MISMATCH_THRESHOLD}: ${rrUrl}`,
      details: { rrUrl, rrCount, ourBwwCount, gap },
    };
  }

  return {
    ok: true,
    severity: 'ok',
    message: `BWW RR parity ok — RR: ${rrCount}, ours: ${ourBwwCount}, gap: ${gap}`,
    details: { rrUrl, rrCount, ourBwwCount, gap },
  };
}

module.exports = { name, description, run };
