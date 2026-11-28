'use strict';

/**
 * Joint-review parity (BRO-6736): a show's gap row cites an article URL that is
 * already live in reviews.json under a DIFFERENT show. That is a joint review
 * (one article, several shows) the second show never received, or a wrong-show
 * citation; either way it should not stay a silent "cited, not live" row.
 * Pure: callers pass the gap results and the reviews rows.
 */

function normUrl(u) {
  return String(u || '').trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
}

/**
 * @param {Array<{showId:string, missing?:Array<{url:string}>, censusVerdict?:{missing?:Array<{url:string}>}}>} gapResults
 * @param {Array<{showId:string, url?:string}>} reviewRows live reviews.json rows
 * @param {{hosts?: RegExp}} [opts] restrict to article hosts
 * @returns {Array<{showId:string, url:string, liveUnder:string[]}>}
 */
function findCitedLiveElsewhere(gapResults, reviewRows, { hosts = null } = {}) {
  const live = new Map();
  for (const r of reviewRows || []) {
    const k = normUrl(r.url);
    if (!k) continue;
    if (!live.has(k)) live.set(k, new Set());
    live.get(k).add(r.showId);
  }
  const out = [];
  for (const g of gapResults || []) {
    const seen = new Set();
    const cited = [...(g.missing || []), ...((g.censusVerdict && g.censusVerdict.missing) || [])];
    for (const m of cited) {
      if (hosts && !hosts.test(m.url)) continue;
      const k = normUrl(m.url);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      const owners = live.get(k);
      if (!owners || owners.has(g.showId)) continue;
      out.push({ showId: g.showId, url: m.url, liveUnder: [...owners].sort() });
    }
  }
  return out;
}

module.exports = { findCitedLiveElsewhere, normUrl };
