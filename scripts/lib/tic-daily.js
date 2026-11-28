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
const { getCity } = require('./tic-cities');
const { buildKnownWriters } = require('./show-title-normalize');

// Chicago and DC ids live in separate numbering spaces: match the city's own host only.
const idRe = (city) => new RegExp(`${city.host.replace(/\./g, '\\.')}/[^/]+/(\\d+)/`);

// A rejection that more reviews or a later date can undo. Everything else is final.
const RETRY_REASONS = new Set(['no-publish-date']);
const UNDER_N = /^under-\d+-outlets$/;
// Bump when a filter rule loosens, so rejections made by the older rule are looked at once more (BRO-8454:
// "Comedy"/"Performance Art" used to drop scripted plays). Only `type:` rejections are re-opened.
const RULES_VERSION = 2;
// outside-metro: BRO-8454 added Atwater Village, Venice, Topanga, Tysons and Lorton, so those rejections are stale too.
const reopened = (s) => /^(type:|outside-metro)/.test(String(s.reason)) && (s.rv || 1) < RULES_VERSION;

function ticIdOf(show, city = getCity('chicago')) {
  const re = idRe(city);
  for (const u of show.evidenceUrls || []) {
    const m = re.exec(u);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * Productions the live listing no longer shows but we still want evaluated (BRO-8454 backfill: past runs
 * the pickup missed). Merged behind the live rows; a retry or final `seen` entry settles each as usual.
 */
function withBackfill(listing, ids) {
  const have = new Set(listing.map((r) => r.id));
  return [...listing, ...[...new Set(ids || [])].filter((id) => !have.has(id)).map((id) => ({ id, reviewCount: 99, backfill: true }))];
}

/** The newest show row (by openingDate) carrying each theatre listing id: a remount adds a second row with the same id. */
function latestRowByTicId(shows, city = getCity('chicago')) {
  const by = new Map();
  for (const x of shows) {
    const id = ticIdOf(x, city);
    if (!id) continue;
    const cur = by.get(id);
    if (!cur || String(x.openingDate || '') > String(cur.openingDate || '')) by.set(id, x);
  }
  return by;
}

/** Listing rows still worth evaluating: not on the site yet, not finally rejected, enough reviews listed. */
function pickCandidates(listing, shows, seen, city = getCity('chicago')) {
  const have = new Set(shows.map((x) => ticIdOf(x, city)).filter(Boolean));
  const open = listing.filter((row) => {
    if (have.has(row.id)) return false;
    const s = seen[row.id];
    // 'added' but absent from shows.json: the core-data push failed, so look again.
    if (s && !s.retry && s.reason !== 'added' && !reopened(s)) return false;
    return row.reviewCount >= (city.minOutlets || stage.MIN_REVIEWS);
  });
  // Never-seen ids first so a backlog of retries cannot starve new productions.
  return [...open.filter((r) => !seen[r.id]), ...open.filter((r) => seen[r.id])];
}

function isRetry(reason) {
  const r = String(reason).split(':')[0];
  return RETRY_REASONS.has(r) || UNDER_N.test(r);
}

/**
 * Evaluate one production. `io` supplies { page(id), detail(page), dates(page) }.
 * Returns { status:'accepted', show, reviews } or { status:'rejected', reason, retry }.
 */
async function evaluate(row, ctx, io) {
  const city = ctx.city || getCity('chicago');
  const page = await io.page(row.id);
  const pre = stage.prefilter(page, city);
  if (!pre.ok) return { status: 'rejected', reason: pre.reason, retry: isRetry(pre.reason) };
  const detail = await io.detail(page);
  const df = stage.detailFilter(detail, page, city);
  if (!df.ok) return { status: 'rejected', reason: df.reason, retry: false };
  const dates = await io.dates(page);
  if (!dates) return { status: 'rejected', reason: 'no-publish-date', retry: true };
  const show = stage.buildShowEntry({ page, detail, dates, discoveredAt: ctx.today, city, knownWriters: ctx.knownWriters });
  // Short-history launch (BRO-6771): opened before the cutoff and no longer running.
  if (city.since && show.openingDate < city.since && show.status !== 'open') return { status: 'rejected', reason: 'before-since', retry: false };
  const dupe = stage.findDuplicate(show, ctx.shows, city);
  if (dupe) return { status: 'rejected', reason: `duplicate:${dupe.id}`, retry: false };
  stage.dedupeId(show, page, new Set(ctx.shows.map((x) => x.id)));
  // The listed critic rides along (BRO-6518): some outlets' pages carry only a site-wide author.
  return { status: 'accepted', show, reviews: stage.linkedReviews(page).map((r) => ({ url: r.url, critic: r.critic || null })) };
}

/**
 * Shows already on the site that the listing now credits with more reviews than we last
 * saw listed. Every city (BRO-8454: Chicago, minOutlets 3, never topped up, so a show added
 * with 7 links stayed at 7 while the site listed 20). `seen[id].listed` is the listing's own
 * count when we last looked; links we could follow are fewer than the count when some reviews
 * carry no link, so comparing against `reviews` would re-top-up every day.
 * Rows go oldest-look first so a big backlog drains evenly under the daily cap.
 */
function pickTopups(listing, shows, seen, city = getCity('chicago')) {
  const have = latestRowByTicId(shows, city);
  const lastSeen = (r) => { const s = seen[r.id]; return s ? (s.listed ?? s.reviews ?? 0) : 0; };
  return listing
    .filter((row) => !row.backfill && have.has(row.id) && lastSeen(row) < row.reviewCount)
    .sort((a, b) => String((seen[a.id] || {}).on || '').localeCompare(String((seen[b.id] || {}).on || '')));
}

const DAY = 86400000;
// A listing id is reused for each season's remount; reviews of the new run start this long after the row's opening.
const REMOUNT_GAP_DAYS = 240;
const REMOUNT_RECHECK_DAYS = 45;
const dayDiff = (a, b) => (Date.parse(a) - Date.parse(b)) / DAY;

/**
 * Existing rows whose listing may now describe a later season (BRO-8454). TIC keeps one id per title:
 * pickCandidates skips known ids, so an annual remount (A Christmas Carol, It's a Wonderful Life) stayed
 * one row with the old opening date and a new closing date. A row is worth a look when it opened long ago
 * and has not been looked at for REMOUNT_RECHECK_DAYS. Oldest look first.
 */
function pickRemountChecks(listing, shows, seen, today, city = getCity('chicago')) {
  const have = latestRowByTicId(shows, city);
  return listing.filter((row) => {
    const sh = have.get(row.id);
    if (!sh || !Number.isFinite(Date.parse(sh.openingDate || ''))) return false;
    if (dayDiff(today, sh.openingDate) < REMOUNT_GAP_DAYS) return false;
    const last = (seen[row.id] || {}).remountCheckedOn;
    return !last || dayDiff(today, last) >= REMOUNT_RECHECK_DAYS;
  }).sort((a, b) => String((seen[a.id] || {}).remountCheckedOn || '').localeCompare(String((seen[b.id] || {}).remountCheckedOn || '')));
}

/**
 * Pure decision: is the listing now a later season of `row`? The listing's earliest sampled review is
 * published at least REMOUNT_GAP_DAYS after the row opened, and the run is still on or ahead.
 */
function isRemount({ row, dates, closingDate, today }) {
  if (!row || !dates || !dates.openingDate || !closingDate) return false;
  if (closingDate < today) return false;
  return dayDiff(dates.openingDate, row.openingDate) >= REMOUNT_GAP_DAYS;
}

/**
 * Run the day. Mutates `shows` (the parsed shows.json array) with accepted entries.
 * Returns { added:[{id, urls:[{url, critic}]}], seen } where `seen` is the updated memory.
 */
async function runDaily({ listing, shows, seen, today, io, max = 15, log = () => {}, city = getCity('chicago') }) {
  const next = { ...seen };
  const added = [];
  const topups = [];
  // Independent writer credits already in the corpus: the byline oracle (BRO-8054).
  const knownWriters = buildKnownWriters(shows);
  const byTic = latestRowByTicId(shows, city);
  const remounted = new Set();
  for (const row of pickRemountChecks(listing, shows, seen, today, city).slice(0, Math.min(5, max))) {
    try {
      const prior = byTic.get(row.id);
      const page = await io.page(row.id);
      const pre = stage.prefilter(page, city);
      const stamp = { ...(next[row.id] || { reason: 'added', retry: false }), remountCheckedOn: today };
      if (!pre.ok || !page.closingDate || page.closingDate < today) { next[row.id] = stamp; continue; }
      const dates = await io.dates(page);
      // The sampled publish dates are a few links out of many; a normal long run with one late review would pass.
      // So also require that the page's links are new: almost none of them were ever ingested for the prior row.
      const prevUrls = io.knownUrls ? io.knownUrls(prior.id) : null;
      const links = stage.linkedReviews(page);
      const overlap = prevUrls ? links.filter((r) => prevUrls.has(r.url)).length : links.length;
      if (!prevUrls || overlap > links.length * 0.25) { next[row.id] = stamp; continue; }
      if (!isRemount({ row: prior, dates, closingDate: page.closingDate, today })) { next[row.id] = stamp; continue; }
      const detail = await io.detail(page);
      const df = stage.detailFilter(detail, page, city);
      if (!df.ok) { next[row.id] = stamp; continue; }
      const show = stage.buildShowEntry({ page, detail, dates, discoveredAt: today, city, knownWriters });
      stage.dedupeId(show, page, new Set(shows.map((x) => x.id)));
      const applied = applyAddShow(shows, { type: 'add-show', show, distinctFrom: [prior.id] });
      if (!applied.ok) { log(`id ${row.id}: remount add-show refused (${applied.error || applied.reason})`); next[row.id] = stamp; continue; }
      // The earlier season is over: its closing date was overwritten with this season's "Thru". The clamp is
      // applied by saveAddedShows only once the new row is on disk, so a refused save never closes a show without its successor.
      const clampPrior = (!prior.closingDate || prior.closingDate >= show.openingDate)
        ? { id: prior.id, closingDate: new Date(Date.parse(show.openingDate) - DAY).toISOString().slice(0, 10) } : null;
      const reviews = stage.linkedReviews(page).map((r) => ({ url: r.url, critic: r.critic || null }));
      next[row.id] = { ...stamp, id: show.id, reviews: reviews.length, listed: row.reviewCount, on: today };
      added.push({ id: show.id, urls: reviews, remountOf: prior.id, clampPrior });
      remounted.add(row.id);
      log(`remount ${show.id} (season of ${prior.id}, ${reviews.length} reviews)`);
    } catch (e) {
      log(`id ${row.id}: remount ERROR ${e.message}`);
    }
  }
  for (const row of pickTopups(listing, shows, seen, city).filter((r) => !remounted.has(r.id)).slice(0, max)) {
    try {
      const links = stage.linkedReviews(await io.page(row.id)).map((r) => ({ url: r.url, critic: r.critic || null }));
      const id = byTic.get(row.id).id;
      next[row.id] = { ...(next[row.id] || { reason: 'added', retry: false }), on: today, id, reviews: links.length, listed: row.reviewCount };
      if (links.length) topups.push({ id, urls: links });
      log(`top-up ${id} (${links.length} reviews linked, ${row.reviewCount} listed)`);
    } catch (e) {
      log(`id ${row.id}: top-up ERROR ${e.message}`);
    }
  }
  // Remounts first: they take the same daily budget as new ids, but only a few per day.
  for (const row of pickCandidates(listing, shows, seen, city).slice(0, max)) {
    let res;
    try {
      res = await evaluate(row, { shows, today, city, knownWriters }, io);
    } catch (e) {
      log(`id ${row.id}: ERROR ${e.message}`);
      continue; // not remembered: tomorrow retries
    }
    if (res.status === 'rejected') {
      next[row.id] = { reason: res.reason, retry: res.retry, on: today, rv: RULES_VERSION };
      continue;
    }
    const applied = applyAddShow(shows, { type: 'add-show', show: res.show });
    if (!applied.ok) {
      next[row.id] = { reason: `add-show:${applied.error || applied.reason || 'refused'}`, retry: false, on: today, rv: RULES_VERSION };
      log(`id ${row.id}: add-show refused (${next[row.id].reason})`);
      continue;
    }
    next[row.id] = { reason: 'added', id: res.show.id, retry: false, on: today, reviews: res.reviews.length, listed: row.backfill ? 0 : row.reviewCount, rv: RULES_VERSION };
    added.push({ id: res.show.id, urls: res.reviews });
    log(`added ${res.show.id} (${res.reviews.length} reviews)`);
  }
  return { added, topups, seen: next };
}

/**
 * Dispatch the ingest queue under the ingest-urls cap (BRO-8454). The old loop stopped at the first
 * deferral, and Chicago's step ran before DC's and LA's, so with 4 runs allowed in flight the last city
 * starved (18 LA shows waited up to 12 days). Now: when the cap says no, wait for a slot (ingest runs
 * finish in minutes) up to `maxWaitMs`, then defer the rest. A failed dispatch is kept for tomorrow.
 * @returns {{left:object[], dispatched:object[]}}
 */
async function drainIngestQueue({ queue, check, dispatchOne, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxWaitMs = 8 * 60000, pollMs = 60000, log = () => {} }) {
  const left = [];
  const dispatched = [];
  let waited = 0;
  for (let i = 0; i < queue.length; i++) {
    const a = queue[i];
    let cap = check();
    while (!cap.ok && waited < maxWaitMs) {
      log(`waiting for an ingest slot: ${cap.reason}`);
      await sleep(pollMs);
      waited += pollMs;
      cap = check();
    }
    if (!cap.ok) { log(`deferred: ${cap.reason}`); left.push(...queue.slice(i)); break; }
    try {
      dispatchOne(a);
      dispatched.push(a);
      log(`ingest dispatched for ${a.id}`);
    } catch (e) {
      log(`::warning::ingest dispatch failed for ${a.id}: ${e.message}`);
      left.push(a);
    }
  }
  return { left, dispatched };
}

/**
 * Save the rows runDaily just added to doc.shows (BRO-8054). The write guard can refuse a save
 * (a new row duplicates an existing one) or fail for a transient reason (lock timeout, I/O).
 * A refused batch must not drop its good rows, and a transient failure must not be remembered
 * as a final refusal. So: try the batch; on failure take the rows out and save them one at a
 * time. A row refused as a duplicate is recorded final (retry:false); any other failure forgets
 * the seen entry so the next run picks the listing up again.
 * @param {{shows: object[]}} doc  the loaded shows document; the added rows are already in doc.shows
 * @param {{id: string}[]} added   runDaily's `added`
 * @param {{save: (doc: object) => void, nextSeen: object, today: string, log?: (msg: string) => void}} ctx
 * @returns {{id: string}[]} the entries that reached disk
 */
function saveAddedShows(doc, added, { save, nextSeen, today, log = () => {} }) {
  const attempt = () => { try { save(doc); return null; } catch (e) { return e; } };
  // A remount's prior-season clamp rides with its new row: applied for the attempt, undone if the attempt fails.
  const clamp = (as) => {
    const undo = [];
    for (const a of as) {
      const c = a.clampPrior;
      const row = c && doc.shows.find((s) => s && s.id === c.id);
      if (!row) continue;
      undo.push([row, { closingDate: row.closingDate, closingDateSource: row.closingDateSource, status: row.status }]);
      row.closingDate = c.closingDate; row.closingDateSource = 'tic-remount-clamp'; row.status = 'closed';
    }
    return () => { for (const [row, o] of undo) for (const k of Object.keys(o)) { if (o[k] === undefined) delete row[k]; else row[k] = o[k]; } };
  };
  let revert = clamp(added);
  if (!attempt()) return added;
  revert();
  const rows = added.map((a) => [a, doc.shows.find((s) => s && s.id === a.id)]).filter(([, r]) => r);
  for (const [, row] of rows) doc.shows.splice(doc.shows.indexOf(row), 1);
  const landed = [];
  for (const [a, row] of rows) {
    doc.shows.push(row);
    revert = clamp([a]);
    const err = attempt();
    if (!err) { landed.push(a); continue; }
    revert();
    doc.shows.splice(doc.shows.indexOf(row), 1);
    const why = String(err.message).split('\n')[0].slice(0, 200);
    const permanent = /duplicate/i.test(String(err.message));
    for (const k of Object.keys(nextSeen)) {
      if (!nextSeen[k] || nextSeen[k].id !== a.id) continue;
      if (a.remountOf) { nextSeen[k] = { ...nextSeen[k], id: a.remountOf, remountCheckedOn: undefined }; continue; } // keep the prior row's listed/reviews
      if (nextSeen[k].reason !== 'added') continue;
      if (permanent) nextSeen[k] = { reason: `write-refused:${why}`, retry: false, on: today };
      else delete nextSeen[k];
    }
    log(`id ${a.id}: shows write ${permanent ? 'refused' : 'failed, will retry'} (${why})`);
  }
  return landed;
}

module.exports = { withBackfill, saveAddedShows, ticIdOf, latestRowByTicId, pickCandidates, pickTopups, pickRemountChecks, isRemount, drainIngestQueue, RULES_VERSION, REMOUNT_GAP_DAYS, isRetry, evaluate, runDaily, RETRY_REASONS };
