/**
 * BRO-7929: orphaned-production clustering (pure functions).
 *
 * A "wrongProduction orphan" is a review flagged wrongProduction whose publish
 * date is recent and is covered by NO shows.json production of the same title.
 * Such a review is not contamination: the production it reviews was never
 * added to shows.json, so the date guard parks it on an older same-title show
 * (good-night-oscar-2023 holds 21 reviews of the 2025 Barbican run).
 *
 * Used by scripts/cluster-orphan-productions.js (proposals + corpus gate).
 */

const { foldDiacritics } = require('./url-slug');
// The repo's show-id slug rule (apostrophes dropped, & -> and): a proposal must spell an id the way shows.json does,
// or "Who’s Afraid..." proposes who-s-afraid-... beside the existing whos-afraid-... ids.
const { slugify } = require('./deduplication');

const DAY = 864e5;
const COVER_SLACK_DAYS = 45;
const CLUSTER_GAP_DAYS = 120;

function parseDate(d) {
  if (!d) return null;
  const t = Date.parse(String(d).replace(/(\d+)(st|nd|rd|th)/, '$1'));
  return Number.isNaN(t) ? null : t;
}

function normTitle(t) {
  return foldDiacritics(t || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[:\-–—].*$/, '')
    .replace(/^(the|a|an) /, '').replace(/[^a-z0-9]/g, '');
}

/** Review date: URL /YYYY/MM/(DD)/ beats publishDate (matches the original audit). */
function reviewDateMs(j) {
  let t = parseDate(j.publishDate);
  const m = (j.url || '').match(/\/(20\d\d)\/(\d\d)\/(\d\d)?/);
  if (m) t = Date.UTC(+m[1], +m[2] - 1, +(m[3] || 15));
  return t;
}

function isCrossMarketNote(j) {
  return /Cross-market|UK or overseas|Edinburgh|fringe|tour/i
    .test((j.wrongProductionReason || j.wrongProductionNote || '') + (j.url || ''));
}

/** Index shows by normalized title for coverage lookups. */
function indexShows(shows) {
  const byTitle = new Map();
  for (const s of shows) {
    const k = normTitle(s.title);
    if (!byTitle.has(k)) byTitle.set(k, []);
    byTitle.get(k).push(s);
  }
  return byTitle;
}

function showWindow(s, now) {
  const a = parseDate(s.previewsStartDate || s.openingDate);
  if (!a) return null;
  const b = parseDate(s.closingDate) || now;
  return [a, b];
}

function isCovered(byTitle, titleKey, ms, now) {
  return (byTitle.get(titleKey) || []).some((s) => {
    const w = showWindow(s, now);
    return w && ms >= w[0] - COVER_SLACK_DAYS * DAY && ms <= w[1] + COVER_SLACK_DAYS * DAY;
  });
}

/**
 * Decide whether one review file is an orphan; returns {ms,...} or null.
 * @param {object} j review file JSON
 * @param {object} show the host show
 */
function orphanCandidate(j, show, { byTitle, cutoffMs, now }) {
  if (!j || !j.wrongProduction || j.wrongShow || j.duplicateOf) return null;
  const ms = reviewDateMs(j);
  if (!ms || ms < cutoffMs || ms > now) return null;
  if (isCrossMarketNote(j)) return null;
  if (isCovered(byTitle, normTitle(show.title), ms, now)) return null;
  return { ms };
}

/** Market of a review from its outlet registry entry (london region => west-end). */
function reviewMarket(j, outlets) {
  const o = outlets && outlets[j.outletId];
  if (o && (o.region === 'london' || o.region === 'uk')) return 'west-end';
  if (j.theatreRecordUrl || /theatrerecord|londontheatre|whatsonstage|\.co\.uk/i.test(j.url || '')) return 'west-end';
  return 'broadway';
}

/**
 * Group orphans into clusters: same title key + same market, split where the
 * gap between consecutive review dates exceeds CLUSTER_GAP_DAYS.
 * @param {Array<{hostId,title,file,ms,outletId,market}>} orphans
 */
function clusterOrphans(orphans) {
  const groups = new Map();
  for (const o of orphans) {
    const k = `${normTitle(o.title)}|${o.market}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(o);
  }
  const clusters = [];
  for (const [key, list] of groups) {
    list.sort((a, b) => a.ms - b.ms);
    let cur = null;
    for (const o of list) {
      if (!cur || o.ms - cur.lastMs > CLUSTER_GAP_DAYS * DAY) {
        cur = { key, titleKey: key.split('|')[0], market: o.market, firstMs: o.ms, lastMs: o.ms, items: [] };
        clusters.push(cur);
      }
      cur.items.push(o);
      cur.lastMs = o.ms;
    }
  }
  for (const c of clusters) {
    c.count = c.items.length;
    c.title = c.items[0].title;
    c.id = `${c.titleKey}|${c.market}|${new Date(c.firstMs).toISOString().slice(0, 7)}`;
    c.hosts = {};
    c.outlets = new Set();
    for (const o of c.items) {
      c.hosts[o.hostId] = (c.hosts[o.hostId] || 0) + 1;
      c.outlets.add(o.outletId);
    }
  }
  return clusters.sort((a, b) => b.count - a.count);
}

/**
 * Proposed show entry skeleton. openingDate here is a LOWER-BOUND ESTIMATE
 * (earliest review date); validate-show-venue.js + Playbill must confirm
 * before the entry is added (CLAUDE.md 3).
 */
function proposeEntry(c, existingIds) {
  const year = new Date(c.firstMs).getUTCFullYear();
  const suffix = c.market === 'west-end' ? 'west-end' : 'off-broadway';
  // A same-title production already holds this id (a second run in the same year): take the next free -N suffix,
  // the repo's convention (richard-iii-regional-2022-2), so applying the proposal can never overwrite that show.
  const base = `${c.titleKey ? slugify(c.title) : 'unknown'}-${suffix}-${year}`;
  let proposedId = base;
  for (let n = 2; existingIds && existingIds.has(proposedId); n++) proposedId = `${base}-${n}`;
  return {
    proposedId,
    title: c.title,
    market: c.market,
    estimatedOpeningNoLaterThan: new Date(c.firstMs).toISOString().slice(0, 10),
    lastReviewDate: new Date(c.lastMs).toISOString().slice(0, 10),
    reviewCount: c.count,
    hosts: c.hosts,
    needsValidation: 'scripts/validate-show-venue.js + Playbill/venue page',
  };
}

module.exports = {
  DAY, COVER_SLACK_DAYS, CLUSTER_GAP_DAYS,
  parseDate, normTitle, reviewDateMs, isCrossMarketNote, indexShows, isCovered,
  orphanCandidate, reviewMarket, clusterOrphans, proposeEntry,
};
