'use strict';
/**
 * default-critic-diversity.js (BRO-6056)
 *
 * Rebuild, gather and ingest fill a blank byline with the outlet registry's
 * `defaultCritic` unless the outlet carries `multiAuthor: true`
 * (scripts/lib/critic-fill-rules.js). That is right for a one-critic outlet
 * and wrong for a paper whose reviews come from several staff and freelance
 * critics: SFGate filled three Bay City News wire reviews with Lily Janiak
 * (BRO-6054), and the Philadelphia Inquirer has more Howard Shapiro files than
 * Toby Zinman ones.
 *
 * This module decides, from the bylines on an outlet's own review-text files,
 * whether its defaultCritic is safe to fill with. Pure: no I/O. The CLI is
 * scripts/audit-default-critic-diversity.js.
 *
 * Rule: an outlet with a defaultCritic is MULTI-AUTHOR when its files carry at
 * least `minOtherCritics` (2) distinct named critics other than the default
 * AND the default writes less than `maxDefaultShare` (80%) of the named
 * bylines. A dominant critic with the odd guest (amNY, Matt Windman, 402 of
 * 409) stays single-author. An explicit `multiAuthor: false` in the registry
 * records a human review that kept the default anyway, so the audit does not
 * re-flag it.
 */

const NON_PERSON = /\b(unknown|staff|editors?|editorial|team|contributors?|wire|anonymous|n\/a)\b/;
const VENUE_WORD = /\b(theatre|theater|playhouse)$/;

function normName(s) {
  return String(s || '')
    // "Matt Windman. Special to AmNewYork" -> "Matt Windman"; an initial's
    // period ("J. Kelly Nestruck", "Lisa R. Gauthier") does not cut the name.
    .split(/(?<=[A-Za-z]{2})\.\s|,|\||\s[-–]\s/)[0]
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when `name` is a real person's byline (not Unknown, a staff credit,
 * the outlet's own name or a venue scraped into the byline field).
 */
function isNamedByline(name, outletDisplayName) {
  const n = normName(name);
  if (!n) return false;
  if (NON_PERSON.test(n)) return false;
  if (VENUE_WORD.test(n)) return false;
  const outlet = normName(outletDisplayName);
  if (outlet && (n === outlet || n === outlet.replace(/^the /, ''))) return false;
  return true;
}

/**
 * True when `name` is a spelling of `defaultCritic`: equal after
 * normalization, the same surname ("Kelly Nestruck" / "J. Kelly Nestruck",
 * the "Tony Zinman" typo), or a single token matching the default's first or
 * last name ("Jonathan" for Jonathan Mandell). Errs toward "same", which
 * only ever under-counts other critics.
 */
function isSameCritic(name, defaultCritic) {
  const a = normName(name);
  const b = normName(defaultCritic);
  if (!a || !b) return false;
  if (a === b) return true;
  const at = a.split(' ');
  const bt = b.split(' ');
  if (at.length > 1 && bt.length > 1) return at[at.length - 1] === bt[bt.length - 1];
  const single = at.length === 1 ? at[0] : bt[0];
  const other = at.length === 1 ? bt : at;
  return single === other[0] || single === other[other.length - 1];
}

function yearOf(publishDate) {
  if (!publishDate) return null;
  const m = String(publishDate).match(/\b(19|20)\d{2}\b/);
  return m ? Number(m[0]) : null;
}

/**
 * Records with any of these flags are not that outlet's review (or not that
 * critic's), so their bylines say nothing about who writes for the outlet.
 */
function isCountable(rec) {
  return !(rec.wrongAttribution || rec.wrongShow || rec.wrongProduction || rec.isRoundupArticle);
}

/**
 * @param {Array<{outletId?: string, criticName?: string, publishDate?: string}>} records
 * @param {Record<string, {defaultCritic?: string, displayName?: string, multiAuthor?: boolean}>} outlets
 * @returns {Map<string, {outletId, defaultCritic, multiAuthor, defaultCount, unnamedCount,
 *   defaultYears: [number|null, number|null], others: Array<{name, count, firstYear, lastYear}>}>}
 */
function summarizeOutletBylines(records, outlets) {
  const out = new Map();
  for (const rec of records) {
    if (!rec || !isCountable(rec)) continue;
    const entry = outlets[rec.outletId];
    if (!entry || !entry.defaultCritic) continue;
    let s = out.get(rec.outletId);
    if (!s) {
      s = {
        outletId: rec.outletId,
        defaultCritic: entry.defaultCritic,
        multiAuthor: entry.multiAuthor,
        defaultCount: 0,
        unnamedCount: 0,
        defaultYears: [null, null],
        _others: new Map(),
      };
      out.set(rec.outletId, s);
    }
    const y = yearOf(rec.publishDate);
    if (!isNamedByline(rec.criticName, entry.displayName)) { s.unnamedCount++; continue; }
    if (isSameCritic(rec.criticName, entry.defaultCritic)) {
      s.defaultCount++;
      if (y != null) {
        s.defaultYears[0] = s.defaultYears[0] == null ? y : Math.min(s.defaultYears[0], y);
        s.defaultYears[1] = s.defaultYears[1] == null ? y : Math.max(s.defaultYears[1], y);
      }
      continue;
    }
    // Group spellings of one other critic under the surname rule too.
    let key = null;
    for (const k of s._others.keys()) if (isSameCritic(rec.criticName, k)) { key = k; break; }
    if (!key) { key = String(rec.criticName).trim(); s._others.set(key, { name: key, count: 0, firstYear: null, lastYear: null }); }
    const o = s._others.get(key);
    o.count++;
    if (y != null) {
      o.firstYear = o.firstYear == null ? y : Math.min(o.firstYear, y);
      o.lastYear = o.lastYear == null ? y : Math.max(o.lastYear, y);
    }
  }
  for (const s of out.values()) {
    s.others = [...s._others.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    delete s._others;
  }
  return out;
}

/**
 * @returns {{verdict: 'multi-author'|'single-author', defaultShare: number|null, reason: string}}
 */
function classifyOutlet(summary, { minOtherCritics = 2, maxDefaultShare = 0.8 } = {}) {
  const otherCount = summary.others.reduce((n, o) => n + o.count, 0);
  const named = summary.defaultCount + otherCount;
  const defaultShare = named ? summary.defaultCount / named : null;
  if (summary.others.length >= minOtherCritics && defaultShare != null && defaultShare < maxDefaultShare) {
    return {
      verdict: 'multi-author',
      defaultShare,
      reason: `${summary.others.length} other named critics; ${summary.defaultCritic} wrote ${summary.defaultCount} of ${named} named bylines`,
    };
  }
  return {
    verdict: 'single-author',
    defaultShare,
    reason: `${summary.others.length} other named critic(s); default share ${defaultShare == null ? 'n/a' : Math.round(defaultShare * 100) + '%'}`,
  };
}

/**
 * Outlets the audit should report: classified multi-author but the registry
 * still fills from defaultCritic (multiAuthor absent). multiAuthor:false is a
 * reviewed keep and is skipped.
 */
function findUnflaggedMultiAuthorOutlets(records, outlets, opts) {
  const rows = [];
  for (const s of summarizeOutletBylines(records, outlets).values()) {
    if (s.multiAuthor === true || s.multiAuthor === false) continue;
    const c = classifyOutlet(s, opts);
    if (c.verdict === 'multi-author') rows.push({ ...s, ...c });
  }
  return rows.sort((a, b) => b.others.length - a.others.length || a.outletId.localeCompare(b.outletId));
}

module.exports = {
  normName,
  isNamedByline,
  isSameCritic,
  yearOf,
  summarizeOutletBylines,
  classifyOutlet,
  findUnflaggedMultiAuthorOutlets,
};
