'use strict';

/**
 * Daily pickup of new theatreinchicago.com productions (BRO-6518).
 *
 * Pure decision logic plus one orchestrator that takes its network calls as
 * arguments, so tests run without a scraper. scripts/tic-daily.js wires the real
 * fetchers. The staging rules themselves live in tic-stage.js (shared with the
 * backfill tooling); this file only decides which listed ids are worth looking
 * at today and what to remember between runs.
 */

const stage = require('./tic-stage');
const { applyAddShow } = require('./add-show-action');

const TIC_ID_RE = /theatreinchicago\.com\/[^/]+\/(\d+)\//;

// A rejection that more reviews or a later date can undo. Everything else is final.
const RETRY_REASONS = new Set(['under-3-outlets', 'no-publish-date']);

function ticIdOf(show) {
  for (const u of show.evidenceUrls || []) {
    const m = TIC_ID_RE.exec(u);
    if (m) return Number(m[1]);
  }
  return null;
}

/** Listing rows still worth evaluating: not on the site yet, not finally rejected, enough reviews listed. */
function pickCandidates(listing, shows, seen) {
  const have = new Set(shows.map(ticIdOf).filter(Boolean));
  return listing.filter((row) => {
    if (have.has(row.id)) return false;
    if (seen[row.id] && !seen[row.id].retry) return false;
    return row.reviewCount >= stage.MIN_REVIEWS;
  });
}

function isRetry(reason) {
  return RETRY_REASONS.has(String(reason).split(':')[0]);
}

/**
 * Evaluate one production. `io` supplies { page(id), detail(page), dates(page) }.
 * Returns { status:'accepted', show, reviews } or { status:'rejected', reason, retry }.
 */
async function evaluate(row, ctx, io) {
  const page = await io.page(row.id);
  const pre = stage.prefilter(page);
  if (!pre.ok) return { status: 'rejected', reason: pre.reason, retry: isRetry(pre.reason) };
  const detail = await io.detail(page);
  const df = stage.detailFilter(detail);
  if (!df.ok) return { status: 'rejected', reason: df.reason, retry: false };
  const dates = await io.dates(page);
  if (!dates) return { status: 'rejected', reason: 'no-publish-date', retry: true };
  const show = stage.buildShowEntry({ page, detail, dates, discoveredAt: ctx.today });
  const dupe = stage.findDuplicate(show, ctx.shows);
  if (dupe) return { status: 'rejected', reason: `duplicate:${dupe.id}`, retry: false };
  stage.dedupeId(show, page, new Set(ctx.shows.map((x) => x.id)));
  return { status: 'accepted', show, reviews: stage.linkedReviews(page).map((r) => r.url) };
}

/**
 * Run the day. Mutates `shows` (the parsed shows.json array) with accepted entries.
 * Returns { added:[{id, urls}], seen } where `seen` is the updated memory.
 */
async function runDaily({ listing, shows, seen, today, io, max = 15, log = () => {} }) {
  const next = { ...seen };
  const added = [];
  for (const row of pickCandidates(listing, shows, seen).slice(0, max)) {
    let res;
    try {
      res = await evaluate(row, { shows, today }, io);
    } catch (e) {
      log(`id ${row.id}: ERROR ${e.message}`);
      continue; // not remembered: tomorrow retries
    }
    if (res.status === 'rejected') {
      next[row.id] = { reason: res.reason, retry: res.retry, on: today };
      continue;
    }
    const applied = applyAddShow(shows, { type: 'add-show', show: res.show });
    if (!applied.ok) {
      next[row.id] = { reason: `add-show:${applied.error || applied.reason || 'refused'}`, retry: false, on: today };
      log(`id ${row.id}: add-show refused (${next[row.id].reason})`);
      continue;
    }
    next[row.id] = { reason: 'added', id: res.show.id, retry: false, on: today };
    added.push({ id: res.show.id, urls: res.reviews });
    log(`added ${res.show.id} (${res.reviews.length} reviews)`);
  }
  return { added, seen: next };
}

module.exports = { ticIdOf, pickCandidates, isRetry, evaluate, runDaily, RETRY_REASONS };
