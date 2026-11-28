'use strict';
/**
 * abandoned-review-rescue.js (BRO-7131) — the decisions behind scripts/rescue-abandoned-reviews.js.
 *
 * audit-coverage-holes.js counts class A ("found, but no usable text"): a review URL the pipeline found whose fetch
 * failed until the retry budget abandoned it for good (fetchDiscoveryAbandoned). Its header said those rows heal on
 * their own. They did not: nothing ever retried an abandoned file, and the T1 silent-gap sweep only covers tier 1-2
 * outlets. November 2026 found real reviews stuck this way on London openings (Bachtrack's Tosca, Medea and Parsifal;
 * a block page or a JS shell recorded as url_content_mismatch).
 *
 * The URL itself is the precision signal. A file whose URL slug carries every distinctive word of the show's title and
 * the word "review" is the show's review, whatever the fetcher recorded; a url_content_mismatch on any other URL is
 * usually a real mismatch (Bachtrack's site search filed reviews of other operas under Tosca). So:
 *   1. candidate()   a recent show's A row, a retryable failure, a slug that names the show, and no review from the
 *                    same outlet already counted (a second URL for a counted review is a duplicate, not a gap)
 *   2. decide()      retry it through ingest-urls.yml (which bypasses the abandonment gate) at most MAX_ATTEMPTS
 *                    times, RETRY_SPACING_DAYS apart; after that, escalate to a worker card (some sites only serve a
 *                    machine outside GitHub: make-html-handoff-plan.js), never drop it silently
 *   3. the ledger    data/audit/abandoned-review-rescue.json records attempts per show/file (public data: show ids, file
 *                    names and URLs only, never review text)
 * Pure: no fs, no network. The runner and the test share these functions.
 */

const RETRYABLE_BUCKETS = ['url_content_mismatch', 'scraper_timeout', 'scraper_garbage', 'bot_blocked', 'route_capped'];
const MAX_ATTEMPTS = 2;
// A block page or JS shell comes back the same from the same scraper chain: one retry, then a worker.
const SINGLE_RETRY_BUCKETS = new Set(['url_content_mismatch', 'bot_blocked']);
function maxAttemptsFor(bucket) { return SINGLE_RETRY_BUCKETS.has(bucket) ? 1 : MAX_ATTEMPTS; }
const RETRY_SPACING_DAYS = 3;
const MIN_TIER = 3; // tier 1-2 belong to audit-t1-silent-gaps.js, which already recovers and alerts

// Words a title shares with every slug, or that slugs drop.
const STOP = new Set(['the', 'and', 'of', 'a', 'an', 'at', 'in', 'on', 'to', 'for', 'with', 'or', 'by', 'is', 'from', 'musical', 'play', 'opera', 'new', 'off', 'west', 'end', 'broadway', 'tour', 'regional', 'london']);

function titleTokens(title) {
  return String(title || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/['’‘]/g, '').split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOP.has(t));
}

function slugWords(url) {
  let p;
  try { p = new URL(url).pathname; } catch { return []; }
  return p.toLowerCase().replace(/['’‘]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
}

/** The URL slug names the show (every distinctive title word) and says it is a review. */
function slugNamesShowReview(url, title) {
  const toks = titleTokens(title);
  if (!toks.length) return false;
  const words = new Set(slugWords(url));
  return words.has('review') || words.has('reviews') ? toks.every((t) => words.has(t)) : false;
}

/**
 * @param {object} p
 * @param {object} p.row        coverage-holes A row ({file, show, outletId, recent, bucket})
 * @param {object} p.data       the review-text record
 * @param {object} p.show       shows.json entry
 * @param {number|null} p.tier  outlet tier
 * @param {Set<string>} p.countedOutlets outlet ids that already have a published review for this show
 * @returns {null|{reason: string}} null when it is a rescue candidate, else why not
 */
function candidate({ row, data, show, tier, countedOutlets }) {
  if (!row || !data || !show) return { reason: 'missing' };
  if (!row.recent) return { reason: 'not-recent' };
  if (!RETRYABLE_BUCKETS.includes(row.bucket)) return { reason: `bucket:${row.bucket}` };
  if (!data.url) return { reason: 'no-url' };
  if (tier != null && tier < MIN_TIER) return { reason: 'tier-1-2-has-own-sweep' };
  if (countedOutlets && countedOutlets.has(row.outletId)) return { reason: 'outlet-already-counted' };
  if (!slugNamesShowReview(data.url, show.title)) return { reason: 'slug-does-not-name-show' };
  return null;
}

/**
 * @param {object|undefined} entry ledger entry for this file ({attempts, lastAttemptAt, escalatedAt})
 * @param {number} now ms
 * @param {string} [bucket] the row's failure bucket (block-page buckets get one retry)
 * @returns {'retry'|'wait'|'escalate'|'escalated'}
 */
function decide(entry, now, bucket) {
  const attempts = (entry && entry.attempts) || 0;
  if (attempts >= maxAttemptsFor(bucket)) return entry && entry.escalatedAt ? 'escalated' : 'escalate';
  const last = Date.parse((entry && entry.lastAttemptAt) || '');
  if (Number.isFinite(last) && now - last < RETRY_SPACING_DAYS * 864e5) return 'wait';
  return 'retry';
}

function recordAttempt(ledger, key, meta, now) {
  const prev = ledger[key] || { attempts: 0 };
  ledger[key] = { ...prev, ...meta, attempts: prev.attempts + 1, lastAttemptAt: new Date(now).toISOString() };
  return ledger[key];
}

module.exports = { RETRYABLE_BUCKETS, MAX_ATTEMPTS, maxAttemptsFor, RETRY_SPACING_DAYS, MIN_TIER, titleTokens, slugNamesShowReview, candidate, decide, recordAttempt };
