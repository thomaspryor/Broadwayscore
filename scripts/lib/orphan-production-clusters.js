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

/** Canonical URL key for duplicate detection: host sans www, path sans trailing slash, no query/hash. */
function urlKey(u) {
  try {
    const x = new URL(u);
    // Keep identifying query params (?p=123, ?id=9); drop tracking ones (utm_*, srsltid, smid, fbclid, gclid).
    const q = [...x.searchParams].filter(([k]) => !/^(utm_|srsltid$|smid$|fbclid$|gclid$)/i.test(k)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
    return x.hostname.replace(/^www\./, '').toLowerCase() + x.pathname.replace(/\/+$/, '').toLowerCase() + (q ? `?${q}` : '');
  } catch { return String(u || '').toLowerCase(); }
}

/** Two normalized titles name the same show if one is a prefix of the other ("imeverywoman" / "imeverywomanthechakakhanmusical"). */
function titlesCompatible(a, b) { return !!a && !!b && (a.startsWith(b) || b.startsWith(a)); }

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

/**
 * BRO-8093 (audit of BRO-7929/7959): the whole orphan scan as one pure function,
 * so the --gate decision is testable on fixtures and on a reverted view of real data.
 * @param {Array<[string,string,object]>} records [hostShowId, fileName, reviewJson]
 * @param {Array<object>} shows shows.json rows
 * @param {object} outlets outlet registry map
 * @param {number} now epoch ms
 * @returns {Array<{hostId,title,file,ms,outletId,market}>}
 */
function findOrphans(records, shows, outlets, now) {
  const ctx = { byTitle: indexShows(shows), cutoffMs: now - 2 * 365 * DAY, now };
  const showById = new Map(shows.map((s) => [s.id, s]));
  // BRO-7959: a flagged copy whose URL is already held UNFLAGGED on another show is a duplicate of a review that is
  // live, not a hidden one. Counting it inflated clusters (Pirates! The Penzance Musical: 16 "hidden" copies, all live).
  const live = new Set();
  const liveFiles = new Map();
  for (const [id, f, j] of records) {
    if (!j.wrongProduction && !j.wrongShow && !j.duplicateOf) {
      if (j.url) live.add(urlKey(j.url));
      // same outlet--critic file + date (URL may differ between scrapes); scoped by title so one critic's two shows on a day never collide
      const fk = `${f}|${reviewDateMs(j)}`;
      const sh = showById.get(id);
      if (sh) { if (!liveFiles.has(fk)) liveFiles.set(fk, []); liveFiles.get(fk).push(normTitle(sh.title)); }
    }
  }
  const orphans = [];
  for (const [id, f, j] of records) {
    const show = showById.get(id);
    if (!show) continue;
    const c = orphanCandidate(j, show, ctx);
    if (!c) continue;
    if ((j.url && live.has(urlKey(j.url))) || (liveFiles.get(`${f}|${c.ms}`) || []).some((t) => titlesCompatible(t, normTitle(show.title)))) continue; // duplicate of a live review
    orphans.push({ hostId: id, title: show.title, file: f, ms: c.ms, outletId: j.outletId, market: reviewMarket(j, outlets) });
  }
  return orphans;
}

/** title|market -> review total over clusters with count >= min (gate keys; stable as the 2-year cutoff rolls). */
function gateKeyTotals(clusters, min) {
  const t = {};
  for (const c of clusters) if (c.count >= min) t[c.key] = (t[c.key] || 0) + c.count;
  return t;
}

/** Keys that are new or grown vs the ratchet baseline: each one is a production missing from shows.json. */
function gateFailures(keyTotals, baseline) {
  return Object.entries(keyTotals).filter(([k, n]) => baseline[k] === undefined || n > baseline[k]).map(([k, n]) => ({ key: k, count: n, baseline: baseline[k] }));
}

/**
 * Reverted view of a rehome (red-then-green on real data): drop the spec'd shows that the
 * rehome ADDED and put every file it moved (reroutedFrom set, sitting in a spec'd show dir)
 * back on its old host, flagged wrongProduction again. Pure: inputs are not mutated.
 * @param {Set<string>} addedIds shows the fix added (removed from the view)
 * @param {Set<string>} rehomeTargets show dirs files were moved into (may include pre-existing shows)
 */
function revertRehome(records, shows, addedIds, rehomeTargets) {
  const byId = new Map(shows.map((s) => [s.id, s]));
  const outShows = shows.filter((s) => !addedIds.has(s.id));
  const missingHosts = [];
  const outRecords = records.map(([id, f, j]) => {
    if (!rehomeTargets.has(id) || !j.reroutedFrom || j.reroutedFrom === id) return [id, f, j];
    const host = byId.get(j.reroutedFrom);
    const target = byId.get(id);
    // Only same-title moves are orphan rehomes; other reroutes (cross-market backlog) stay put.
    if (host && target && !titlesCompatible(normTitle(host.title), normTitle(target.title))) return [id, f, j];
    if (!host) missingHosts.push(`${id}/${f} -> ${j.reroutedFrom}`);
    return [j.reroutedFrom, f, { ...j, wrongProduction: true }];
  });
  return { records: outRecords, shows: outShows, missingHosts };
}

module.exports = {
  findOrphans, gateKeyTotals, gateFailures, revertRehome,
  urlKey, titlesCompatible,
  DAY, COVER_SLACK_DAYS, CLUSTER_GAP_DAYS,
  parseDate, normTitle, reviewDateMs, isCrossMarketNote, indexShows, isCovered,
  orphanCandidate, reviewMarket, clusterOrphans, proposeEntry,
};
