'use strict';
/**
 * Daily pickup planning for finder-based city hubs (BRO-6854). Pure: no I/O.
 *
 * Input is a staged run (scripts/city-finder-stage.js run: productions with the reviews the finder found), the hub's
 * existing shows, and the reviews already on file. Output: an ingest plan for dispatch-ingest-batch.js
 * ({ showId: [{url, outlet}] }, only URLs not on file) and candidate productions with no show yet (reported, never
 * auto-added: a new show goes through a pending-fix plan).
 */
const { norm } = require('./city-review-finder');

const normUrl = (u) => String(u || '').toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '');

/** The existing show a staged production belongs to: same hub, same normalized title, venue names the theatre. */
function matchShow(prod, shows) {
  const t = norm(prod.title);
  const th = norm(prod.theatre);
  return shows.find((s) => norm(s.title) === t && norm(s.venue || '').includes(th)) || null;
}

function planPickup({ staged, shows, reviews, hubSlug, minNew = 3 }) {
  const hubShows = shows.filter((s) => s.city === hubSlug);
  const known = new Map();
  for (const r of reviews) { if (!r.url) continue; if (!known.has(r.showId)) known.set(r.showId, new Set()); known.get(r.showId).add(normUrl(r.url)); }
  const ingest = {};
  const candidates = [];
  for (const p of staged.productions || []) {
    const show = matchShow(p, hubShows);
    if (!show) {
      if ((p.reviews || []).length >= minNew) candidates.push({ title: p.title, theatre: p.theatre, start: p.start, reviews: p.reviews.length });
      continue;
    }
    const have = known.get(show.id) || new Set();
    const seen = new Set();
    const fresh = [];
    for (const r of p.reviews || []) {
      const k = normUrl(r.url);
      if (have.has(k) || seen.has(k) || !r.outletId) continue;
      seen.add(k);
      fresh.push({ url: r.url, outlet: r.outletId });
    }
    if (fresh.length) ingest[show.id] = fresh;
  }
  return { ingest, candidates };
}

module.exports = { planPickup, matchShow, normUrl };
