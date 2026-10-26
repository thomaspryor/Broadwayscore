'use strict';
/**
 * One review url counted under two productions of the same title (BRO-4674).
 *
 * classifyMarketRouting judges each file alone from its url and publishDate, so
 * a file with neither a dated url nor a publishDate scores no signal and is
 * accepted wherever it lands. When the same url is ALSO held by a file in a
 * same-title sibling's folder, the one article is counted on both productions.
 * Found 2026-10-13: the-comedy-about-spies-west-end-2026/sunday-times--unknown
 * (serp-discovery, undated) is the 2025 Times review that
 * the-comedy-about-spies-west-end-2025/times-uk--clive-davis already holds;
 * leopoldstadt-west-end-2021 carried three 2020 reviews scraped off a Show
 * Score page that lists both runs.
 *
 * Report-only: which copy is wrong needs a person (or a date) to decide.
 */
const { sameUrlKey } = require('./review-url-collision');
const { shouldBlockCrossShowCreate } = require('./url-ownership');
const { foldDiacritics } = require('./title-match');

/**
 * @param {Map<string, {siblings: Array<{id: string}>}>} siblingIndex  buildSiblingIndex() output
 * @param {(showId: string) => Array<{file: string, data: object}>} loadFiles  a folder's review files
 * @param {(data: object) => boolean} isCounted  true when the file would count toward a score
 * @param {(left: object, right: object) => boolean} [skipPair]  true when a person already
 *   decided both copies stand (e.g. both carry a wrongProduction clear)
 * @returns {Array<{showId: string, file: string, targetShowId: string, targetFile: string, url: string}>}
 *   one entry per pair, reported on the lexically first show id
 */
function findSiblingSameUrlPairs(siblingIndex, loadFiles, isCounted, skipPair = () => false) {
  const byShow = new Map();
  const keyed = (showId) => {
    if (!byShow.has(showId)) {
      const m = new Map();
      for (const { file, data } of loadFiles(showId) || []) {
        if (!data || !data.url || !isCounted(data)) continue;
        const k = sameUrlKey(data.url);
        if (k && !m.has(k)) m.set(k, { file, url: data.url, data });
      }
      byShow.set(showId, m);
    }
    return byShow.get(showId);
  };

  const pairs = [];
  const seen = new Set();
  for (const [showId, entry] of siblingIndex) {
    for (const sib of (entry && entry.siblings) || []) {
      const [a, b] = [showId, sib.id].sort();
      const pairKey = `${a}|${b}`;
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);
      const left = keyed(a);
      if (left.size === 0) continue;
      const right = keyed(b);
      for (const [k, l] of left) {
        const r = right.get(k);
        if (r && !skipPair(l.data, r.data)) pairs.push({ showId: a, file: l.file, targetShowId: b, targetFile: r.file, url: l.url });
      }
    }
  }
  return pairs;
}

const _norm = (t) => foldDiacritics(String(t || '')).toLowerCase().replace(/<[^>]*>/g, ' ').replace(/&#?\w+;/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
const MIN_WORDS = 50;
const SHINGLE = 8;
const SHARED_RATIO = 0.1;

const _shingles = (words) => {
  const out = new Set();
  for (let i = 0; i + SHINGLE <= words.length; i++) out.add(words.slice(i, i + SHINGLE).join(' '));
  return out;
};

/**
 * True when both copies hold substantive text and the texts are different
 * articles (BRO-6113). Timeout London and London Box Office reuse one url slug
 * for every revival of a show, so a 2018 and a 2024 Hadestown review share a
 * url yet each file holds its own production's text: no article is counted
 * twice. Compared by shared 8-word runs (fewer than 10% of the smaller copy's),
 * so a newsletter/photo-credit header on one copy, HTML markup or a truncated
 * copy of the same article still counts as the same article. Identical or
 * overlapping text, or a copy with no real text, stays reported.
 */
function haveDistinctTexts(left, right) {
  const a = _norm(left && left.fullText).split(' ').filter(Boolean);
  const b = _norm(right && right.fullText).split(' ').filter(Boolean);
  if (a.length < MIN_WORDS || b.length < MIN_WORDS) return false;
  const [small, large] = a.length <= b.length ? [_shingles(a), _shingles(b)] : [_shingles(b), _shingles(a)];
  let shared = 0;
  for (const g of small) if (large.has(g)) shared++;
  return shared < SHARED_RATIO * small.size;
}

const _venueKey = (v) => String(v || '').trim().toLowerCase();

/**
 * True when one of the two entries declares the other as an earlier run it
 * inherits reviews from (shows.json priorRuns, matched by id or venue, the
 * same test market-routing's sibling-venue branch uses). A declared prior run
 * is the operator saying "same production", so one article filed under both
 * is that production's own coverage, not a misroute this guard should judge.
 */
function isDeclaredPriorRunPair(showId, siblingId, siblingIndex) {
  const entry = siblingIndex && siblingIndex.get(showId);
  const sibEntry = siblingIndex && siblingIndex.get(siblingId);
  const sib = entry && (entry.siblings || []).find((s) => s.id === siblingId);
  if (entry && entry.inheritedRunIds && entry.inheritedRunIds.has(siblingId)) return true;
  if (entry && entry.inheritedRunVenues && sib && sib.venue && entry.inheritedRunVenues.has(_venueKey(sib.venue))) return true;
  if (sibEntry && sibEntry.inheritedRunIds && sibEntry.inheritedRunIds.has(showId)) return true;
  if (sibEntry && sibEntry.inheritedRunVenues && entry && entry.venue && sibEntry.inheritedRunVenues.has(_venueKey(entry.venue))) return true;
  return false;
}

/**
 * Write-time twin of findSiblingSameUrlPairs (BRO-5298): should a write of
 * `url` under `showId` be refused because a same-title sibling production
 * already holds the url in a live (counted) file?
 *
 * The writer's Guard I (url-ownership.js) refuses a NEW file whose url another
 * show holds, but a MERGE skips it: a write that lands on an existing file in
 * this show (matched by outlet + critic) and fills or swaps that file's url
 * only checked this show's own folder (findSiblingUrlOwner). That is how an
 * undated serp/Show Score row put the 2025 Times review onto
 * the-comedy-about-spies-west-end-2026 and three 2020 reviews onto
 * leopoldstadt-west-end-2021.
 *
 * Not refused:
 *   - the url is already in this show's folder (`targetHoldsUrl`): the pair
 *     already exists, refusing would only stop that file self-healing; the
 *     detection audit (audit-sibling-title-misroute same-url) reports it;
 *   - the sibling copy is not live (flagged, duplicate pointer, roundup or
 *     combined article, split-section sibling): shouldBlockCrossShowCreate's
 *     rules, so this guard and Guard I can never disagree about liveness;
 *   - market routing just rerouted this write away from that sibling (`visited`);
 *   - the two entries are a declared prior-run pair (isDeclaredPriorRunPair).
 *
 * Pure: the caller supplies `owners` (findCrossShowOwners output).
 *
 * @param {object} args
 * @param {string} args.showId
 * @param {Array<{showId: string, file: string, blocking: boolean, splitGroup?: string|null, splitShows?: string[]|null}>} args.owners
 * @param {Map<string, object>} args.siblingIndex  buildSiblingIndex() output
 * @param {Set<string>} [args.visited]  shows market routing rerouted this write away from
 * @param {boolean} [args.targetHoldsUrl]  a file in showId's own folder already has the url
 * @returns {{showId: string, file: string}|null} the sibling copy that holds the url
 */
function siblingUrlHolder({ showId, owners, siblingIndex, visited = null, targetHoldsUrl = false } = {}) {
  if (targetHoldsUrl || !showId || !siblingIndex) return null;
  const entry = siblingIndex.get(showId);
  if (!entry || !Array.isArray(entry.siblings) || entry.siblings.length === 0) return null;
  const sibIds = new Set(entry.siblings.map((s) => s.id));
  const candidates = (owners || []).filter((o) => o && sibIds.has(o.showId)
    && !(visited && visited.has(o.showId))
    && !isDeclaredPriorRunPair(showId, o.showId, siblingIndex));
  const verdict = shouldBlockCrossShowCreate(candidates, null, showId);
  return verdict.block ? verdict.owner : null;
}

module.exports = { findSiblingSameUrlPairs, haveDistinctTexts, siblingUrlHolder, isDeclaredPriorRunPair };
