'use strict';

// Pure decisions behind two opening-night readiness checks that used to pass
// silently (BRO-5326, Fish at WP Theater, 2026-10-14):
//
//  1. The poster was another show's art (Big Fish) and nothing looked at it.
//     scripts/audit-images-llm.js catches exactly that, but it last ran in
//     February and no workflow schedules it, so a show's poster was never
//     checked. The readiness check now asks it about THIS show's image.
//  2. "No review-texts directory yet (clean slate)" PASSED for a show that had
//     opened three days earlier. A clean slate is only true before opening.

const IMAGE_AUDIT_MARKER = 'IMAGE_AUDIT_RESULT ';

/** The one machine-readable line audit-images-llm.js prints for a --show run. */
function formatImageAuditLine(result) {
  return `${IMAGE_AUDIT_MARKER}${JSON.stringify({
    showId: result.showId,
    action: result.action,
    reason: result.reason || null,
    description: result.description || null,
  })}`;
}

/** Pull that line back out of the audit's stdout; null when it never printed one. */
function parseImageAuditLine(stdout) {
  const line = String(stdout || '').split('\n').reverse().find((l) => l.startsWith(IMAGE_AUDIT_MARKER));
  if (!line) return null;
  try { return JSON.parse(line.slice(IMAGE_AUDIT_MARKER.length)); } catch { return null; }
}

/** Why the audit child gave no verdict, from a spawnSync result; null when it exited 0. */
function describeSpawnFailure(r) {
  if (!r) return 'audit did not run';
  if (r.error) return r.error.code === 'ETIMEDOUT' ? 'timed out' : `spawn error ${r.error.code || r.error.message}`;
  if (r.signal) return `killed by ${r.signal}`;
  if (r.status !== 0) return `exit ${r.status}${r.stderr ? `: ${String(r.stderr).trim().split('\n').pop().slice(0, 120)}` : ''}`;
  return null;
}

/**
 * status is 'pass' | 'warn' | 'skip'. Only an explicit keep passes. A show
 * with no image yet is a warn (readiness wants art before opening), and an
 * audit that could not run is a skip: no key or no network must not look like
 * a clean poster, nor fail a show over an outage.
 */
function posterReadiness(parsed, { hasKey = true, failure = null } = {}) {
  if (!hasKey) return { status: 'skip', detail: 'GEMINI_API_KEY not set, poster not verified' };
  if (!parsed) {
    return { status: 'skip', detail: `image audit produced no verdict${failure ? ` (${failure})` : ''}, poster NOT verified` };
  }
  // The audit reports a Gemini outage as a verdict with reason api_error; that is
  // "could not check", not "the poster looks wrong".
  if (parsed.reason === 'api_error') {
    return { status: 'skip', detail: `vision API error, poster NOT verified: ${String(parsed.description || '').slice(0, 160)}` };
  }
  if (parsed.reason === 'no_thumbnail') {
    return { status: 'warn', detail: 'no poster/thumbnail image file found for this show. Fix: node scripts/fetch-show-images-auto.js --show=<id>' };
  }
  if (parsed.action === 'keep') return { status: 'pass', detail: `vision check: ${parsed.description || 'matches the show'}` };
  if (parsed.action === 'delete') {
    return { status: 'warn', detail: `vision check says the image is NOT this show's art: ${parsed.description || parsed.reason || 'no description'}. Fix: node scripts/fetch-show-images-auto.js --show=<id> --bad-images` };
  }
  return { status: 'warn', detail: `vision check is unsure (${parsed.reason || parsed.action}): ${parsed.description || ''}`.trim() };
}

/**
 * Review-texts check for one show. `opened` is openingDate <= today. Before
 * opening an empty directory is normal; after it, it means collection found
 * nothing (or this checkout cannot see the corpus), which is never a pass.
 */
function preExistingReviewsReadiness({ openingDate, today, dirExists, fileCount, wrongProductionCount }) {
  // Strictly before today: on opening night itself reviews have not dropped yet
  // (CLAUDE.md §14), and `today` is the UTC date, which rolls over around 8pm ET.
  const opened = !!openingDate && String(openingDate) < String(today);
  if (wrongProductionCount > 0) {
    return { status: 'warn', detail: `${wrongProductionCount} files flagged as wrong production` };
  }
  if (dirExists && fileCount > 0) {
    return { status: 'pass', detail: `${fileCount} review files, none flagged as wrong production` };
  }
  if (!opened) {
    return { status: 'pass', detail: `No review files yet (clean slate, opens ${openingDate || 'date not set'})` };
  }
  return {
    status: 'warn',
    detail: `show opened ${openingDate} but ${dirExists ? 'its review-texts directory is empty' : 'no review-texts directory was found'}. ` +
      'Either collection found nothing yet or this checkout cannot see the corpus (check data/review-texts is a real clone).',
  };
}

module.exports = {
  IMAGE_AUDIT_MARKER,
  formatImageAuditLine,
  parseImageAuditLine,
  describeSpawnFailure,
  posterReadiness,
  preExistingReviewsReadiness,
};
