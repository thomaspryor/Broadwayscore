'use strict';

const fs = require('fs');
const path = require('path');

const { buildAcceptSlugs } = require('./slug-mismatch.check.js');

const name = 'fulltext-mentions-show';
const description = 'Source review-text files that shipped to reviews.json contain at least one show-title mention in fullText (catches EBT-content-as-Schmig class)';

// Token patterns we accept as "mentions this show."
// Built from the show's title tokens (len>=4, stopword-filtered) and any aliases.
function buildMentionRegex(show) {
  const acceptSlugs = buildAcceptSlugs(show);
  const patterns = acceptSlugs
    .map(s => s.replace(/-/g, '[\\s-]*'))
    .filter(s => s.length >= 3);
  if (patterns.length === 0) return null;
  // Word-boundary-ish match against fullText (case-insensitive). Multiple slugs ORed.
  return new RegExp(`(^|[^A-Za-z0-9])(${patterns.join('|')})($|[^A-Za-z0-9])`, 'i');
}

function run(show, context) {
  const showDir = path.join(context.reviewTextsRoot, show.id);
  if (!fs.existsSync(showDir)) {
    return { ok: true, severity: 'ok', message: 'No review-texts dir — skipping' };
  }

  const mentionRe = buildMentionRegex(show);
  if (!mentionRe) {
    return { ok: true, severity: 'ok', message: 'Could not derive title patterns — skipping' };
  }

  const shippedByUrl = new Set(
    (context.reviewsDoc[show.id] || []).map(r => r.url).filter(Boolean)
  );
  if (shippedByUrl.size === 0) {
    return { ok: true, severity: 'ok', message: 'No shipped reviews — skipping' };
  }

  let files;
  try {
    files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));
  } catch (err) {
    return { ok: true, severity: 'ok', message: `Could not read review-texts dir: ${err.message}` };
  }

  const violations = [];
  const shortWarnings = [];
  for (const filename of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(showDir, filename), 'utf8'));
    } catch {
      continue;
    }
    if (!data.url || !shippedByUrl.has(data.url)) continue;

    // Concatenate signals that could carry a title mention
    const haystack = [
      data.fullText,
      data.bwwExcerpt,
      data.pullQuote,
      data.criticsTake,
    ].filter(Boolean).join('\n\n');

    // Too short to assert mention — but paywall stubs (~25 chars) that shipped
    // are the exact failure class this check exists to catch. Legitimate stubs
    // need explicit isPreviewPlaceholder/isFullReview=false to be waived.
    if (!haystack || haystack.length < 80) {
      if (data.isPreviewPlaceholder === true || data.isFullReview === false) continue;
      shortWarnings.push({
        filename,
        url: data.url,
        outletId: data.outletId,
        criticName: data.criticName,
        haystackLength: haystack ? haystack.length : 0,
      });
      continue;
    }

    if (mentionRe.test(haystack)) continue;

    // Also honor explicit textIssues signal written by the ingest pipeline
    const hasTitleMissingFlag = Array.isArray(data.textIssues)
      && data.textIssues.some(s => /show title not found/i.test(String(s)));

    violations.push({
      filename,
      url: data.url,
      outletId: data.outletId,
      criticName: data.criticName,
      haystackLength: haystack.length,
      textIssuesFlag: hasTitleMissingFlag,
    });
  }

  if (violations.length === 0 && shortWarnings.length === 0) {
    return {
      ok: true,
      severity: 'ok',
      message: `All shipped source files mention show title at least once`,
    };
  }

  if (violations.length === 0) {
    // Only short-review warnings — surface as warning, not error.
    return {
      ok: false,
      severity: 'warning',
      message: shortWarnings.map(v =>
        `${v.outletId}/${v.criticName} (${v.filename}) SHIPPED with fullText too short to assess title mention (${v.haystackLength} chars — paywall stub?): ${v.url}`
      ).join('\n'),
      details: { shortWarnings, showId: show.id, showTitle: show.title },
    };
  }

  return {
    ok: false,
    severity: 'error',
    message: violations.map(v =>
      `${v.outletId}/${v.criticName} (${v.filename}) SHIPPED but fullText never mentions '${show.title}' (${v.haystackLength} chars${v.textIssuesFlag ? ', textIssues flag set' : ''}): ${v.url}`
    ).concat(shortWarnings.map(v =>
      `⚠️  ${v.outletId}/${v.criticName} (${v.filename}) also too short to assess (${v.haystackLength} chars): ${v.url}`
    )).join('\n'),
    details: { violations, shortWarnings, showId: show.id, showTitle: show.title },
  };
}

module.exports = { name, description, run, buildMentionRegex };
