/** Shared hourly gate and diagnostics for reddit-opening-posts-due.js. */
'use strict';

const lib = require('./reddit-opening-post');
const { dueEmails } = require('./reddit-post-email');

const RETRY_GAP_HOURS = 6;
const MISMATCH_WARNING_HOURS = 2;

// Keep the existing hourly cost guard: failed LLM drafts retry after 6h,
// and capped updates only redraft when their email would be allowed out.
function worthAnHourlyRun(prev, nowMs) {
  if (!prev) return true;
  if (lib.isRetryableDraft(prev)) {
    const at = Date.parse(prev.createdAt || '');
    return !Number.isFinite(at) || (nowMs - at) / 3600000 >= RETRY_GAP_HOURS;
  }
  if (prev.emailedAt) return lib.updateAllowed(prev, nowMs);
  return true;
}

function dueShows({ shows, slims, drafts, today, seenLookup, nowMs = Date.now() }) {
  const peers = lib.buildPeers(shows, slims);
  const prevs = (drafts && drafts.drafts) || {};
  return lib.selectCandidates({ shows, slims, drafts, peersByMarket: peers, today, seenLookup })
    .filter(c => worthAnHourlyRun(prevs[c.show.id], nowMs))
    .map(c => c.show.id);
}

const numbers = n => n && Number.isFinite(n.score) && Number.isFinite(n.reviewCount)
  ? `${n.score}/${n.reviewCount}` : 'unknown';
const cell = value => String(value).replace(/\|/g, '&#124;').replace(/[\r\n]/g, ' ');

/**
 * Record the actual gate inputs even on a run that skips the drafter. Without
 * this, a delayed cron, a wrong selection and an email hold all look alike.
 * The age is time since the last send, NOT the duration of the mismatch: a
 * read-only gate cannot know when a review landed between scheduled runs.
 * No network, LLM calls or changes to selection/sending policy (BRO-6987).
 */
function buildDueReport(options) {
  const { slims, drafts, nowMs = Date.now() } = options;
  const ids = dueShows({ ...options, nowMs });
  const emails = dueEmails(drafts, nowMs);
  const prevs = (drafts && drafts.drafts) || {};
  const active = new Set(lib.activeDrafts(drafts, nowMs));
  const showIds = new Set([...ids, ...Object.keys(prevs).filter(id => active.has(prevs[id]))]);
  const warnings = [];
  const rows = [];
  for (const showId of showIds) {
    const prev = prevs[showId];
    const slim = slims.get(showId);
    const current = slim && { score: Number.isFinite(slim.cs) ? Math.round(slim.cs) : null, reviewCount: slim.rc ?? (slim.rv || []).length };
    const emailed = prev && prev.emailedAt ? lib.emailedNumbers(prev) : null;
    const lastSend = Math.max(...[prev && prev.emailedAt, prev && prev.reminderAt].map(x => Date.parse(x || '')).filter(Number.isFinite));
    const ageHours = Number.isFinite(lastSend) ? Math.max(0, (nowMs - lastSend) / 3600000) : null;
    const mismatch = numbers(emailed) !== 'unknown' && numbers(current) !== 'unknown'
      && (emailed.score !== current.score || emailed.reviewCount !== current.reviewCount);
    const decisions = [];
    if (ids.includes(showId)) decisions.push('redraft due');
    for (const email of emails.filter(e => e.draft === prev)) decisions.push(`${email.kind} email due`);
    if (prev && prev.heldGap) decisions.push('review gap hold');
    if (drafts && drafts._meta && drafts._meta.postedDetection === 'skipped') decisions.push('posted detection skipped');
    if (mismatch && !lib.updateAllowed(prev, nowMs)) decisions.push('update cap wait');
    if (numbers(current) === 'unknown') decisions.push('current numbers unavailable');
    const decision = decisions.join('; ') || (mismatch ? 'mismatch, not selected' : 'no work due');
    const row = { showId, emailed, current, ageHours, mismatch, decision };
    rows.push(row);
    if (mismatch && ageHours >= MISMATCH_WARNING_HOURS && lib.updateAllowed(prev, nowMs)) {
      warnings.push(`Reddit draft mismatch for ${showId}: emailed ${numbers(emailed)}, current repo ${numbers(current)} (score/reviews); last send ${ageHours.toFixed(1)}h ago; ${decision}. Check cron cadence and the drafter/email job.`);
    }
  }
  const summary = [
    '## Reddit opening-post due check',
    '',
    `Checked at ${new Date(nowMs).toISOString()}. Current numbers are from public/data/shows/*.json in this checkout, not a live-site fetch.`,
    'Age is time since the last email, not time since the numbers changed. Warnings flag mismatches with an email at least 2h old, once the update cap permits sending.',
    '',
    '| Show | Emailed score/reviews | Current repo score/reviews | Last send age | Gate decision |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map(r => `| ${cell(r.showId)} | ${numbers(r.emailed)} | ${numbers(r.current)} | ${r.ageHours == null ? 'never' : `${r.ageHours.toFixed(1)}h`} | ${cell(r.decision)} |`),
    ...warnings.map(w => `\nWarning: ${cell(w)}`),
    '',
  ].join('\n');
  return { ids, emails, rows, warnings, summary, due: ids.length > 0 || emails.length > 0 };
}

module.exports = { dueShows, buildDueReport };
