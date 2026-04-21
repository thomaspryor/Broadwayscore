'use strict';

const fs = require('fs');
const path = require('path');

const { urlMentionsAnySlug, buildAcceptSlugs, urlSearchSlug } = require('./slug-mismatch.check.js');

const name = 'roundup-url-mismatch';
const description = 'Source review-text file has bwwRoundupUrl whose slug does not match this show (cross-show attribution)';

function run(show, context) {
  const showDir = path.join(context.reviewTextsRoot, show.id);
  if (!fs.existsSync(showDir)) {
    return { ok: true, severity: 'ok', message: 'No review-texts dir — skipping' };
  }

  const acceptSlugs = buildAcceptSlugs(show);
  if (acceptSlugs.length === 0) {
    return { ok: true, severity: 'ok', message: 'Could not derive show slugs — skipping' };
  }

  // Map of URL → review in reviews.json (to check if mismatched file actually shipped)
  const shippedByUrl = new Set(
    (context.reviewsDoc[show.id] || []).map(r => r.url).filter(Boolean)
  );

  let files;
  try {
    files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));
  } catch (err) {
    return { ok: true, severity: 'ok', message: `Could not read review-texts dir: ${err.message}` };
  }

  const mismatches = [];
  for (const filename of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(showDir, filename), 'utf8'));
    } catch {
      continue;
    }
    const roundupUrl = data.bwwRoundupUrl;
    if (!roundupUrl) continue;

    const urlSlug = urlSearchSlug(roundupUrl);
    if (urlMentionsAnySlug(urlSlug, acceptSlugs)) continue;

    const shipped = data.url && shippedByUrl.has(data.url);
    mismatches.push({
      filename,
      bwwRoundupUrl: roundupUrl,
      url: data.url || null,
      shipped: Boolean(shipped),
    });
  }

  if (mismatches.length === 0) {
    return {
      ok: true,
      severity: 'ok',
      message: `All bwwRoundupUrl values match show slug`,
    };
  }

  // Any mismatch is an error when the review actually shipped (in reviews.json).
  // Warning-only for excluded files — they shouldn't exist but aren't contaminating output.
  const shippedMismatches = mismatches.filter(m => m.shipped);
  const severity = shippedMismatches.length > 0 ? 'error' : 'warning';

  return {
    ok: false,
    severity,
    message: mismatches.map(m =>
      `[${m.shipped ? 'SHIPPED' : 'excluded'}] ${m.filename}: bwwRoundupUrl points to different show — ${m.bwwRoundupUrl}`
    ).join('\n'),
    details: { mismatches, acceptSlugs, showId: show.id },
  };
}

module.exports = { name, description, run };
