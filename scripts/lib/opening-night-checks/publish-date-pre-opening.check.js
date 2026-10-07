'use strict';

const fs = require('fs');
const path = require('path');

const name = 'publish-date-pre-opening';
const description = 'Shipped reviews with publishDate more than 1 day before openingDate are anticipatory posts, not actual reviews (catches the frontmezzjunkies 16-day-pre-opening class)';

// How many days before openingDate we allow. Press embargoes routinely lift
// the afternoon of the day before opening; some T1 outlets (NYT, Variety) have
// published as early as 48h pre-opening for high-profile shows. Three or more
// days out is an "anticipation" post about casting/previews.
const GRACE_DAYS_BEFORE_OPENING = 2;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * A review counts as "on time" if it falls in ANY of these windows, not just
 * >= openingDate - grace:
 *   - the current run, starting at previewsStartDate if declared (West End /
 *     UK critics routinely review preview performances well before press
 *     night — that is not an "anticipatory" post, it's a real review of a
 *     real performance)
 *   - any declared priorRuns window (project convention: priorRuns re-includes
 *     an earlier run's reviews, e.g. a Broadway transfer's Off-Broadway
 *     notices — those reviews predate the CURRENT openingDate by design)
 */
function acceptableWindows(show, openingDate) {
  const windows = [];
  const previewsStart = parseDate(show.previewsStartDate);
  const graceOnly = new Date(openingDate.getTime() - GRACE_DAYS_BEFORE_OPENING * MS_PER_DAY);
  windows.push({
    start: previewsStart && previewsStart < graceOnly ? previewsStart : graceOnly,
    end: null,
  });

  for (const prior of Array.isArray(show.priorRuns) ? show.priorRuns : []) {
    const priorOpen = parseDate(prior.openingDate);
    if (!priorOpen) continue;
    const priorClose = parseDate(prior.closingDate);
    windows.push({
      start: new Date(priorOpen.getTime() - GRACE_DAYS_BEFORE_OPENING * MS_PER_DAY),
      end: priorClose ? new Date(priorClose.getTime() + GRACE_DAYS_BEFORE_OPENING * MS_PER_DAY) : null,
    });
  }
  return windows;
}

function withinAnyWindow(published, windows) {
  return windows.some(w => published >= w.start && (w.end === null || published <= w.end));
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

  const windows = acceptableWindows(show, openingDate);
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
  const missingDateWarnings = [];
  for (const review of reviews) {
    const published = parseDate(review.publishDate)
      || parseDate(sourceByUrl.get(review.url)?.data?.publishDate);

    // Missing publishDate on a shipped opening-night review is a yellow flag,
    // not a silent pass. Manual reviews that intentionally lack a publishDate
    // opt out via humanReviewedMissingPublishDate.
    if (!published) {
      const src = sourceByUrl.get(review.url)?.data || {};
      if (src.humanReviewedMissingPublishDate === true) continue;
      missingDateWarnings.push({
        outletId: review.outletId,
        criticName: review.criticName,
        url: review.url,
        filename: sourceByUrl.get(review.url)?.filename,
      });
      continue;
    }

    if (withinAnyWindow(published, windows)) continue;

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

  if (violations.length === 0 && missingDateWarnings.length === 0) {
    return {
      ok: true,
      severity: 'ok',
      message: `All shipped reviews published within ${GRACE_DAYS_BEFORE_OPENING} day(s) of openingDate`,
    };
  }

  if (violations.length === 0) {
    // Only missing-date warnings — surface as warning, not error.
    const warnMessage = missingDateWarnings.map(v =>
      `${v.outletId}/${v.criticName} SHIPPED with no publishDate — cannot confirm post-opening: ${v.url}`
    ).join('\n');
    return {
      ok: false,
      severity: 'warning',
      message: warnMessage,
      details: {
        missingDateWarnings,
        showId: show.id,
        // Self-declared remediation (task #389 pattern, extended for BRO-219).
        remediation: {
          kind: 'alert',
          key: `publish-date-pre-opening-missing:${show.id}`,
          // Colon (not hyphen) before the state segment: show IDs never
          // contain colons, so this can't collide with the main variant's
          // conditionKey below for a differently-named show (Codex review).
          conditionKey: `opening-night-publish-date-pre-opening:missing:${show.id}`,
          title: `Shipped review missing publishDate on ${show.title || show.id}`,
          description: warnMessage,
          severity: 'warning',
          reason: `${missingDateWarnings.length} shipped review(s) with no publishDate`,
        },
      },
    };
  }

  const message = violations.map(v =>
    `${v.outletId}/${v.criticName} SHIPPED with publishDate ${v.publishDate} (${v.daysBeforeOpening}d before openingDate ${v.openingDate}): ${v.url}`
  ).concat(missingDateWarnings.map(v =>
    `⚠️  ${v.outletId}/${v.criticName} also missing publishDate: ${v.url}`
  )).join('\n');

  return {
    ok: false,
    severity: 'error',
    message,
    details: {
      violations,
      missingDateWarnings,
      showId: show.id,
      graceDaysBeforeOpening: GRACE_DAYS_BEFORE_OPENING,
      // Self-declared remediation (task #389 pattern, extended for BRO-219).
      // alert, not workflow: a pre-opening publishDate could be a legitimate
      // early T1 review or an anticipatory post — a heuristic cannot tell
      // which, so a human decides whether to exclude or manually clear it.
      remediation: {
        kind: 'alert',
        key: `publish-date-pre-opening:${show.id}`,
        conditionKey: `opening-night-publish-date-pre-opening:${show.id}`,
        title: `Pre-opening publishDate on ${show.title || show.id}`,
        description: message,
        severity: 'error',
        reason: `${violations.length} shipped review(s) published >${GRACE_DAYS_BEFORE_OPENING}d before opening`,
      },
    },
  };
}

module.exports = {
  name, description, run, GRACE_DAYS_BEFORE_OPENING, acceptableWindows, withinAnyWindow,
};
