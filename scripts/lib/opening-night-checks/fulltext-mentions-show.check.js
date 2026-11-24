'use strict';

const fs = require('fs');
const path = require('path');

const { buildMentionRegex } = require('./slug-mismatch.check.js');
const { classifyUnmatchedReview } = require('./fulltext-mention-triage.js');

const name = 'fulltext-mentions-show';
const description = 'Source review-text files that shipped to reviews.json contain at least one show-title mention in fullText (catches EBT-content-as-Schmig class)';

// buildMentionRegex lives in slug-mismatch.check.js so both checks share one
// definition of "mentions this show" (BRO-4697).

function run(show, context) {
  const showDir = path.join(context.reviewTextsRoot, show.id);
  if (!fs.existsSync(showDir)) {
    return { ok: true, severity: 'ok', message: 'No review-texts dir — skipping' };
  }

  const mentionRe = buildMentionRegex(show);
  if (!mentionRe) {
    return { ok: true, severity: 'ok', message: 'Could not derive title patterns — skipping' };
  }
  const headlineRe = buildMentionRegex(show, { titleWords: false });

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
        triage: classifyUnmatchedReview(data, haystack.length),
      });
      continue;
    }

    // BRO-7666: slugs are ASCII, so "Les Misérables"/"Beyoncé" never matched
    // and every accented-title review was reported as unmatched. Fold accents.
    if (mentionRe.test(haystack) || mentionRe.test(haystack.normalize('NFD').replace(/[\u0300-\u036f]/g, ''))) continue;

    // BRO-8004: ingestion already honors this documented article review
    // (evaluateShowMentionGuard). A body can describe the verified production
    // without printing its title. Keep short-text warnings above and explicit
    // contamination findings; a title-only clear cannot override either.
    const cv = data.contentVerification || {};
    const manualClear = typeof data.showNotMentionedManualClear === 'string'
      && data.showNotMentionedManualClear.trim();
    // gap-acceptance saves the fetched page's headline, never a URL-derived
    // title. Recheck that it names this show before accepting the evidence.
    const headline = typeof data.showIdentityHeadline === 'string' ? data.showIdentityHeadline : '';
    const headlineMatch = headline && headlineRe
      && headlineRe.test(headline.normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
    if ((manualClear || headlineMatch)
        && data.wrongShow !== true && data.wrongProduction !== true
        && data.isRoundupArticle !== true
        && cv.wrongShow !== true && cv.wrongProduction !== true
        && cv.wrongArticle !== true) continue;

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
      triage: classifyUnmatchedReview(data, haystack.length),
    });
  }

  if (violations.length === 0 && shortWarnings.length === 0) {
    return {
      ok: true,
      severity: 'ok',
      message: `All shipped source files mention the show title or have documented attribution evidence`,
    };
  }

  if (violations.length === 0) {
    // Only short-review warnings — surface as warning, not error.
    const warnMessage = shortWarnings.map(v =>
      `${v.outletId}/${v.criticName} (${v.filename}) SHIPPED with fullText too short to assess title mention (${v.haystackLength} chars — paywall stub?): ${v.url}`
    ).join('\n');
    return {
      ok: false,
      severity: 'warning',
      message: warnMessage,
      details: {
        shortWarnings,
        showId: show.id,
        showTitle: show.title,
        // Self-declared remediation (task #389 pattern, extended for BRO-219).
        remediation: {
          kind: 'alert',
          key: `fulltext-mentions-show-short:${show.id}`,
          // Colon (not hyphen) before the state segment: show IDs never
          // contain colons, so this can't collide with the main variant's
          // conditionKey below for a differently-named show (Codex review).
          conditionKey: `opening-night-fulltext-mentions-show:short:${show.id}`,
          title: `Shipped review too short to verify on ${show.title || show.id}`,
          description: warnMessage,
          severity: 'warning',
          reason: `${shortWarnings.length} shipped review(s) too short to assess title mention`,
        },
      },
    };
  }

  const message = violations.map(v =>
    `${v.outletId}/${v.criticName} (${v.filename}) SHIPPED but fullText never mentions '${show.title}' (${v.haystackLength} chars${v.textIssuesFlag ? ', textIssues flag set' : ''}): ${v.url}`
  ).concat(shortWarnings.map(v =>
    `⚠️  ${v.outletId}/${v.criticName} (${v.filename}) also too short to assess (${v.haystackLength} chars): ${v.url}`
  )).join('\n');

  return {
    ok: false,
    severity: 'error',
    message,
    details: {
      violations,
      shortWarnings,
      showId: show.id,
      showTitle: show.title,
      // Self-declared remediation (task #389 pattern, extended for BRO-219).
      // alert, not workflow: this is the EBT-content-as-Schmig contamination
      // class — a heuristic cannot decide whether to re-fetch, exclude, or
      // reattribute a mismatched review, that needs a human.
      remediation: {
        kind: 'alert',
        key: `fulltext-mentions-show:${show.id}`,
        conditionKey: `opening-night-fulltext-mentions-show:${show.id}`,
        title: `Content mismatch on ${show.title || show.id}`,
        description: message,
        severity: 'error',
        reason: `${violations.length} shipped review(s) never mention the show title`,
      },
    },
  };
}

module.exports = { name, description, run, buildMentionRegex };
