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
const RE = new RegExp(`\\b${LEAD}[:,]?\\s+(?:(?:sun|mon|tues?|wed(?:nes)?|thurs?|fri|sat(?:ur)?)(?:day)?\\.?,?\\s+)?${MON}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d\\d))?`, 'gi');

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
    out.push({ date, extended: /^extended/i.test(m[1]), snippet: text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 20).replace(/\s+/g, ' ') });
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

module.exports = { runEndCandidates, pickRunEnd, closingFields, ESTIMATED_RUN_DAYS };
