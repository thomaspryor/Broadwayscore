'use strict';
/**
 * outlet-fulltext.js — full-text coverage of the major outlets on 2025/2026
 * productions (BRO-7569, BRO-7702). One definition shared by
 * scripts/report-outlet-fulltext-gaps.js (the report), the floor guard
 * scripts/check-outlet-fulltext-floors.js, and the nightly gap queue
 * (gap-strategy-table.compareCandidates puts these outlets first).
 *
 * A row counts as covered when:
 *   full        its text is >=1500 chars and the tier is not truncated/excerpt/stub/invalid,
 *               OR its tier (manualContentTier, else the live classifier) is 'complete'
 *               (a short capsule review the classifier proved complete is the whole review);
 *   terminal    textUnrecoverable with a valid terminal record (gap-terminal);
 *   dup         a duplicate row of a review we hold in full from the same outlet:
 *               an Unknown-critic no-url empty placeholder beside a complete sibling, or
 *               a row whose aggregator excerpt is quoted verbatim in a full sibling.
 * Everything else is a gap.
 */
const fs = require('fs');
const path = require('path');

const MAJOR_FULLTEXT_OUTLETS = Object.freeze(['nytimes', 'nyt-theater', 'wsj', 'washpost', 'newyorker', 'financialtimes', 'times-uk', 'telegraph', 'thestage', 'vulture', 'variety', 'standard', 'independent', 'guardian']);
// Owner goal (BRO-7702): >=95% everywhere, ~100% for these four.
const STRICT_OUTLETS = Object.freeze(['wsj', 'times-uk', 'standard', 'washpost']);
const FLOOR_STRICT = 98;
const FLOOR_DEFAULT = 95;
const MAJOR_SET = new Set(MAJOR_FULLTEXT_OUTLETS);

function isMajorFulltextOutlet(outletId) { return MAJOR_SET.has(outletId); }
function floorFor(outletId) { return STRICT_OUTLETS.includes(outletId) ? FLOOR_STRICT : FLOOR_DEFAULT; }
function isRecentProductionShow(showId) { return /-(2025|2026)(\b|-)/.test(showId); }
function excluded(r) { return !!(r.wrongProduction || r.wrongShow || r.isRoundupArticle || r.duplicateOf); }

/** Full by length, or proved complete by tier. `tier` is the live tier (manual wins). Pure. */
function isFull(r, tier) {
  if (tier === 'complete' && (r.fullText || '').trim()) return true;
  return (r.fullText || '').length >= 1500 && !/truncat|excerpt|stub|invalid/.test(tier || '');
}

const norm = (s) => String(s || '').toLowerCase()
  .replace(/[‘’‚‛′`]/g, "'").replace(/[“”„″]/g, '"')
  .replace(/[–—]/g, '-').replace(/[^a-z0-9' -]+/g, ' ').replace(/\s+/g, ' ').trim();

/** The excerpt passages of a row worth matching (>=40 chars after normalising), longest first. Pure. */
function excerptPassages(r) {
  const out = [];
  for (const [k, v] of Object.entries(r)) {
    if (!/Excerpt$/.test(k) || typeof v !== 'string') continue;
    for (const piece of v.split(/\.\.\.|…|\[\.\.\.\]/)) {
      const n = norm(piece);
      if (n.length >= 40) out.push(n);
    }
  }
  return out.sort((a, b) => b.length - a.length);
}

/** Is any excerpt passage of `r` quoted in `fullText`? Pure. */
function excerptQuotedIn(r, fullText) {
  const hay = norm(fullText);
  if (!hay) return false;
  return excerptPassages(r).some((p) => hay.includes(p.length > 160 ? p.slice(0, 160) : p));
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

function defaultTierOf() {
  const { classifyTierWriteBack } = require('./content-tier-reason-sync');
  return (r) => {
    if (r.manualContentTier) return r.manualContentTier;
    try { return classifyTierWriteBack(r).tierResult.contentTier || r.contentTier; } catch { return r.contentTier; }
  };
}

/**
 * Coverage of every major outlet over a review-texts dir.
 * @param {{base:string, tierOf?:(r:object)=>string, outlets?:string[]}} o
 * @returns {{rates: Record<string,{n:number,full:number,documented:number,dupCovered:number,pct:number,floor:number}>, gaps: object[]}}
 */
function computeOutletFulltext({ base, tierOf = defaultTierOf(), outlets = MAJOR_FULLTEXT_OUTLETS }) {
  const want = new Set(outlets);
  const rates = {};
  const gaps = [];
  const { validateTerminal } = require('./gap-terminal');
  for (const s of fs.readdirSync(base)) {
    if (!isRecentProductionShow(s)) continue;
    let fl; try { fl = fs.readdirSync(path.join(base, s)); } catch { continue; }
    const rows = [];
    for (const f of fl) {
      if (!f.endsWith('.json') || f.startsWith('_')) continue;
      const r = readJson(path.join(base, s, f));
      if (!r) continue;
      const o = r.outletId || f.split('--')[0];
      if (!want.has(o)) continue;
      const tier = tierOf(r);
      rows.push({ f, r, o, tier, full: isFull(r, tier) });
    }
    // Full siblings of the same outlet that a duplicate row can lean on.
    const fullByOutlet = new Map();
    for (const x of rows) {
      if (!x.full || excluded(x.r)) continue;
      if (!fullByOutlet.has(x.o)) fullByOutlet.set(x.o, []);
      fullByOutlet.get(x.o).push(x);
    }
    for (const x of rows) {
      const { f, r, o, tier } = x;
      if (excluded(r)) continue;
      const t = rates[o] || (rates[o] = { n: 0, full: 0, documented: 0, dupCovered: 0 });
      t.n++;
      if (x.full) { t.full++; continue; }
      const sibs = (fullByOutlet.get(o) || []).filter((y) => y.f !== f);
      const placeholderDup = r.criticName === 'Unknown' && !r.url && !(r.fullText || '').trim()
        && sibs.some((y) => y.r.contentTier === 'complete' && !!y.r.url);
      const quotedDup = !placeholderDup && sibs.find((y) => excerptQuotedIn(r, y.r.fullText));
      if (placeholderDup || quotedDup) { t.dupCovered++; continue; }
      if (r.textUnrecoverable && validateTerminal(r).valid) { t.documented++; continue; }
      gaps.push({ outlet: o, show: s, file: f, reviewKey: `${s}/${f}`, tier: tier || 'none', len: (r.fullText || '').length, url: r.url || null,
        criticName: r.criticName || null, firstSeenAt: r.firstSeenAt || null, publishDate: r.publishDate || null,
        reason: r.contentTierReason || r.incompleteReason || '' });
    }
  }
  for (const [o, t] of Object.entries(rates)) {
    t.pct = t.n ? (100 * (t.full + t.documented + t.dupCovered)) / t.n : 100;
    t.floor = floorFor(o);
  }
  return { rates, gaps };
}

/** Which duplicate rows the quoted-excerpt rule found (for the dedupe cleanup). */
function quotedExcerptDuplicates({ base, tierOf = defaultTierOf(), outlets = MAJOR_FULLTEXT_OUTLETS }) {
  const want = new Set(outlets);
  const out = [];
  for (const s of fs.readdirSync(base)) {
    if (!isRecentProductionShow(s)) continue;
    let fl; try { fl = fs.readdirSync(path.join(base, s)); } catch { continue; }
    const rows = fl.filter((f) => f.endsWith('.json') && !f.startsWith('_')).map((f) => ({ f, r: readJson(path.join(base, s, f)) }))
      .filter((x) => x.r && want.has(x.r.outletId || x.f.split('--')[0]))
      .map((x) => ({ ...x, o: x.r.outletId || x.f.split('--')[0], tier: tierOf(x.r) }))
      .map((x) => ({ ...x, full: isFull(x.r, x.tier) }));
    for (const x of rows) {
      if (x.full || excluded(x.r)) continue;
      const sib = rows.find((y) => y.f !== x.f && y.o === x.o && y.full && !excluded(y.r) && excerptQuotedIn(x.r, y.r.fullText));
      if (sib) out.push({ show: s, file: x.f, duplicateOf: sib.f, outlet: x.o });
    }
  }
  return out;
}

/**
 * The floor verdict (BRO-7702 owner rule: no gap, and no write-off without
 * logged attempts). An outlet fails when it is below its floor AND at least
 * one of its gaps has never been attempted (below the floor with every gap
 * attempted is reported, not failed: the queue is working on it). Any gap older
 * than `staleDays` with no attempt row fails on its own, whatever the rate.
 * Pure.
 * @param {{rates:object, gaps:object[], attemptedKeys:Set<string>, nowMs?:number, staleDays?:number}} a
 * @returns {{ok:boolean, outlets:object[], staleUnattempted:object[], belowFloor:string[], failingOutlets:string[]}}
 */
function evaluateFloors({ rates, gaps, attemptedKeys, nowMs = Date.now(), staleDays = 7 }) {
  const ageDays = (g) => {
    const t = Date.parse(g.firstSeenAt || g.publishDate || '');
    return Number.isFinite(t) ? (nowMs - t) / 86400e3 : Infinity; // undated = old
  };
  const outlets = Object.entries(rates).map(([o, t]) => {
    const og = gaps.filter((g) => g.outlet === o);
    const unattempted = og.filter((g) => !attemptedKeys.has(g.reviewKey));
    const below = t.pct < t.floor;
    return { outlet: o, pct: Math.round(t.pct * 10) / 10, floor: t.floor, n: t.n, gaps: og.length, unattempted: unattempted.length, below, fail: below && unattempted.length > 0 };
  }).sort((a, b) => a.pct - b.pct);
  const staleUnattempted = gaps.filter((g) => !attemptedKeys.has(g.reviewKey) && ageDays(g) > staleDays)
    .map((g) => ({ reviewKey: g.reviewKey, outlet: g.outlet, tier: g.tier, ageDays: Number.isFinite(ageDays(g)) ? Math.round(ageDays(g)) : null }));
  const failingOutlets = outlets.filter((x) => x.fail).map((x) => x.outlet);
  return { ok: !failingOutlets.length && !staleUnattempted.length, outlets, staleUnattempted, belowFloor: outlets.filter((x) => x.below).map((x) => x.outlet), failingOutlets };
}

module.exports = {
  evaluateFloors,
  MAJOR_FULLTEXT_OUTLETS, STRICT_OUTLETS, FLOOR_STRICT, FLOOR_DEFAULT,
  isMajorFulltextOutlet, floorFor, isRecentProductionShow, isFull, excerptPassages, excerptQuotedIn,
  computeOutletFulltext, quotedExcerptDuplicates,
};
