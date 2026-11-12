/**
 * Which shows the Broadway Scorecard accounts post about (BRO-7413, owner 2026-11-12):
 * Broadway shows, and Off-Broadway shows the homepage would call notable. Everything else
 * (West End, Off-West End, regional, touring, opera) stays off these accounts.
 *
 * Off-Broadway uses the homepage's own rule (scripts/lib/homepage-notability.js, a ported
 * copy of src/lib/homepage-notability.ts with a parity test). Its signals come from the
 * site's public show file (public/data/shows/<id>.json), the numbers the site displays:
 * rc (review count), cs (Critic Score), rv[].t (outlet tier), au.sources[].c (audience).
 */

const fs = require('fs');
const path = require('path');
const { isHomepageNotable } = require('../lib/homepage-notability');

const SLIM_DIR = path.join(__dirname, '..', '..', 'public', 'data', 'shows');
// Ticket-buyer platforms only (Show Score, Mezzanine, Theatr, BroadwayBox); Reddit is conversation, not attendance.
const AUDIENCE_SOURCES = ['ss', 'mz', 'th', 'bc'];

/** Reads a show's public file; null when absent. The default `slim` for callers with no loaded context. */
const fileSlim = new Proxy({}, {
  get(cache, id) {
    if (typeof id !== 'string') return undefined;
    if (!(id in cache)) {
      try { cache[id] = JSON.parse(fs.readFileSync(path.join(SLIM_DIR, `${id}.json`), 'utf8')); } catch { cache[id] = null; }
    }
    return cache[id];
  },
});

/**
 * NotabilitySignals for a show. status is 'open' on purpose: the posting rules (cancelled,
 * closing date, status checks in select.js) own the status question, and a show that closed
 * after its score settled still deserves the post it earned.
 */
function signalsFor(show, pub) {
  const p = pub || {};
  const src = (p.au && p.au.sources) || {};
  return {
    status: 'open',
    type: show.type,
    isRevival: show.isRevival,
    tags: show.tags,
    t1Count: (p.rv || []).filter(r => r && r.t === 1).length,
    reviewCount: Number.isFinite(p.rc) ? p.rc : 0,
    criticScore: Number.isFinite(p.cs) ? p.cs : 0,
    curatedAudience: AUDIENCE_SOURCES.reduce((n, k) => n + (src[k] && Number.isFinite(src[k].c) ? src[k].c : 0), 0),
    homepageInclude: show.homepageInclude,
    homepageExclude: show.homepageExclude,
  };
}

/** True when the show may post to the Broadway accounts. slim: { [showId]: public show file | null }. */
function socialNotable(show, slim = fileSlim) {
  if (!show) return false;
  if (String(show.type || '').toLowerCase() === 'opera') return false;
  if (show.category === 'broadway') return true;
  if (show.category !== 'off-broadway') return false;
  return isHomepageNotable(signalsFor(show, slim[show.id]));
}

module.exports = { socialNotable, signalsFor, fileSlim };
