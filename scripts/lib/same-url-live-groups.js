'use strict';
/**
 * Same-url live groups (BRO-5858): two or more LIVE review files in one show
 * folder that hold the same article url. One url is one review by one critic,
 * so every such group has a surplus file, and when the bylines differ one of
 * them names the wrong critic (the scored row may carry the wrong name).
 *
 * "Live" is the card's definition: no rejectedAt / wrongProduction /
 * wrongShow / isRoundupArticle / duplicateOf, and contentTier complete,
 * truncated or excerpt. duplicateTextOf does NOT make a file dead: it is a
 * text-storage note, and the rebuild picks between such files by sort order.
 * wrongAttribution is dead too: the rebuild hard-skips it (rebuild-all-reviews
 * skippedWrongAttribution), so such a file never reaches a scored row.
 *
 * Urls compare by review-normalization's canonicalArticleKey, the same
 * same-article key the write guard's collision setter uses (tracking params,
 * www/protocol, domain aliases; real query ids such as ?p=123 stay distinct).
 */
const fs = require('fs');
const path = require('path');

const LIVE_TIERS = new Set(['complete', 'truncated', 'excerpt']);

/**
 * Groups a person checked and left as they are. Key: `${showId}|${articleKey}`.
 * Add an entry only with the evidence that the files are two separate reviews
 * (or that the critic cannot be determined) in `reason`.
 */
const SAME_URL_ALLOWLIST = Object.freeze({
  // BRO-5858 sweep (2026-10-21): critic could not be determined, so neither
  // file was retired and no attribution was changed.
  'living-on-love-2015|nytimes.com/2015/04/21/theater/review-renee-fleming-plays-against-type-in-living-on-love.html':
    { reason: 'NYT page paywalled (no byline); no aggregator quotes this text; neither member (Soloski, Isherwood) attested' },
  'present-laughter-2017|broadwaynews.com/2017/04/05/review/present-laughter-review':
    { reason: 'page did not load; BWW reviews quotes the text under Charles Isherwood, BWW roundup under Elizabeth Bradley' },
  'time-stands-still-2010|hollywoodreporter.com/movies/movie-reviews/time-stands-still-theater-review-29218':
    { reason: 'THR page byline/JSON-LD credits "The Associated Press"; BWW reviews places the excerpt near Frank Scheck' },
});

/**
 * @param {object} d review record
 * @returns {boolean}
 */
function isLiveForSameUrl(d) {
  if (!d || typeof d !== 'object') return false;
  if (d.rejectedAt || d.wrongProduction === true || d.wrongShow === true
    || d.isRoundupArticle === true || d.duplicateOf || d.wrongAttribution === true) return false;
  return LIVE_TIERS.has(d.contentTier);
}

function _articleKey(url) {
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
  const { canonicalArticleKey } = require('./review-normalization');
  try { return canonicalArticleKey(url) || null; } catch { return null; }
}

/**
 * Live same-url groups in one show folder.
 * @param {string} showDir data/review-texts/<showId>
 * @param {{fs?: object}} [opts]
 * @returns {Array<{showId: string, key: string, members: Array<{file: string, criticName: string|null, outletId: string|null, url: string, duplicateTextOf: string|null}>}>}
 */
function findShowSameUrlLiveGroups(showDir, opts = {}) {
  const fsImpl = opts.fs || fs;
  const { isReviewTextFile } = require('./review-text-sidecars');
  const showId = path.basename(showDir);
  let files;
  try { files = fsImpl.readdirSync(showDir).filter((f) => isReviewTextFile(f)).sort(); }
  catch { return []; }
  const byKey = new Map();
  for (const file of files) {
    let d;
    try { d = JSON.parse(fsImpl.readFileSync(path.join(showDir, file), 'utf8')); }
    catch { continue; }
    if (!isLiveForSameUrl(d)) continue;
    const key = _articleKey(d.url);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push({
      file,
      criticName: d.criticName || null,
      outletId: d.outletId || null,
      url: d.url,
      duplicateTextOf: d.duplicateTextOf || null,
    });
  }
  const groups = [];
  for (const [key, members] of byKey) {
    if (members.length >= 2) groups.push({ showId, key, members });
  }
  return groups;
}

/**
 * Every live same-url group under review-texts, split by the allowlist.
 * @param {string} reviewTextsDir
 * @param {{allowlist?: object, fs?: object}} [opts]
 * @returns {{groups: Array<object>, allowlisted: Array<object>}}
 */
function findSameUrlLiveGroups(reviewTextsDir, opts = {}) {
  const fsImpl = opts.fs || fs;
  const allow = opts.allowlist || SAME_URL_ALLOWLIST;
  const groups = [];
  const allowlisted = [];
  let dirs;
  try {
    dirs = fsImpl.readdirSync(reviewTextsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
      .map((e) => e.name).sort();
  } catch { return { groups, allowlisted }; }
  for (const name of dirs) {
    for (const g of findShowSameUrlLiveGroups(path.join(reviewTextsDir, name), { fs: fsImpl })) {
      const entry = allow[`${g.showId}|${g.key}`];
      if (entry) allowlisted.push({ ...g, reason: entry.reason || String(entry) });
      else groups.push(g);
    }
  }
  return { groups, allowlisted };
}

/**
 * How often each candidate critic's name appears in a fetched page's text.
 * Evidence for deciding which member of a group wrote the article: the page
 * names its author; the url never does.
 * @param {string} text page content
 * @param {string[]} names candidate critic names
 * @returns {Object<string, number>}
 */
function bylineMentions(text, names) {
  const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const t = fold(text);
  const out = {};
  for (const n of names) {
    const k = fold(n).trim();
    if (!k || k.length < 4 || k === 'unknown') { out[n] = 0; continue; }
    let count = 0;
    let i = t.indexOf(k);
    while (i !== -1) { count++; i = t.indexOf(k, i + k.length); }
    out[n] = count;
  }
  return out;
}

module.exports = {
  LIVE_TIERS,
  SAME_URL_ALLOWLIST,
  isLiveForSameUrl,
  findShowSameUrlLiveGroups,
  findSameUrlLiveGroups,
  bylineMentions,
};
