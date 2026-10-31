'use strict';
/**
 * Sourced fact-check sample of a historical backfill (BRO-5080).
 *
 * The two historical backfills (West End `we-historical:wos`, Broadway rows
 * tagged `historical`) were written by scrapers and LLM enrichers, and earlier
 * spot checks found whole classes of wrong facts: a famous director put on a
 * revival, plays typed as musicals, dates from an older production, posters
 * of another staging. This module draws a reproducible stratified sample and
 * scores two independent web-grounded checkers' answers against the stored
 * row, so an error rate can be measured instead of guessed.
 *
 * Rules the harness keeps:
 *   - the checker is asked for the fact (identity = title + market + season),
 *     never shown our value to confirm;
 *   - an answer counts only with a source URL whose page was fetched and
 *     contains the value (`pageSupports`); anything else is "unsourced";
 *   - stored value vs sourced answers: agree -> ok, any sourced disagreement
 *     -> adjudicate (a human opens the page and records the verdict).
 *
 * Pure, no I/O (CLAUDE.md §15): scripts/lib/fact-check-sample.test.mjs.
 * CLI: scripts/fact-check-historical-sample.js.
 */

const { normalizeVenueName } = require('./image-source-match');
const { findCanonical } = require('./venue-aliases');
const { isBroadwayCategory } = require('./venue-classification');
const { WE_HISTORICAL_DISCOVERY_SOURCES } = require('./we-historical-corroboration');

const WE_SEASONS = ['2018-2019', '2019-2020', '2020-2021', '2021-2022', '2022-2023', '2023-2024'];

const COHORTS = {
  'we-historical': {
    label: 'West End historical backfill (we-historical:wos)',
    market: 'West End (London)',
    // WOS rows only: review-led 'we-historical:tr' rows are covered by season samples (cohortRows).
    filter: (s) => s.discoverySource === 'we-historical:wos' && WE_SEASONS.includes(s.season),
    stratum: (s) => s.season,
  },
  'broadway-historical': {
    label: 'Broadway historical backfill (tag "historical")',
    market: 'Broadway (New York)',
    // An explicit category only: isBroadwayCategory also admits a null one.
    filter: (s) => !!s.category && isBroadwayCategory(s) && Array.isArray(s.tags) && s.tags.includes('historical')
      && !String(s.discoverySource || '').startsWith('we-historical'),
    stratum: (s) => {
      const y = parseInt(String(s.openingDate || s.previewsStartDate || '').slice(0, 4), 10);
      return Number.isFinite(y) ? `${Math.floor(y / 10) * 10}s` : 'undated';
    },
  },
  'off-broadway-historical': {
    label: 'Off-Broadway historical backfill (tag "historical" or discoverySource ob-historical:*)',
    market: 'Off-Broadway (New York)',
    // Same rows as audit-review-crossmodel.js 'ob-historical' (BRO-6019).
    filter: (s) => require('./ob-historical-cohort').isObHistoricalRow(s),
    stratum: (s) => {
      const y = parseInt(String(s.openingDate || s.previewsStartDate || '').slice(0, 4), 10);
      return Number.isFinite(y) ? `${Math.floor(y / 10) * 10}s` : 'undated';
    },
  },
};
// BRO-6489: NYC show facts. Carries its own fields, prompt and comparisons (scripts/lib/nyc-facts-audit.js);
// a getter because that module reads this one's helpers.
Object.defineProperty(COHORTS, 'nyc-facts', { enumerable: true, get: () => require('./nyc-facts-audit').NYC_COHORT });

/** mulberry32: tiny seeded PRNG, so a sample re-draws identically from the same seed. */
function prng(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates over a copy sorted by id first, so input order never changes the draw. */
function seededShuffle(rows, seed) {
  const out = [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const rnd = prng(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Proportional allocation by largest remainder, at least one row per stratum
 * when n allows. Returns rows in stratum order, each with `stratum` noted.
 */
function stratifiedSample(rows, stratumOf, n, seed, allocation = 'proportional') {
  const groups = new Map();
  for (const r of rows) {
    const k = stratumOf(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const keys = [...groups.keys()].sort();
  const total = rows.length;
  const want = Math.min(n, total);
  const alloc = new Map();
  const quotas = keys.map((k) => {
    const q = (groups.get(k).length / total) * want;
    return { k, base: Math.floor(q), rem: q - Math.floor(q) };
  });
  // 'equal': the same share per stratum (capped at its size), for a pilot that must see every stratum.
  if (allocation === 'equal') {
    const each = Math.floor(want / keys.length);
    quotas.forEach((q) => { q.base = Math.min(each, groups.get(q.k).length); q.rem = 1; });
  }
  for (const { k, base } of quotas) alloc.set(k, base);
  if (want >= keys.length) for (const k of keys) if (alloc.get(k) === 0) alloc.set(k, 1);
  let used = [...alloc.values()].reduce((a, b) => a + b, 0);
  const byRem = [...quotas].sort((a, b) => b.rem - a.rem || a.k.localeCompare(b.k));
  // Equal allocation can leave quota on strata smaller than their share; keep
  // handing it out (one per pass) so n >= population still takes every row.
  for (let i = 0; used < want && i < byRem.length * (allocation === 'equal' ? want + 1 : 2); i++) {
    const { k } = byRem[i % byRem.length];
    if (alloc.get(k) < groups.get(k).length) { alloc.set(k, alloc.get(k) + 1); used++; }
  }
  while (used > want) {
    const k = [...alloc.entries()].sort((a, b) => b[1] - a[1])[0][0];
    alloc.set(k, alloc.get(k) - 1); used--;
  }
  const out = [];
  keys.forEach((k, i) => {
    const picked = seededShuffle(groups.get(k), Number(seed) + i * 7919).slice(0, alloc.get(k));
    for (const r of picked) out.push({ ...r, stratum: k });
  });
  return out;
}

/**
 * "we-historical" or a season-scoped key "we-historical-2024-2025" ->
 * {base, season}. A season key samples that season only, for the season
 * audit (scripts/audit-we-historical-season.js), whatever WE_SEASONS lists.
 */
function parseCohortKey(key) {
  const m = String(key || '').match(/^(.*?)-(\d{4}-\d{4})$/);
  const base = m ? m[1] : String(key || '');
  if (!COHORTS[base]) throw new Error(`unknown cohort ${key} (have: ${Object.keys(COHORTS).join(', ')}, optionally -YYYY-YYYY)`);
  return { base, season: m ? m[2] : null };
}

function cohortRows(shows, key) {
  const { base, season } = parseCohortKey(key);
  const c = COHORTS[base];
  if (!season) return shows.filter(c.filter);
  // A season key widens the WE cohort past WE_SEASONS and to every row the
  // season audit gates, review-led 'we-historical:tr' rows included (BRO-5851).
  const sourceOk = base === 'we-historical' ? (s) => WE_HISTORICAL_DISCOVERY_SOURCES.has(s.discoverySource) : c.filter;
  return shows.filter((s) => sourceOk(s) && s.season === season);
}

/** The cohort's rows and the seeded sample (ids + strata), ready to save. */
function drawSample(shows, cohortName, n, seed) {
  const { base, season } = parseCohortKey(cohortName);
  const cohort = COHORTS[base];
  const label = season && base === 'we-historical' ? `West End historical backfill ${season} (we-historical:wos + we-historical:tr + we-historical:olt)` : cohort.label;
  const rows = cohortRows(shows, cohortName);
  const sample = stratifiedSample(rows, cohort.stratum, n, seed, cohort.allocation);
  const strata = {};
  for (const r of rows) { const k = cohort.stratum(r); strata[k] = strata[k] || { population: 0, sampled: 0 }; strata[k].population++; }
  for (const r of sample) strata[r.stratum].sampled++;
  return { cohort: cohortName, label, seed: Number(seed), n: sample.length, population: rows.length, strata, ids: sample.map((r) => ({ id: r.id, stratum: r.stratum })) };
}

/** "2019-2020" -> "the 2019-20 season". */
function seasonPhrase(season) {
  const m = String(season || '').match(/^(\d{4})-(\d{4})$/);
  return m ? `the ${m[1]}-${m[2].slice(2)} theatre season (roughly mid-${m[1]} to mid-${m[2]})` : 'an unknown season';
}

/**
 * When the production played, for the checker prompts. Rows with no season
 * (Off-Broadway and some Broadway historical rows) are identified by the year
 * their run began: "an unknown season" sent the checker to a same-title revival
 * (School Pictures 2023 vs Cherry Lane 2026, BRO-6019). Year only, from the
 * earlier of the two stored dates: both are checked fields, and a month would
 * hand the checker the very value it should verify (an openingDate stored as
 * the first preview is often a month off; ship-check review, BRO-6019).
 */
function productionTimePhrase(show) {
  if (show && /^\d{4}-\d{4}$/.test(String(show.season || ''))) return seasonPhrase(show.season);
  const years = [show && show.previewsStartDate, show && show.openingDate]
    .map((d) => String(d || '').match(/^(\d{4})-/)).filter(Boolean).map((m) => Number(m[1]));
  return years.length ? `the run that began around ${Math.min(...years)}` : 'an unknown season';
}

/** Market label for a cohort key, season-scoped keys included. */
function cohortMarket(key) {
  return COHORTS[parseCohortKey(key).base].market;
}

/**
 * The question both checkers get. Identity only: title, market, season. No
 * stored venue, date, credit or type, so the answer is the checker's own.
 */
function buildFactPrompt(show, cohortName) {
  const market = cohortMarket(cohortName);
  return `Use web search. I need facts about one specific theatre production: "${show.title}" in the ${market} market, the production that played during ${productionTimePhrase(show)}. If this title had several productions, answer only about the one in that market and season.

Return JSON only, no prose, in this exact shape. Every non-null value needs the URL of a web page that states it (a page you actually found, not a guess). Never use broadwayscorecard.com as a source: it is the site being checked. Use null when you cannot find a page that states the fact.
{
  "theatre": {"value": "theatre name", "source": "url"},
  "city": {"value": "city", "source": "url"},
  "previewsStart": {"value": "YYYY-MM-DD", "source": "url"},
  "openingNight": {"value": "YYYY-MM-DD (official press/opening night, not first preview)", "source": "url"},
  "closing": {"value": "YYYY-MM-DD (final performance)", "source": "url"},
  "type": {"value": "play | musical | other", "source": "url"},
  "directors": {"value": ["name"], "source": "url"},
  "writers": {"value": [{"name": "name", "role": "playwright | book | music | lyrics | adaptation | original author"}], "source": "url"},
  "leadCast": {"value": ["up to 4 names"], "source": "url"}
}`;
}

/** First JSON object in a model reply (tolerates ```json fences and prose). */
function parseJsonReply(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch (e) { return null; }
}

function foldText(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[‘’`]/g, "'").replace(/&/g, ' and ').replace(/[^a-z0-9']+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Comparable person name: accents/case/punctuation dropped, middle initials removed. */
function normalizePerson(name) {
  return foldText(name).replace(/'/g, '').split(' ').filter((t) => t.length > 1 || /\d/.test(t)).join(' ');
}

/** Same person: equal normalized names, or same first and last token (middle names dropped). */
function samePerson(a, b) {
  const x = normalizePerson(a); const y = normalizePerson(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const xs = x.split(' '); const ys = y.split(' ');
  return xs[0] === ys[0] && xs[xs.length - 1] === ys[ys.length - 1];
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** Spellings of an ISO date a page might use. */
function dateSpellings(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return [];
  const [, y, mo, d] = m;
  const month = MONTHS[Number(mo) - 1];
  const mon = month.slice(0, 3);
  const day = String(Number(d));
  const ord = day + (/1[123]$/.test(day) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[day.slice(-1)] || 'th'));
  const words = [`${y}-${mo}-${d}`, `${day} ${month} ${y}`, `${ord} ${month} ${y}`, `${month} ${day} ${y}`, `${month} ${ord} ${y}`, `${day} ${mon} ${y}`, `${mon} ${day} ${y}`];
  // 09/05/2019 is 9 May in London and 5 September in New York: numeric forms
  // only when the day cannot be read as a month (or both read the same).
  const numeric = Number(d) > 12 || d === mo ? [`${d}/${mo}/${y}`, `${mo}/${d}/${y}`, `${Number(mo)}/${day}/${y}`, `${day}/${Number(mo)}/${y}`] : [];
  return [...words, ...numeric].map(foldText);
}

/** Does fetched page text state this value? kind: date | venue | person | type | text. */
function pageSupports(pageText, value, kind) {
  const page = ` ${foldText(pageText)} `;
  if (!page.trim() || value == null || value === '') return false;
  if (kind === 'date') {
    const pageNoComma = page; // foldText already turned commas into spaces
    return dateSpellings(value).some((s) => s && pageNoComma.includes(` ${s} `));
  }
  if (kind === 'venue') {
    const v = normalizeVenueName(value);
    return !!v && ` ${normalizeVenueName(pageText)} `.includes(` ${v} `);
  }
  if (kind === 'person') {
    const n = normalizePerson(value);
    if (!n) return false;
    if (page.includes(` ${n} `)) return true;
    const t = n.split(' ');
    return t.length > 1 && page.includes(` ${t[0]} `) && page.includes(` ${t[t.length - 1]} `);
  }
  if (kind === 'type') return page.includes(` ${foldText(value)} `);
  return page.includes(` ${foldText(value)} `);
}

/**
 * Venue equality across renames ("Trafalgar Studios" is today's "Trafalgar
 * Theatre") and compound names: checkers write "Lyttelton Theatre, National
 * Theatre" or "Jerwood Theatre Downstairs (Royal Court Theatre)", so each
 * comma/parenthesis/dash part is compared on its own. Parts are compared for
 * equality, never containment, so "Apollo" never matches "Apollo Victoria".
 */
function sameVenue(a, b, market) {
  if (!a || !b) return false;
  // Both name an auditorium and they differ (Upstairs vs Downstairs, Studio 1 vs 2): not the same room.
  const aa = auditoria(a); const ab = auditoria(b);
  if (aa.length && ab.length && !aa.some((x) => ab.includes(x))) return false;
  const parts = (s) => [s, ...String(s).split(/\s*[,()\u2013\u2014]\s*|\s+-\s+/)].map((x) => x.trim()).filter(Boolean);
  const pa = parts(a); const pb = parts(b);
  if (pa.length > 1 || pb.length > 1) return pa.some((x) => pb.some((y) => sameVenueOne(x, y, market)));
  return sameVenueOne(a, b, market);
}

// Named rooms only: "Main House" is left out (the Royal Court's main house IS
// Downstairs) and a bare digit is left out (street numbers).
const AUDITORIUM_RE = /\b(upstairs|downstairs|studios? (?:1|2|one|two)|theatre (?:1|2))\b/g;
function auditoria(s) { return (String(s).toLowerCase().match(AUDITORIUM_RE) || []).map((x) => x.replace(/\bone\b/, '1').replace(/\btwo\b/, '2').replace(/\D*(\d)$/, '$1')); }

function sameVenueOne(a, b, market) {
  const na = normalizeVenueName(a); const nb = normalizeVenueName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ca = normalizeVenueName(findCanonical(a, market)); const cb = normalizeVenueName(findCanonical(b, market));
  if (ca === cb) return true;
  // "Trafalgar Studios 2" vs "Trafalgar Studios": a studio inside the named house.
  const strip = (s) => s.replace(/\b(studio|studios|main house|downstairs|upstairs|1|2|one|two)\b/g, ' ').replace(/\s+/g, ' ').trim();
  return strip(na) !== '' && strip(na) === strip(nb);
}

const WRITER_ROLE_RE = /playwright|book|music|lyric|composer|adapt|writ|libretto|author|text|conceived|creator/i;
const DIRECTOR_ROLE_RE = /^director\b|^director &|^co-director|& director$/i;

/** Stored row's people for the two credit fields. */
function storedCredits(show) {
  const ct = Array.isArray(show.creativeTeam) ? show.creativeTeam : [];
  return {
    directors: ct.filter((m) => DIRECTOR_ROLE_RE.test(String(m.role || '').trim())).map((m) => m.name),
    writers: ct.filter((m) => WRITER_ROLE_RE.test(String(m.role || '')) && !/design|direct|supervis|orchestrat|arrang|choreo/i.test(String(m.role || ''))).map((m) => m.name),
  };
}

/** Our own site (or a copy of its data) cannot confirm itself. */
const SELF_SOURCE_RE = /(^|[/.])broadwayscorecard\.com/i;
function isSelfSource(url) { return SELF_SOURCE_RE.test(String(url || '')); }

/**
 * Checkers do not always keep the {value, source} shape: Gemini often returns
 * a credit field as a bare array ("writers": [{name, role, source}]) or a bare
 * string. Fold those into {value, source} so the answer is not dropped.
 */
function normalizeAnswer(ans) {
  if (!ans || typeof ans !== 'object') return ans;
  const out = {};
  for (const [k, f] of Object.entries(ans)) {
    if (Array.isArray(f)) {
      const src = f.map((x) => x && typeof x === 'object' && x.source).find(Boolean) || null;
      const items = f.map((x) => (x && typeof x === 'object' ? (x.name ? { name: x.name, role: x.role } : x.value) : x));
      // Each person may cite their own page: keep them so support checks each name against its source.
      const itemSources = f.map((x) => (x && typeof x === 'object' && x.source) || null);
      out[k] = { value: items.filter((x) => x != null), source: src, ...(itemSources.some((u) => u && u !== src) ? { itemSources: itemSources.filter((u, i) => items[i] != null) } : {}) };
    } else if (f != null && typeof f !== 'object') out[k] = { value: f, source: null };
    else if (f && typeof f === 'object' && !('value' in f) && f.name) out[k] = { value: [{ name: f.name, role: f.role }], source: f.source || null };
    else out[k] = f;
  }
  return out;
}

/** Value of one checker field, or null. */
function answerValue(ans, field) {
  const f = ans && ans[field];
  if (!f || typeof f !== 'object') return null;
  const v = f.value;
  if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) return null;
  return v;
}

function namesOf(v) {
  return (Array.isArray(v) ? v : [v]).map((x) => (x && typeof x === 'object' ? x.name : x)).filter(Boolean).map(String);
}

/**
 * Compare a stored value with one checker's answer for a field.
 * @returns {'agree'|'disagree'|'no-answer'|'no-stored'}
 */
function compareField(field, show, value, market) {
  const stored = storedValue(show, field);
  if (value == null) return 'no-answer';
  if (stored == null || (Array.isArray(stored) && stored.length === 0)) return 'no-stored';
  switch (field) {
    case 'theatre': return sameVenue(stored, value, market) ? 'agree' : 'disagree';
    case 'previewsStart': case 'openingNight': case 'closing': return stored === String(value).slice(0, 10) ? 'agree' : 'disagree';
    case 'type': {
      const v = foldText(value);
      const t = /musical|opera|revue/.test(v) ? 'musical' : /play|drama|comedy|tragedy/.test(v) ? 'play' : v;
      return t === stored ? 'agree' : 'disagree';
    }
    case 'directors': case 'writers': {
      const found = namesOf(value);
      // IBDB-derived rows store one credit for a team ("Moss Hart and George S. Kaufman").
      const people = stored.flatMap((p) => String(p).split(/\s*(?:,|&|\band\b)\s*/i)).map((p) => p.trim()).filter((p) => p.split(' ').length > 1);
      if (people.length) return people.every((p) => found.some((f) => samePerson(p, f))) ? 'agree' : 'disagree';
      // Every stored person must be credited by the checker; extra people the
      // checker names are "missing on our side", not an error in what we show.
      return stored.every((p) => found.some((f) => samePerson(p, f))) ? 'agree' : 'disagree';
    }
    default: return 'no-answer';
  }
}

/** The stored value the site shows for a checked field. */
function storedValue(show, field) {
  switch (field) {
    case 'theatre': return show.venue || null;
    case 'previewsStart': return show.previewsStartDate || null;
    case 'openingNight': return show.openingDate || null;
    case 'closing': return show.closingDate || null;
    case 'type': return show.type || null;
    case 'directors': return storedCredits(show).directors;
    case 'writers': return storedCredits(show).writers;
    default: return null;
  }
}

const FACT_FIELDS = ['theatre', 'previewsStart', 'openingNight', 'closing', 'type', 'directors', 'writers'];
const FIELD_KIND = { theatre: 'venue', previewsStart: 'date', openingNight: 'date', closing: 'date', type: 'type', directors: 'person', writers: 'person' };

/**
 * Field triage from both checkers. `checks` = [{checker, answer, support}],
 * support[field] = true when the cited page was fetched and states the value.
 * Returns {status, detail} with status:
 *   ok           at least one sourced answer agrees and none sourced disagrees
 *   adjudicate   a sourced answer disagrees (or checkers' sourced answers split)
 *   unsourced    no checker gave a page-supported answer
 *   not-stored   we store nothing (a gap, counted apart from errors)
 */
function triageField(field, show, checks, market, impl = {}) {
  const compare = impl.compareField || compareField;
  const storedOf = impl.storedValue || storedValue;
  const sourced = [];
  const loose = [];
  for (const raw of checks) {
    const c = { ...raw, answer: normalizeAnswer(raw.answer) };
    const v = answerValue(c.answer, field);
    const cmp = compare(field, show, v, market);
    const source = c.answer && c.answer[field] && c.answer[field].source;
    const row = { checker: c.checker, value: v, source, cmp, supported: !!(c.support && c.support[field]) && !isSelfSource(source) };
    (row.supported ? sourced : loose).push(row);
  }
  const all = [...sourced, ...loose];
  const stored = storedOf(show, field);
  if (stored == null || (Array.isArray(stored) && stored.length === 0)) return { status: 'not-stored', detail: all };
  if (sourced.some((r) => r.cmp === 'disagree')) return { status: 'adjudicate', detail: all };
  if (sourced.some((r) => r.cmp === 'agree')) return { status: loose.some((r) => r.cmp === 'disagree') ? 'adjudicate' : 'ok', detail: all };
  if (loose.some((r) => r.cmp === 'disagree')) return { status: 'adjudicate', detail: all };
  // Both checkers independently agree, each citing a page we could not load
  // (BroadwayWorld 403s every fetch): counted correct, reported as weaker.
  const cited = loose.filter((r) => r.cmp === 'agree' && r.source && !isSelfSource(r.source));
  if (new Set(cited.map((r) => r.checker)).size >= 2) return { status: 'ok-cited', detail: all };
  return { status: 'unsourced', detail: all };
}

/** Wilson 95% interval for k errors in n checked. */
function wilson(k, n) {
  if (!n) return [0, 0];
  const z = 1.96; const p = k / n;
  const den = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / den;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

/**
 * Per-field error table. verdicts: [{id, field, verdict: 'correct'|'wrong'|'unverifiable'|'not-stored'}].
 * Error rate = wrong / (correct + wrong); unverifiable rows are reported, not counted.
 */
function errorTable(verdicts) {
  const t = {};
  for (const v of verdicts) {
    const r = t[v.field] = t[v.field] || { correct: 0, wrong: 0, unverifiable: 0, notStored: 0 };
    if (v.verdict === 'correct') r.correct++;
    else if (v.verdict === 'wrong') r.wrong++;
    else if (v.verdict === 'not-stored') r.notStored++;
    else r.unverifiable++;
  }
  for (const r of Object.values(t)) {
    const n = r.correct + r.wrong;
    r.checked = n;
    r.rate = n ? r.wrong / n : 0;
    r.ci95 = wilson(r.wrong, n);
  }
  return t;
}

/**
 * Advisory line for a season audit: the sourced sample's verdicts for this
 * season's rows. verdicts: [{id, field, verdict}] over every checked cohort.
 * Returns {sampled, table, wrong} or {sampled: 0} when no sampled row is in the season.
 */
function seasonSummary(verdicts, seasonIds) {
  const ids = new Set(seasonIds);
  // A row in two samples (cross-season and season) counts once; the later verdict list wins.
  // A definitive verdict (wrong/correct/not-stored) is never replaced by a weaker one.
  const rank = (v) => (v.verdict === 'wrong' || v.verdict === 'correct' || v.verdict === 'not-stored' ? 1 : 0);
  const byKey = new Map();
  for (const v of verdicts || []) {
    if (!ids.has(v.id)) continue;
    const k = `${v.id}|${v.field}`; const prev = byKey.get(k);
    if (!prev || rank(v) >= rank(prev)) byKey.set(k, v);
  }
  const mine = [...byKey.values()];
  const sampled = new Set(mine.map((v) => v.id)).size;
  if (!sampled) return { sampled: 0 };
  return { sampled, table: errorTable(mine), wrong: mine.filter((v) => v.verdict === 'wrong') };
}

module.exports = {
  COHORTS, WE_SEASONS, FACT_FIELDS, FIELD_KIND,
  prng, seededShuffle, stratifiedSample, drawSample, parseCohortKey, cohortMarket, cohortRows, seasonSummary,
  seasonPhrase, productionTimePhrase, buildFactPrompt, parseJsonReply,
  normalizePerson, samePerson, dateSpellings, pageSupports, sameVenue,
  storedCredits, storedValue, isSelfSource, normalizeAnswer, compareField, triageField, wilson, errorTable,
};
