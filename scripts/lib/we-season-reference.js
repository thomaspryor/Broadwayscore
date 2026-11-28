'use strict';
// venue-write-guard-ok: venues here are reference-list and candidate fields; promote-historical-we.js buildShowEntry writes shows.json venues through sanitizeVenueForWrite.

/**
 * we-season-reference.js (BRO-6450)
 *
 * Pure helpers for the West End season reference lists: what opened at a SOLT
 * West End house (data/west-end-venues.json, the same set the west-end
 * category uses, NT stages and the Royal Court included, Barbican and the
 * Off-West End houses not) in a Sep-Aug season, from two or more independent
 * sources. build-we-season-reference.js fetches; audit-we-historical-season.js
 * reads the committed lists and reports the titles the site is missing.
 *
 * Primary source: Theatricalia venue histories (dated production lists).
 * Corroborators: Theatre Record A-Z titles, the archived Official London
 * Theatre listings, the venue's Wikipedia article.
 */

const { foldDiacritics } = require('./title-match');
const { getSeasonDates } = require('./we-seasons');
const fs = require('fs');
const path = require('path');
const { THEATRICALIA_FIRST_PERFORMANCE_SOURCE } = require('./we-historical-dates');

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const DAY_MS = 86400000;
// The OLT candidate rule (we-olt-candidates.js): a run under two weeks is a
// one-off, gala or concert, not a production a season list should carry.
const MIN_RUN_DAYS = 14;
// Share of the reference list the site must carry (BRO-6450).
const MIN_REFERENCE_COVERAGE = 0.85;
// A matched row's first date may sit this far from the reference start (previews vs press night, archive drift).
const MATCH_WINDOW_DAYS = 75;
// A same-title entry starting this soon after a row's run closed is that production's return run.
const RETURN_RUN_DAYS = 183;

const decode = s => String(s || '')
  .replace(/<[^>]+>/g, '')
  .replace(/&rsquo;|&lsquo;|&#8217;|&#39;/g, "'")
  .replace(/&ldquo;|&rdquo;|&quot;/g, '"')
  .replace(/&amp;/g, '&')
  .replace(/&ndash;|&mdash;|&#8211;/g, '–')
  .replace(/&nbsp;|&#8239;/g, ' ')
  .replace(/&middot;/g, '·')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/\s+/g, ' ')
  .trim();

const iso = (y, m, d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

function parsePart(text) {
  const m = String(text).trim().match(/^(?:(\d{1,2})(?:st|nd|rd|th)?(?:\s+|$))?([A-Za-z]+)?\s*(\d{4})?$/);
  if (!m) return null;
  const month = m[2] ? MONTHS.indexOf(m[2].toLowerCase()) : -1;
  if (m[2] && month < 0) return null;
  return { day: m[1] ? Number(m[1]) : null, month: month >= 0 ? month : null, year: m[3] ? Number(m[3]) : null };
}

/**
 * Theatricalia's date line → { start, end } (ISO, end null when open or
 * unknown). "2nd October – 30th December 2017", "15th November 2016 – 11th
 * February 2017", "23rd April – July 2013", "started 19th March 2014",
 * "3rd December 2017" (one date: start = end).
 */
function parseTheatricaliaDates(text) {
  const t = decode(text).replace(/<sup>|<\/sup>/g, '').replace(/\.$/, '').trim();
  const started = t.match(/started\s+(.+)$/i);
  if (started) {
    const p = parsePart(started[1]);
    if (!p || !p.year || p.month === null) return null;
    return { start: iso(p.year, p.month, p.day || 1), end: null, open: true };
  }
  const range = t.match(/([0-9A-Za-z ]+?)\s*[–-]\s*([0-9A-Za-z ]+)$/);
  if (range) {
    const a = parsePart(range[1]);
    const b = parsePart(range[2]);
    if (!a || !b || !b.year) return null;
    const aYear = a.year || b.year;
    const aMonth = a.month === null ? b.month : a.month;
    if (aMonth === null || b.month === null) return null;
    // "1st – 20th June 2015": a carries only a day.
    const lastDay = new Date(Date.UTC(b.year, b.month + 1, 0)).getUTCDate();
    return { start: iso(aYear, aMonth, a.day || 1), end: iso(b.year, b.month, b.day || lastDay), open: false };
  }
  const one = parsePart(t);
  if (one && one.year && one.month !== null && one.day) {
    const d = iso(one.year, one.month, one.day);
    return { start: d, end: d, open: false };
  }
  return null;
}

/** One Theatricalia /place/.../past page → [{ title, url, companies, start, end, open }]. */
function parseTheatricaliaList(html) {
  const out = [];
  const re = /<li itemprop="events"[\s\S]*?(?=<li itemprop="events"|<\/ul>)/g;
  let m;
  while ((m = re.exec(String(html))) !== null) {
    const block = m[0];
    const a = block.match(/<a itemprop="url" href="(\/play\/[^"]+)">([\s\S]*?)<\/a>/);
    if (!a) continue;
    const meta = block.match(/<span class="meta">([\s\S]*?)<\/span>/);
    const dates = meta ? parseTheatricaliaDates(meta[1]) : null;
    const companies = [...block.matchAll(/href="\/company\/[^"]+">([\s\S]*?)<\/a>/g)].map(c => decode(c[1]));
    out.push({ title: decode(a[2]), url: `https://theatricalia.com${a[1]}`, companies, ...(dates || { start: null, end: null, open: false }) });
  }
  return out;
}

const runDays = e => (e.start && e.end ? Math.round((Date.parse(e.end) - Date.parse(e.start)) / DAY_MS) + 1 : null);

function inSeason(date, season) {
  if (!date) return false;
  const { start, end } = getSeasonDates(season);
  const d = new Date(`${date}T12:00:00`);
  return d >= start && d <= new Date(end.getTime() + DAY_MS - 1);
}

// Own key, not deduplication.normalizeTitle: that drops a leading possessive
// ("A Doll's House" to "house", "Neville's Island" to "island"), which merges
// unrelated titles here.
const titleKey = t => foldDiacritics(String(t || '').toLowerCase())
  .replace(/\s*\/\s*/g, ' and ').replace(/&/g, ' and ').replace(/['’]/g, '')
  .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
  .replace(/^(the|a|an) /, '').replace(/ the musical$/, '');

/**
 * Same title, allowing one side to carry a subtitle ("Macbeth" / "Macbeth: A
 * New Version") or a possessive brand the other drops ("Disney's Aladdin").
 * A bare word in front is a different show ("Top Girls" / "The Girls").
 */
function titlesMatch(a, b) {
  const x = titleKey(a);
  const y = titleKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long, longRaw] = x.length <= y.length ? [x, y, b] : [y, x, a];
  if (short.length < 5) return false;
  if (long.startsWith(`${short} `)) return true;
  // A brand needs a distinctive remainder: "A Doll's House" is not "House".
  return short.length >= 7 && long.endsWith(` ${short}`) && /^[^:]*['’]s\s/i.test(String(longRaw));
}

// A dated corroborator (a review) must fall near the entry's start: a Guardian
// "Hamlet review" from a Bristol run a year later vouches for nothing.
const REVIEW_BEFORE_DAYS = 30;
const REVIEW_AFTER_DAYS = 150;
function corroborates(t, e) {
  if (typeof t === 'string') return titlesMatch(t, e.title);
  if (!titlesMatch(t.title, e.title)) return false;
  if (!t.date) return true;
  const gap = (Date.parse(t.date) - Date.parse(e.start)) / DAY_MS;
  return gap >= -REVIEW_BEFORE_DAYS && gap <= REVIEW_AFTER_DAYS;
}

/**
 * Season reference list from venue histories plus corroborators.
 * @param {{ season: string, venueEntries: {venue: string, entries: object[]}[],
 *   corroborators: {name: string, titles: (string|{title: string, date?: string})[]}[], wikipedia?: Record<string,string> }} input
 *   wikipedia: venue → plain article text (a title found in it corroborates).
 * @returns {{ entries: object[], excluded: object[] }}
 */
function buildSeasonReference({ season, venueEntries, corroborators = [], wikipedia = {} }) {
  const entries = [];
  const excluded = [];
  const seen = new Set();
  for (const { venue, entries: rows } of venueEntries) {
    const wikiText = titleKey(wikipedia[venue] || '');
    for (const e of rows) {
      if (!inSeason(e.start, season)) continue;
      const key = `${titleKey(e.title)}|${venue}`;
      if (seen.has(key)) continue;
      const days = runDays(e);
      // Checked before marking seen: a one-night gala must not hide a full run of the same title.
      if (days !== null && days < MIN_RUN_DAYS) { excluded.push({ title: e.title, venue, start: e.start, end: e.end, reason: `run of ${days} days < ${MIN_RUN_DAYS}` }); continue; }
      seen.add(key);
      const sources = ['theatricalia'];
      for (const c of corroborators) if (c.titles.some(t => corroborates(t, e))) sources.push(c.name);
      const k = titleKey(e.title);
      if (wikiText && k.length >= 4 && ` ${wikiText} `.includes(` ${k} `)) sources.push('wikipedia');
      entries.push({ title: e.title, venue, start: e.start, end: e.end, sources, corroborated: sources.length >= 2, url: e.url });
    }
  }
  entries.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
  return { entries, excluded };
}

const firstDate = s => s.previewsStartDate || s.openingDate || null;

/**
 * How much of a season's reference list the site carries.
 * A reference entry is present when a west-end row has a matching title and
 * its first date is within MATCH_WINDOW_DAYS of the entry's start, its run
 * spans the entry's start (a transfer or extension stored as one row), or it
 * closed under RETURN_RUN_DAYS before the entry's start (a return run).
 *
 * `justifications` (gap-justifications.json for the season, see
 * GAP_JUSTIFICATIONS_FILE) apply only to entries the matcher misses:
 *   same-production  the entry is that west-end row under another title
 *                    (an alias, or a play staged in repertory with it); counts
 *                    as present when the row exists and starts within
 *                    MATCH_WINDOW_DAYS of the entry, else stays missing and is
 *                    listed in `staleJustifications`.
 *   out-of-scope     the entry is outside what the site lists (category in
 *                    OUT_OF_SCOPE_CATEGORIES); leaves the in-scope denominator.
 * `share` is present / every entry; `pass` uses `inScopeShare`, present /
 * (entries - out-of-scope), so an excluded entry is visible, never silent.
 * @param {{ reference: object[], shows: object[], justifications?: object[] }} input  reference: corroborated entries only
 */
function referenceCoverage({ reference, shows, justifications = [] }) {
  const westEnd = shows.filter(s => s.category === 'west-end');
  const present = [];
  const missing = [];
  const outOfScope = [];
  const staleJustifications = [];
  const justificationFor = r => justifications.find(j => j.title === r.title && j.start === r.start);
  for (const r of reference) {
    const refStart = Date.parse(r.start);
    const hit = westEnd.find(s => {
      if (!titlesMatch(s.title, r.title)) return false;
      const f = Date.parse(firstDate(s));
      if (Number.isNaN(f)) return false;
      if (Math.abs(f - refStart) <= MATCH_WINDOW_DAYS * DAY_MS) return true;
      if (f > refStart) return false;
      // No closing date: still running (Mamma Mia!, Dirty Dancing), so it spans the start.
      if (!s.closingDate) return true;
      const close = Date.parse(s.closingDate);
      if (Number.isNaN(close)) return false;
      // The run spans the start, or the entry is a return run of that
      // production (The Kite Runner: Wyndham's to Mar 2017, Playhouse from Jun).
      return close >= refStart || refStart - close <= RETURN_RUN_DAYS * DAY_MS;
    });
    if (hit) { present.push({ title: r.title, venue: r.venue, start: r.start, showId: hit.id }); continue; }
    const j = justificationFor(r);
    if (j && j.kind === 'same-production') {
      const row = westEnd.find(s => s.id === j.showId);
      const f = row ? Date.parse(firstDate(row)) : NaN;
      if (!Number.isNaN(f) && Math.abs(f - refStart) <= MATCH_WINDOW_DAYS * DAY_MS) {
        present.push({ title: r.title, venue: r.venue, start: r.start, showId: row.id, via: 'same-production' });
        continue;
      }
      staleJustifications.push({ title: r.title, start: r.start, showId: j.showId || null });
    } else if (j && j.kind === 'out-of-scope' && OUT_OF_SCOPE_CATEGORIES.has(j.category)) {
      outOfScope.push({ title: r.title, venue: r.venue, start: r.start, category: j.category, reason: j.reason });
      continue;
    } else if (j) {
      staleJustifications.push({ title: r.title, start: r.start, showId: j.showId || null });
    }
    missing.push({ title: r.title, venue: r.venue, start: r.start, end: r.end });
  }
  const total = reference.length;
  const share = total ? present.length / total : 0;
  const inScopeTotal = total - outOfScope.length;
  // Integer comparison: 51/60 must meet 0.85 without float drift.
  const inScopePass = inScopeTotal > 0 && present.length * 100 >= Math.round(MIN_REFERENCE_COVERAGE * 100) * inScopeTotal;
  return {
    total,
    present,
    missing,
    outOfScope,
    staleJustifications,
    share: Math.round(share * 100) / 100,
    inScopeTotal,
    inScopeShare: inScopeTotal ? Math.round((present.length / inScopeTotal) * 100) / 100 : 0,
    pass: inScopePass,
    threshold: MIN_REFERENCE_COVERAGE,
  };
}

// Hand-curated, sourced reasons for reference entries the matcher misses
// (BRO-6450). Kept apart from <season>.json, which the builder rewrites.
const GAP_JUSTIFICATIONS_FILE = path.join('data', 'audit', 'we-season-reference', 'gap-justifications.json');
const GAP_KINDS = new Set(['same-production', 'out-of-scope']);
// A category joins this set only with a stated rule the rest of the site
// already follows; children's shows, magic and comedy are NOT out of scope
// (the-gruffalo-west-end-2010, impossible-west-end-2015 are listed).
const OUT_OF_SCOPE_CATEGORIES = new Set([
  // Student/youth ensembles (National Youth Theatre REP seasons): the site
  // lists professional productions only and carries no youth-company row.
  'non-professional-company',
]);

/** The season's justifications; [] when the file or season is absent. */
function loadGapJustifications(root, season) {
  try {
    const all = JSON.parse(fs.readFileSync(path.join(root, GAP_JUSTIFICATIONS_FILE), 'utf8'));
    return Array.isArray(all.seasons?.[season]) ? all.seasons[season] : [];
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

/** Structural problems in one season's justifications against its reference list ([] = valid). */
function validateGapJustifications(justifications, reference) {
  const errors = [];
  const seen = new Set();
  for (const j of justifications) {
    const label = `${j.title} (${j.start})`;
    const key = `${j.title}\u0000${j.start}`;
    if (seen.has(key)) errors.push(`${label}: duplicate`);
    seen.add(key);
    if (!reference.some(r => r.title === j.title && r.start === j.start)) errors.push(`${label}: no such reference entry`);
    if (!GAP_KINDS.has(j.kind)) errors.push(`${label}: unknown kind ${j.kind}`);
    if (j.kind === 'same-production' && !(typeof j.showId === 'string' && j.showId)) errors.push(`${label}: same-production needs showId`);
    if (j.kind === 'out-of-scope' && !OUT_OF_SCOPE_CATEGORIES.has(j.category)) errors.push(`${label}: unknown out-of-scope category ${j.category}`);
    if (!(typeof j.reason === 'string' && j.reason.trim().length >= 20)) errors.push(`${label}: reason missing or too short`);
    let evidenceOk = Array.isArray(j.evidence) && j.evidence.length > 0;
    if (evidenceOk) {
      try { evidenceOk = j.evidence.every(u => new URL(u).protocol === 'https:'); } catch { evidenceOk = false; }
    }
    if (!evidenceOk) errors.push(`${label}: evidence needs one or more https URLs`);
  }
  return errors;
}

const REVIEW_SIGNAL_SOURCES = { guardian: 'Guardian review', 'tr-az': 'Theatre Record review' };

/**
 * Promotion candidates (promote-historical-we.js, origin 'reference') for the
 * reference entries the site is missing. Dated from Theatricalia, which gives
 * the first performance only: written collapsed with an unconfirmed source so
 * the press-night repair and the audit's opening check both see it. Entries
 * with no closing date stay out (decideWeHistoricalPromotion refuses them).
 */
function referenceCandidates({ season, reference, shows, justifications = [] }) {
  const missing = referenceCoverage({ reference, shows, justifications }).missing.sort((a, b) => a.start.localeCompare(b.start));
  // A return run of a production this list already adds (The Father:
  // Wyndham's to Nov 2015, Duke of York's from Feb 2016) is that row, not a second one.
  const kept = missing.filter((m, i) => !missing.slice(0, i).some(e => titlesMatch(e.title, m.title) && e.end
    && Date.parse(m.start) >= Date.parse(e.end) && Date.parse(m.start) - Date.parse(e.end) <= RETURN_RUN_DAYS * DAY_MS));
  return kept.map(m => {
    const r = reference.find(e => e.title === m.title && e.venue === m.venue && e.start === m.start) || m;
    return {
      title: r.title,
      venue: r.venue,
      previewsStartDate: r.start,
      openingDate: r.start,
      openingDateSource: THEATRICALIA_FIRST_PERFORMANCE_SOURCE,
      closingDate: r.end || null,
      genres: [],
      season,
      origin: 'reference',
      // Only review sources are review signals (decideWeHistoricalPromotion):
      // a Guardian review near the start, or a Theatre Record A-Z entry.
      signals: (r.sources || []).filter(x => REVIEW_SIGNAL_SOURCES[x]).map(x => REVIEW_SIGNAL_SOURCES[x]),
      sourceUrls: { theatricalia: r.url || null },
    };
  });
}

module.exports = {
  referenceCandidates,
  parseTheatricaliaDates,
  parseTheatricaliaList,
  buildSeasonReference,
  referenceCoverage,
  loadGapJustifications,
  validateGapJustifications,
  GAP_JUSTIFICATIONS_FILE,
  OUT_OF_SCOPE_CATEGORIES,
  titlesMatch,
  titleKey,
  inSeason,
  MIN_RUN_DAYS,
  MIN_REFERENCE_COVERAGE,
  MATCH_WINDOW_DAYS,
};
