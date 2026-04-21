'use strict';

const fs = require('fs');
const path = require('path');

const name = 'publish-date-pre-opening';
const description = 'Shipped reviews with publishDate more than 1 day before openingDate are anticipatory posts, not actual reviews (catches the frontmezzjunkies 16-day-pre-opening class)';

// How many days before openingDate we allow. A day covers early press embargoes
// that lift the afternoon before opening. Two or more days out is an "anticipation"
// post about casting/previews, not an opening-night review.
const GRACE_DAYS_BEFORE_OPENING = 1;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function run(show, context) {
  const openingDate = parseDate(show.openingDate);
  if (!openingDate) {
    return { ok: true, severity: 'ok', message: 'No openingDate on show — skipping' };
  }

  const reviews = context.reviewsDoc[show.id] || [];
  if (reviews.length === 0) {
    return { ok: true, severity: 'ok', message: 'No shipped reviews — skipping' };
  }

  const cutoff = new Date(openingDate.getTime() - GRACE_DAYS_BEFORE_OPENING * MS_PER_DAY);
  const shippedByUrl = new Map(
    reviews.filter(r => r.url).map(r => [r.url, r])
  );

  const showDir = path.join(context.reviewTextsRoot, show.id);
  const sourceByUrl = new Map();
  if (fs.existsSync(showDir)) {
    try {
      for (const filename of fs.readdirSync(showDir).filter(f => f.endsWith('.json'))) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(showDir, filename), 'utf8'));
          if (data.url) sourceByUrl.set(data.url, { filename, data });
        } catch {
          // ignore parse errors — other plugins flag those
        }
      }
    } catch {
      // ignore readdir errors
    }
  }

  const violations = [];
  for (const review of reviews) {
    const published = parseDate(review.publishDate)
      || parseDate(sourceByUrl.get(review.url)?.data?.publishDate);
    if (!published) continue;
    if (published >= cutoff) continue;

    // Honor explicit manual clears for anticipatory posts — curator may decide
    // an early in-depth feature is a legitimate scored review.
    const src = sourceByUrl.get(review.url)?.data || {};
    if (src.humanReviewedEarlyPublish === true) continue;

    const daysBefore = Math.round((openingDate.getTime() - published.getTime()) / MS_PER_DAY);
    violations.push({
      outletId: review.outletId,
      criticName: review.criticName,
      url: review.url,
      publishDate: published.toISOString().slice(0, 10),
      openingDate: openingDate.toISOString().slice(0, 10),
      daysBeforeOpening: daysBefore,
      filename: sourceByUrl.get(review.url)?.filename,
    });
  }

  if (violations.length === 0) {
    return {
      ok: true,
      severity: 'ok',
      message: `All shipped reviews published within ${GRACE_DAYS_BEFORE_OPENING} day(s) of openingDate`,
    };
  }

  return {
    ok: false,
    severity: 'error',
    message: violations.map(v =>
      `${v.outletId}/${v.criticName} SHIPPED with publishDate ${v.publishDate} (${v.daysBeforeOpening}d before openingDate ${v.openingDate}): ${v.url}`
    ).join('\n'),
    details: { violations, showId: show.id, graceDaysBeforeOpening: GRACE_DAYS_BEFORE_OPENING },
  };
}

module.exports = { name, description, run, GRACE_DAYS_BEFORE_OPENING };
