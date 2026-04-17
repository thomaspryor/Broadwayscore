'use strict';

const name = 'wrong-production-bww';
const description = 'BWW review URL date is >30d from show openingDate but not flagged wrongProduction';

const DATE_IN_URL_RE = /\/(\d{4})\/(\d{2})\//;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Extract YYYY-MM-DD from a URL path like /2025/03/article.html.
 * Returns null if no date found.
 * @param {string} url
 * @returns {Date|null}
 */
function extractUrlDate(url) {
  if (!url) return null;
  const m = url.match(DATE_IN_URL_RE);
  if (!m) return null;
  return new Date(`${m[1]}-${m[2]}-15`); // mid-month approximation
}

/**
 * @param {Object} show
 * @param {import('./types').CheckContext} context
 * @returns {import('./types').CheckResult}
 */
function run(show, context) {
  if (!show.openingDate) {
    return { ok: true, severity: 'ok', message: 'No openingDate on show — skipping BWW date check' };
  }

  const openingMs = new Date(show.openingDate).getTime();
  const reviews = (context.reviewsDoc[show.id] || []).filter(r => r.outletId === 'broadway-world');

  const problems = [];
  for (const review of reviews) {
    if (review.wrongProduction === true) continue;
    const urlDate = extractUrlDate(review.url);
    if (!urlDate) continue;
    const diff = Math.abs(urlDate.getTime() - openingMs);
    if (diff > THIRTY_DAYS_MS) {
      problems.push({
        url: review.url,
        urlDate: urlDate.toISOString().slice(0, 10),
        openingDate: show.openingDate,
        diffDays: Math.round(diff / (24 * 60 * 60 * 1000)),
      });
    }
  }

  if (problems.length === 0) {
    return { ok: true, severity: 'ok', message: `All ${reviews.length} BWW review(s) have matching URL dates` };
  }

  return {
    ok: false,
    severity: 'error',
    message: problems.map(p =>
      `BWW review URL dated ${p.urlDate} is ${p.diffDays}d from openingDate ${p.openingDate} but not flagged wrongProduction: ${p.url}`
    ).join('\n'),
    details: { problems },
  };
}

module.exports = { name, description, run, extractUrlDate };
