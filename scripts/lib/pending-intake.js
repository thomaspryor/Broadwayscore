'use strict';
/**
 * pending-intake.js (BRO-8089): the no-fetch triage, applied where a stub is WRITTEN into _pending/.
 *
 * Before this, triagePendingStub only ran in the weekly drain, so junk the triage already recognizes
 * (a stub date outside the production's window, an off-topic section, a url another show already
 * scores) piled into _pending faster than a 16-minute drain slot cleared it: 329 of 593 new stubs in
 * 14 days. The producer's writer (gather-reviews.js) now asks `intakeVerdict` first and does not
 * write a stub the triage settles; a candidate (needs a fetch) is written as before.
 *
 * Fails OPEN: if shows/reviews cannot be loaded, every stub is a candidate (never lose a review to a load error).
 */
const fs = require('fs');
const path = require('path');
const { triagePendingStub, buildHeldUrlIndex, sameTitleShowsFrom } = require('./pending-triage');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
let _ctx = null;

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

/** Lazily-built, per-process triage context: show lookup + scored-url index. */
function loadContext(dataDir = DATA_DIR) {
  const shows = readJson(path.join(dataDir, 'shows.json'));
  const allShows = shows.shows || shows;
  const byId = new Map(allShows.map((s) => [s.id, s]));
  // reviews.json is { _meta, reviews: [row, ...] } (rebuild-all-reviews.js); same read as the drain's loadHeldIndex.
  const rv = readJson(path.join(dataDir, 'reviews.json'));
  const rows = Array.isArray(rv) ? rv : rv.reviews;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('reviews.json has no review rows');
  const heldIndex = buildHeldUrlIndex(rows);
  // An empty index would make every non-review-host url look unscored (pending-triage.js): fail open instead.
  if (heldIndex.size === 0) throw new Error('held-url index is empty');
  return { byId, allShows, heldIndex };
}

/**
 * @param {object} stub  the record about to be written to _pending/<showId>/
 * @param {string} showId
 * @param {{ctx?:{byId:Map,heldIndex:Map}, dataDir?:string}} [opts]
 * @returns {{verdict:'duplicate'|'junk'|'candidate', reason:string|null}}
 */
function intakeVerdict(stub, showId, opts = {}) {
  let ctx = opts.ctx;
  try {
    if (!ctx) { if (!_ctx) _ctx = loadContext(opts.dataDir); ctx = _ctx; }
    const show = ctx.byId.get(showId);
    const v = triagePendingStub(stub, { showId, show, sameTitleShows: ctx.allShows ? sameTitleShowsFrom(show, ctx.allShows) : undefined, heldIndex: ctx.heldIndex, showTitleOf: (id) => (ctx.byId.get(id) || {}).title });
    return { verdict: v.verdict, reason: v.reason };
  } catch (e) {
    return { verdict: 'candidate', reason: null, error: e.message };
  }
}

function _resetForTests() { _ctx = null; }
function _setContextForTests(ctx) { _ctx = ctx; }

module.exports = { intakeVerdict, loadContext, _resetForTests, _setContextForTests };
