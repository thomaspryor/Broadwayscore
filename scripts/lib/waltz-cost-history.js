'use strict';

/**
 * waltz-cost-history.js — every weekly cost figure u/Boring_Waltz_9545 has
 * posted, kept as dated costHistory anchors (BRO-4989).
 *
 * scrape-boring-waltz-costs.js used to keep only his newest figure per show,
 * and the gap-fill overwrote it on a >10% move, so his year of weekly figures
 * was lost. Each (show, post) now becomes one anchor, keyed by the post id so
 * a re-run or a backfill never doubles it.
 *
 * Pure: no I/O. The scraper fetches and writes.
 */

const { addAnchors } = require('./cost-history');

/** One week between his posts plus slack: two figures further apart are not a "single-week" jump. */
const MAX_JUMP_GAP_DAYS = 10;
const JUMP_THRESHOLD = 0.15;
/** A cast change within this many days of a jump explains it. */
const CAST_REASON_WINDOW_DAYS = 21;

function postDate(post) {
  return post?.created_utc ? new Date(post.created_utc * 1000).toISOString().slice(0, 10) : null;
}

function postUrl(post) {
  if (typeof post?.permalink === 'string' && post.permalink) {
    return post.permalink.startsWith('http') ? post.permalink : `https://www.reddit.com${post.permalink}`;
  }
  return post?.id ? `https://www.reddit.com/comments/${post.id}` : null;
}

/** The costHistory anchor for one of his figures. */
function waltzAnchor(post, cost) {
  return {
    asOf: postDate(post),
    amount: Math.round(cost),
    kind: 'running-cost',
    sourceType: 'reddit-standard',
    sourceUrl: postUrl(post),
    postId: post.id || null,
    note: `u/Boring_Waltz_9545: ${String(post.title || '').slice(0, 120)}`,
  };
}

/**
 * Append his figures to each matched record's costHistory.
 * @param {object} commercialShows - commercial.json `shows` (mutated only when apply is true)
 * @param {{slug: string, anchor: object}[]} items
 * @param {{apply?: boolean}} [opts]
 * @returns {{ added: number, duplicates: number, refused: {slug, errors}[], noRecord: string[], perSlug: Record<string, number> }}
 */
function appendWaltzAnchors(commercialShows, items, opts = {}) {
  const bySlug = new Map();
  for (const { slug, anchor } of items) {
    if (!bySlug.has(slug)) bySlug.set(slug, []);
    bySlug.get(slug).push(anchor);
  }
  const out = { added: 0, duplicates: 0, refused: [], noRecord: [], perSlug: {} };
  for (const [slug, anchors] of bySlug) {
    const record = commercialShows?.[slug];
    if (!record) { out.noRecord.push(slug); continue; }
    const res = addAnchors(record.costHistory, anchors);
    out.added += res.added.length;
    out.duplicates += res.duplicates;
    for (const r of res.refused) out.refused.push({ slug, errors: r.errors });
    if (res.added.length) out.perSlug[slug] = res.added.length;
    if (opts.apply && res.added.length) record.costHistory = res.history;
  }
  return out;
}

function daysBetween(a, b) {
  return Math.abs(Date.parse(b) - Date.parse(a)) / 86400000;
}

/**
 * Week-over-week jumps of more than 15% in his series for one show, with a
 * cast-change reason when one falls near the jump. An unexplained jump may be
 * a change in his method, not in the show's costs.
 * @param {object[]} history - costHistory (any order)
 * @param {{name, role, since}[]} [castEvents]
 * @returns {{from, to, fromAmount, toAmount, pct, reason: string|null}[]}
 */
function waltzJumpFlags(history, castEvents = []) {
  const series = (history || [])
    .filter((a) => a.sourceType === 'reddit-standard' && a.kind === 'running-cost')
    .sort((a, b) => a.asOf.localeCompare(b.asOf));
  const flags = [];
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1];
    const cur = series[i];
    if (daysBetween(prev.asOf, cur.asOf) > MAX_JUMP_GAP_DAYS) continue;
    const pct = (cur.amount - prev.amount) / prev.amount;
    if (Math.abs(pct) <= JUMP_THRESHOLD) continue;
    const near = castEvents.find((e) => e?.since && daysBetween(e.since, cur.asOf) <= CAST_REASON_WINDOW_DAYS);
    flags.push({
      from: prev.asOf,
      to: cur.asOf,
      fromAmount: prev.amount,
      toAmount: cur.amount,
      pct: Math.round(pct * 1000) / 10,
      reason: near ? `cast change: ${near.name} as ${near.role} from ${near.since}` : null,
    });
  }
  return flags;
}

/** Cast events for a show from data/cast-changes.json (current + past entries carrying a since date). */
function castEventsFor(castChanges, slug) {
  const s = castChanges?.shows?.[slug];
  if (!s) return [];
  const all = [...(s.currentCast || []), ...(s.pastCast || []), ...(s.history || [])];
  return all.filter((e) => e && typeof e.since === 'string');
}

/**
 * The weekly-run alert: he posted at least one relevant post in the window,
 * yet no anchor landed and none was a duplicate. Duplicates mean the figures
 * are already stored, which is healthy.
 */
function shouldAlertNoAnchors({ relevantPostsInWindow, added, duplicates }) {
  return relevantPostsInWindow > 0 && added === 0 && duplicates === 0;
}

module.exports = {
  waltzAnchor,
  appendWaltzAnchors,
  waltzJumpFlags,
  castEventsFor,
  shouldAlertNoAnchors,
  postDate,
  postUrl,
  JUMP_THRESHOLD,
};
