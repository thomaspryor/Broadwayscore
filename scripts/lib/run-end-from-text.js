'use strict';

/**
 * Pull a production's announced last performance out of article text ("... through Nov. 23", "extended
 * through December 6", "closes Oct 18"). Used to source closing dates for city-hub regional shows
 * (BRO-7239) instead of guessing opening + 42 days. Pure; no I/O.
 */

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
// "through|thru|until|closes|closing|ends|final performance" ... Month d[, yyyy]
const LEAD = '(extended\\s+(?:through|thru|until|to)|(?:running|runs|continues|playing|plays|performances?|on\\s+stage|continuing|open(?:s)?\\s+run)\\s+(?:through|thru|until)|through|thru|until|closes|closing(?:\\s+(?:on|night))?|ends|final\\s+performance(?:\\s+is)?(?:\\s+on)?|last\\s+performance(?:\\s+is)?(?:\\s+on)?)';
const RE = new RegExp(`\\b${LEAD}[:,]?\\s+(?:(?:sun|mon|tues?|wed(?:nes)?|thurs?|fri|sat(?:ur)?)(?:day)?\\.?,?\\s+)?${MON}\\.?\\s+(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?(?:,?\\s+(20\\d\\d))?`, 'gi');

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const valid = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };

/**
 * @param {string} text   article text (tags already stripped)
 * @param {{ opening: string, articleDate?: string|null }} ctx   production opening date (YYYY-MM-DD)
 * @returns {{ date: string, extended: boolean, snippet: string }[]}  candidates inside [opening, opening + 200 days]
 */
function runEndCandidates(text, ctx) {
  const open = ctx.opening;
  const base = ctx.articleDate || open;
  const out = [];
  RE.lastIndex = 0;
  let m;
  while ((m = RE.exec(text))) {
    const mon = MONTHS[m[2].toLowerCase().slice(0, 4)] || MONTHS[m[2].toLowerCase().slice(0, 3)];
    const day = Number(m[3]);
    if (!mon) continue;
    let year = m[4] ? Number(m[4]) : null;
    if (!year) {
      const by = Number(base.slice(0, 4));
      // the first year whose date lands on/after the article's own date (reviews run in-season)
      for (const y of [by, by + 1]) { if (valid(y, mon, day) && iso(y, mon, day) >= base) { year = y; break; } }
    }
    if (!year || !valid(year, mon, day)) continue;
    const date = iso(year, mon, day);
    const lo = open;
    const hi = new Date(Date.parse(`${open}T00:00:00Z`) + 200 * 86400000).toISOString().slice(0, 10);
    if (date < lo || date > hi) continue;
    // "it will get extended to Oct 31" / "could be extended" is a wish, not an announcement (real: misery-regional-2024)
    const hypothetical = /\b(?:will|would|could|should|might|may|hope(?:fully)?|if|likely)\b[^.!?]{0,20}$/i.test(text.slice(Math.max(0, m.index - 40), m.index));
    out.push({ date, extended: /^extended/i.test(m[1]) && !hypothetical, snippet: text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 20).replace(/\s+/g, ' ') });
  }
  return out;
}

/**
 * Latest `extended` candidate wins; else the date backed by the most distinct sites (a page that repeats its
 * own boilerplate, or the same review stored under two URLs, counts once); ties go to the date mentioned most, then the later one.
 * Candidates may carry `url`; without one each candidate counts as its own site.
 */
function pickRunEnd(cands) {
  if (!cands.length) return null;
  const ext = cands.filter((c) => c.extended).map((c) => c.date).sort();
  if (ext.length) return ext[ext.length - 1];
  const sites = new Map();
  const mentions = new Map();
  cands.forEach((c, i) => {
    let host = `#${i}`;
    try { if (c.url) host = new URL(c.url).hostname.replace(/^www\./, ''); } catch { /* keep per-candidate key */ }
    mentions.set(c.date, (mentions.get(c.date) || 0) + 1);
    if (!sites.has(c.date)) sites.set(c.date, new Set());
    sites.get(c.date).add(host);
  });
  return [...sites.entries()].sort((a, b) => b[1].size - a[1].size || mentions.get(b[0]) - mentions.get(a[0]) || b[0].localeCompare(a[0]))[0][0];
}

/**
 * closingDate + closingDateSource for a new hub show (BRO-7239). A date without a source is never written:
 * no sourced end means the show is flagged 'estimated' (and carries no closingDate).
 */
function closingFields(end, source) {
  if (end && source) return { closingDate: end, closingDateSource: source };
  return { closingDateSource: 'estimated' };
}

/** Assumed run length for a local production nobody published an end date for. src/lib/city-hub.ts mirrors this (tests/unit/hub-closing-dates.test.mjs keeps them equal). */
const ESTIMATED_RUN_DAYS = 42;

const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };

/**
 * BRO-7291 (class 1, stale closing dates after extensions): the production's announced run end when it is
 * LATER than `closing`, from its own evidence, else null.
 *   show      { opening, closing }  (closing may be empty: any sourced end is then returned)
 *   evidence  { texts: [{ text, url, articleDate }], listing: { date, url } | null }
 *             listing = the run end printed on the theatre's / listing site's own page for this production.
 * The listing and the latest "extended through" sentence outrank plain review text (a review keeps quoting the
 * original run after an extension); otherwise pickRunEnd decides. Only moves later, by more than `slackDays`
 * and at most `maxDays`; any text-derived date (extended or plain) needs `minSites` (2) distinct hosts naming the same date; the audit passes 1 so single-host extensions stay visible. An earlier date in a review is almost always the original run, never a shortening.
 * @returns {{ date: string, source: string, kind: 'listing'|'extended'|'text' } | null}
 */
function laterAnnouncedRunEnd(show, evidence, opts = {}) {
  const slack = opts.slackDays == null ? 0 : opts.slackDays;
  const maxDays = opts.maxDays == null ? 120 : opts.maxDays;
  const minSites = opts.minSites == null ? 2 : opts.minSites;
  const opening = show.opening;
  if (!opening) return null;
  const cands = [];
  for (const t of (evidence && evidence.texts) || []) {
    for (const c of runEndCandidates(String(t.text || ''), { opening, articleDate: t.articleDate || null })) cands.push({ ...c, url: t.url || null });
  }
  const listing = evidence && evidence.listing && evidence.listing.date && evidence.listing.date >= opening ? evidence.listing : null;
  // BRO-7319: one review's "extended through <date>" no longer moves a date. A text-derived date needs
  // `minSites` distinct hosts naming the SAME date (any mix of cues); only the theatre's own listing stands alone.
  // kind is 'extended' only when `minSites` hosts used the extended cue, so a plain mention never force-overwrites
  // a pinned humanCorrectedClosingDate in harvest-hub-run-dates.js. Several qualifying dates: the latest wins.
  const byDate = new Map();
  cands.forEach((c, i) => {
    const e = byDate.get(c.date) || { all: new Set(), ext: new Set(), urls: [], n: 0 };
    const h = hostOf(c.url) || `#${i}`;
    e.all.add(h);
    e.n += 1;
    if (c.extended) e.ext.add(h);
    if (c.url && !e.urls.includes(c.url)) e.urls.push(c.url);
    byDate.set(c.date, e);
  });
  // "extended" outranks plain text: the latest date that `minSites` hosts call an extension. Otherwise the plain date with the
  // most distinct hosts (then most mentions, then the later one), as before BRO-7319, provided `minSites` hosts agree on it.
  const extBest = [...byDate.entries()].filter(([, e]) => e.ext.size >= minSites).sort((x, y) => x[0].localeCompare(y[0])).pop();
  const plainBest = [...byDate.entries()].filter(([, e]) => e.all.size >= minSites)
    .sort((x, y) => y[1].all.size - x[1].all.size || y[1].n - x[1].n || y[0].localeCompare(x[0]))[0];
  // plain text only decides when nothing stronger exists: the listing outranks it (a review keeps quoting the original run)
  const pick = extBest ? { d: extBest, kind: 'extended' } : plainBest && !listing ? { d: plainBest, kind: 'text' } : null;
  const text = pick && { date: pick.d[0], urls: pick.d[1].urls, kind: pick.kind };
  const best = [listing && { date: listing.date, urls: [listing.url], kind: 'listing' }, text]
    .filter(Boolean).sort((a, b) => a.date.localeCompare(b.date) || (a.kind === 'listing' ? 1 : -1)).pop() || null;
  if (!best) return null;
  if (show.closing) {
    const gap = daysBetween(show.closing, best.date);
    if (!(best.date > show.closing) || gap <= slack || gap > maxDays) return null;
  }
  const urls = best.urls.filter(Boolean);
  const where = urls.length ? ` (${urls.slice(0, 3).join(' ; ')})` : '';
  const source = best.kind === 'listing' ? `theatre listing "through ${best.date}"${where}` : `review text "through ${best.date}"${where}`;
  return { date: best.date, source, kind: best.kind, hosts: [...new Set(urls.map(hostOf).filter(Boolean))] };
}

module.exports = { runEndCandidates, pickRunEnd, closingFields, laterAnnouncedRunEnd, ESTIMATED_RUN_DAYS };
