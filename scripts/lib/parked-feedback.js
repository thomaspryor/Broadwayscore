'use strict';
/**
 * Parked reader feedback -> Linear work card (feedback #1192, 2026-11-19).
 *
 * process-feedback.js parks anything its router cannot act on as a GitHub
 * issue labelled `needs-review`. Nothing ever consumed that label: 14 parked
 * requests sat open (oldest 2026-07-31), including #1192, a reader handing us
 * the Dirty Dancing opening cast. The owner is told in the digest, but the
 * owner does not work issues; workers take Linear cards. So every parked
 * issue now gets exactly one dispatchable card, and the issue is labelled
 * `carded` so it is never filed twice.
 */
const CARDED_LABEL = 'carded';
const PARKED_LABEL = 'needs-review';
const MIN_AGE_MS = 60 * 60 * 1000; // let the owner or a same-run fix close it first

function labelNames(issue) {
  return (issue.labels || []).map((l) => (typeof l === 'string' ? l : l && l.name)).filter(Boolean);
}

/** Open, parked, feedback-pipeline issues older than MIN_AGE_MS with no card yet. */
function selectParkedIssues(issues, now = Date.now(), minAgeMs = MIN_AGE_MS) {
  return (issues || []).filter((i) => {
    if (!i || i.state !== 'open' || i.pull_request) return false;
    const labels = labelNames(i);
    if (!labels.includes(PARKED_LABEL) || labels.includes(CARDED_LABEL)) return false;
    if (!labels.includes('feedback-digest') && !/needs review/i.test(i.title || '')) return false;
    const created = Date.parse(i.created_at);
    return Number.isFinite(created) && now - created >= minAgeMs;
  });
}

function buildParkedCard(issue) {
  const n = issue.number;
  const short = String(issue.title || '').replace(/^Content request needs review:\s*/i, '').slice(0, 90);
  const spam = /spam-flagged/i.test(issue.title || '');
  const description = [
    `Reader feedback the pipeline parked: https://github.com/thomaspryor/Broadwayscore/issues/${n}`,
    `parked-feedback-key: gh-${n}`,
    '',
    spam
      ? 'The spam filter held this batch. Read each submission: discard real spam, and do any genuine request it hides.'
      : 'The feedback router could not act on this by itself (see the routing reason in the issue). Do the request: add the show, reviews, cast, image or correction it asks for, using the normal pipelines (shows.json edits through a fix plan, backfill-cast.yml, gather-reviews.yml, add-show).',
    'If the router should have handled it, also fix scripts/lib/content-request-routing.js so the same ask routes automatically next time (with a test).',
    'Reader name, email and message live in the private data repo (feedback-submitters.json); never copy them into this card or a public file.',
    `When the request is live (or is not doable, with the reason in an issue comment), close issue #${n}. Do not email the reader; the owner decides replies.`,
    `VERIFY: node scripts/check-review-item-resolved.js --issue-closed=${n}`,
  ].join('\n');
  return { title: `Reader request #${n}: ${short}`, description };
}

module.exports = { selectParkedIssues, buildParkedCard, labelNames, CARDED_LABEL, PARKED_LABEL, MIN_AGE_MS };
