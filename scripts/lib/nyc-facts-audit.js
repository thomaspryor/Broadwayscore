'use strict';
/**
 * NYC show-facts audit (BRO-6489): the `nyc-facts` cohort for the sourced
 * fact-check harness (scripts/lib/fact-check-sample.js, BRO-5080).
 *
 * New Broadway and Off-Broadway rows kept surfacing the same classes of
 * error: the wrong house or stage (Playwrights Horizons Mainstage vs Peter
 * Jay Sharp), Broadway vs Off-Broadway, a first preview stored as opening
 * night, closings that missed an extension, and Off-Broadway transfers whose
 * earlier or later run is missing or unlinked. This module defines the
 * cohort (every NYC row that began on or after 2021-06-01, plus everything
 * current or upcoming), the checker question, how each answer compares with
 * the stored row, and two free deterministic checks over the whole scope.
 *
 * The harness rules hold: checkers are asked for the fact, never shown our
 * value; an answer counts only with a fetched page that states it.
 *
 * Pure, no I/O (CLAUDE.md §15): scripts/lib/nyc-facts-audit.test.mjs.
 */

const { isObHistoricalRow } = require('./ob-historical-cohort');
const { isOfficialBroadwayTheater } = require('./broadway-theaters');
const { isNonNycVenue, isBroadwayCategory } = require('./venue-classification');
const { isPlaceholderVenue } = require('./placeholder-venue');
const { baseTitle } = require('./prior-run-sibling');

// Lazy: fact-check-sample.js registers this cohort, so a top-level require would be circular.
const fc = () => require('./fact-check-sample');

const NYC_SINCE = '2021-06-01';
const CURRENT_STATUSES = new Set(['open', 'previews', 'upcoming', 'announced']);
const NYC_FIELDS = ['theatre', 'tier', 'previewsStart', 'openingNight', 'closing', 'type', 'revival', 'otherRuns'];
const NYC_FIELD_KIND = { theatre: 'venue', tier: 'tier', previewsStart: 'date', openingNight: 'date', closing: 'date', type: 'type', revival: 'revival', otherRuns: 'run' };

function firstDate(s) {
  return [s.previewsStartDate, s.openingDate].filter(Boolean).sort()[0] || '';
}

function isNycFactsRow(s) {
  if (!s || (s.category !== 'broadway' && s.category !== 'off-broadway')) return false;
  return firstDate(s) >= NYC_SINCE || CURRENT_STATUSES.has(s.status);
}

/** Current rows first, so a row is in exactly one stratum. */
function nycStratum(s) {
  if (CURRENT_STATUSES.has(s.status)) return 'current-upcoming';
  if (s.category === 'off-broadway') return isObHistoricalRow(s) ? 'ob-backfilled' : 'ob-recent';
  return 'bway-recent';
}

/**
 * The question both checkers get. Identity only: title, city, the year the
 * run began (or the stated status when no date is stored: announced rows
 * mostly have none). No venue, category, date, type or revival flag.
 */
function buildNycFactPrompt(show, today) {
  const y = firstDate(show).slice(0, 4);
  const when = y ? `the production that began performances around ${y}` : 'the production currently announced or running';
  return `Use web search. Today is ${today}. I need facts about one specific New York City theatre production: "${show.title}", ${when}. If this title had several New York productions, answer only about that one.

Return JSON only, no prose, in this exact shape. Every non-null value needs the URL of a web page that states it (a page you actually found, not a guess). Never use broadwayscorecard.com as a source: it is the site being checked. Use null when you cannot find a page that states the fact.
{
  "theatre": {"value": "the theatre AND the specific stage or space inside it, e.g. 'Peter Jay Sharp Theater at Playwrights Horizons'", "source": "url"},
  "tier": {"value": "Broadway | Off-Broadway | Off-Off-Broadway", "source": "url"},
  "previewsStart": {"value": "YYYY-MM-DD (first public performance)", "source": "url"},
  "openingNight": {"value": "YYYY-MM-DD (official opening/press night, not first preview)", "source": "url"},
  "closing": {"value": "YYYY-MM-DD (final performance, including any extension; the scheduled one if still running)", "source": "url"},
  "type": {"value": "play | musical | opera | special (concert, dance, magic, circus or variety)", "source": "url"},
  "revival": {"value": "new | Broadway revival | Off-Broadway revival (Broadway revival = a new staging of a work that already had an earlier Broadway production; Off-Broadway revival = a new staging of a work with an earlier professional New York production but none on Broadway; the same production moving or transferring from another theatre is new, not a revival)", "source": "url"},
  "otherRuns": {"value": [{"theatre": "name", "began": "YYYY-MM", "relation": "earlier run | transfer | later run | return engagement"}], "source": "url (other New York runs of this same production at a different theatre; [] if none)"}
}`;
}

/** What the site shows for a checked field (engine.ts:678 for revival). */
function nycStoredValue(show, field) {
  switch (field) {
    case 'tier': return isBroadwayCategory(show) ? 'broadway' : show.category === 'off-broadway' ? 'off-broadway' : null;
    case 'revival': return (show.isRevival || show.type === 'revival' || (Array.isArray(show.tags) && show.tags.includes('revival'))) ? 'revival' : 'new';
    case 'otherRuns': return null; // judged against the catalog, see otherRunsTriage
    default: return fc().storedValue(show, field);
  }
}

function foldTier(v) {
  const t = String(v || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  if (/\boff off broadway\b/.test(t)) return 'off-off-broadway';
  if (/\boff broadway\b/.test(t)) return 'off-broadway';
  if (/\bbroadway\b/.test(t)) return 'broadway';
  return t;
}

/** Answer words onto shows.json type values (play | musical | opera | special). */
function foldType(v) {
  const t = String(v || '').toLowerCase();
  if (/\bopera\b/.test(t) && !/rock opera|pop opera/.test(t)) return 'opera';
  if (/musical|revue|rock opera|pop opera/.test(t)) return 'musical';
  if (/magic|illusion|circus|variety|concert|dance|cabaret/.test(t)) return 'special';
  if (/\bplay\b|drama|comedy|tragedy/.test(t)) return 'play';
  if (/other|special|solo show/.test(t)) return 'special';
  return t;
}

/**
 * Broadway rows follow IBDB: only an earlier Broadway production makes a
 * revival, so an Off-Broadway-to-Broadway premiere (Between Riverside and
 * Crazy, Fat Ham) is new. Off-Broadway rows count any earlier NYC staging.
 */
function foldRevival(v, category) {
  const t = String(v || '').toLowerCase();
  if (/off[- ]broadway revival/.test(t)) return isBroadwayCategory({ category }) ? 'new' : 'revival';
  if (/revival|revive/.test(t)) return 'revival';
  if (/new|premiere|original/.test(t)) return 'new';
  return t;
}

const GENERIC_VENUE_TOKENS = new Set(['the', 'theatre', 'theater', 'at', 'of', 'and', 'company', 'center', 'centre', 'stage', 'nyc', 'new', 'york', 'space', 'in', 'on']);
function venueTokens(v) {
  return new Set(String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').split(' ').filter((t) => t && !GENERIC_VENUE_TOKENS.has(t)));
}

/**
 * Same house AND same stage. 'agree' when one name's distinctive words are a
 * subset of the other's ("Linda Gross Theater (Atlantic Theater Company)" =
 * "Atlantic Theater Company - Linda Gross Theater"; a stored house without the
 * stage still agrees, reported as 'less-specific'). Both naming different extra
 * words is a different room: "Playwrights Horizons Mainstage" vs "Peter Jay
 * Sharp Theater at Playwrights Horizons". An alias/rename match (sameVenue's
 * canonical lookup) on the whole name agrees first.
 * @returns {'agree'|'less-specific'|'disagree'}
 */
function compareNycVenue(stored, answer) {
  const a = venueTokens(stored); const b = venueTokens(answer);
  if (!a.size || !b.size) return 'disagree';
  const onlyA = [...a].filter((t) => !b.has(t)); const onlyB = [...b].filter((t) => !a.has(t));
  if (!onlyA.length && !onlyB.length) return 'agree';
  if (!onlyA.length) return 'less-specific';
  if (!onlyB.length) return 'agree';
  // Renames and spellings only through the curated lists: venue-aliases, then the 41 Broadway houses.
  const { findCanonical } = require('./venue-aliases');
  const ca = findCanonical(stored, 'broadway'); const cb = findCanonical(answer, 'broadway');
  if (ca && cb && ca === cb) return 'agree';
  const bt = require('./broadway-theaters');
  if (bt.isOfficialBroadwayTheater(stored) && bt.isOfficialBroadwayTheater(answer) && bt.getCanonicalVenueName(stored) === bt.getCanonicalVenueName(answer)) return 'agree';
  return 'disagree';
}

/** Compare a stored value with one checker's answer. Same contract as fact-check-sample compareField. */
function nycCompareField(field, show, value, market) {
  if (value == null) return 'no-answer';
  const stored = nycStoredValue(show, field);
  if (field === 'otherRuns') return 'no-answer';
  if (stored == null) return 'no-stored';
  if (field === 'theatre') return compareNycVenue(stored, value) === 'disagree' ? 'disagree' : 'agree';
  if (field === 'tier') {
    // Off-Off-Broadway shows are filed under category 'off-broadway' on
    // purpose (no separate category, BRO-2485), so that answer is the site's
    // convention on an Off-Broadway row, not a wrong tier (35 full-run rows).
    const t = foldTier(value);
    return t === stored || (t === 'off-off-broadway' && stored === 'off-broadway') ? 'agree' : 'disagree';
  }
  if (field === 'revival') return foldRevival(value, show.category) === stored ? 'agree' : 'disagree';
  if (field === 'type') return foldType(value) === stored ? 'agree' : 'disagree';
  return fc().compareField(field, show, value, market);
}

/**
 * Page support for the NYC kinds; everything else is fact-check-sample's
 * pageSupports. "Off-Broadway" folds to "off broadway", which contains
 * "broadway", so a Broadway tier is supported only by a mention of Broadway
 * that is not part of "off(-off)-Broadway".
 */
function nycPageSupports(pageText, value, kind) {
  const lib = fc();
  if (kind === 'tier') {
    const page = ` ${String(pageText || '').toLowerCase().replace(/[^a-z]+/g, ' ')} `;
    const t = foldTier(value);
    if (t === 'off-off-broadway') return page.includes(' off off broadway ');
    if (t === 'off-broadway') return page.replace(/ off off broadway /g, ' ').includes(' off broadway ');
    if (t === 'broadway') return page.replace(/ off off broadway /g, ' ').replace(/ off broadway /g, ' ').includes(' broadway ');
    return false;
  }
  if (kind === 'revival') {
    const page = String(pageText || '').toLowerCase();
    // No bare "debut": an actor's Broadway debut says nothing about the work.
    return /revival|revive/.test(String(value || '').toLowerCase()) ? /\brevival\b|\brevived\b/.test(page) : /premiere|\bnew (?:play|musical)\b|\b(?:broadway|new york) debut of\b/.test(page);
  }
  if (kind === 'run') return lib.pageSupports(pageText, value && typeof value === 'object' ? value.theatre : value, 'venue');
  return lib.pageSupports(pageText, value, kind);
}

/**
 * Other NYC runs a checker names, against the catalog. A run counts as
 * present when the row declares it in priorRuns, or another NYC row with the
 * same base title (prior-run-sibling baseTitle) plays at that theatre. A run at
 * the row's own theatre is the row itself (extension) and is ignored.
 * checks: [{checker, answer (normalized), support}].
 * @returns {{status: 'ok'|'adjudicate'|'unsourced', runs: Array}}
 */
function otherRunsTriage(show, shows, checks) {
  const runs = [];
  for (const c of checks) {
    const f = c.answer && c.answer.otherRuns;
    const list = f && Array.isArray(f.value) ? f.value : [];
    for (const r of list) {
      const theatre = r && typeof r === 'object' ? r.theatre : r;
      if (!theatre || (show.venue && compareNycVenue(show.venue, theatre) !== 'disagree')) continue;
      const declared = (show.priorRuns || []).some((p) => p && p.venue && compareNycVenue(p.venue, theatre) !== 'disagree');
      const sibling = shows.find((s) => s.id !== show.id && (isBroadwayCategory(s) || s.category === 'off-broadway')
        && baseTitle(s) === baseTitle(show) && s.venue && compareNycVenue(s.venue, theatre) !== 'disagree');
      runs.push({ checker: c.checker, theatre, began: r.began || null, relation: r.relation || null, source: f.source || null,
        supported: !!(c.support && c.support.otherRuns), present: declared || !!sibling, siblingId: sibling ? sibling.id : null, linked: declared });
    }
  }
  if (runs.some((r) => !r.present && r.supported)) return { status: 'adjudicate', runs };
  if (runs.some((r) => !r.present)) return { status: runs.every((r) => !r.supported) ? 'unsourced' : 'adjudicate', runs };
  return { status: 'ok', runs };
}

/**
 * Free whole-scope checks, no model calls:
 *   venue-missing          no venue, or a placeholder (TBA)
 *   broadway-not-registry  category broadway, venue not one of the 41 houses (broadway-theaters.js)
 *   ob-at-broadway-house   category off-broadway at a Broadway house
 *   non-nyc-venue          venue outside New York (venue-classification isNonNycVenue)
 *   status-vs-dates        a stored status the dates contradict and the build does not correct
 *                          (closed with a future closing; not yet open with a past closing)
 *   preview-equals-opening first preview stored as opening night (the class the BRO-6489 probe found)
 * Off-Broadway venues are not checked against off-broadway-venues.json: it is
 * built from shows.json (build-ob-venues.js), so every row passes by construction.
 */
function consistencyFindings(shows, today) {
  const out = [];
  for (const s of shows.filter(isNycFactsRow)) {
    const add = (cls, detail) => out.push({ id: s.id, title: s.title, category: s.category, stratum: nycStratum(s), class: cls, detail });
    if (!s.venue || isPlaceholderVenue(s.venue).placeholder) add('venue-missing', s.venue || null);
    else {
      if (isBroadwayCategory(s) && !isOfficialBroadwayTheater(s.venue)) add('broadway-not-registry', s.venue);
      if (s.category === 'off-broadway' && isOfficialBroadwayTheater(s.venue)) add('ob-at-broadway-house', s.venue);
      if (isNonNycVenue(s.venue)) add('non-nyc-venue', s.venue);
    }
    if (s.status === 'closed' && s.closingDate && s.closingDate > today) add('status-vs-dates', `closed, closingDate ${s.closingDate}`);
    if ((s.status === 'upcoming' || s.status === 'announced' || s.status === 'previews') && s.closingDate && s.closingDate < today) add('status-vs-dates', `${s.status}, closingDate ${s.closingDate}`);
    if (s.previewsStartDate && s.openingDate && s.previewsStartDate === s.openingDate) add('preview-equals-opening', s.openingDate);
  }
  return out;
}

const NYC_COHORT = {
  label: 'NYC shows (Broadway + Off-Broadway) begun since 2021-06-01, plus current and upcoming',
  market: 'New York City',
  filter: isNycFactsRow,
  stratum: nycStratum,
  allocation: 'equal',
  fields: NYC_FIELDS,
  fieldKind: NYC_FIELD_KIND,
  skip: ['synopsis', 'poster', 'category'],
  buildPrompt: buildNycFactPrompt,
  storedValue: nycStoredValue,
  compareField: nycCompareField,
  pageSupports: nycPageSupports,
};

/** A date this far from the stored one is likely another engagement, not a typo. */
const PLAYBILL_MAX_DATE_GAP_DAYS = 60;

/** A person already corrected this field; the audit never overrides that. */
const HAND_SOURCE = /^(human-correction|manual|hand-verified)/i;
function isPinnedField(field, show) {
  if (field === 'openingNight') return !!show.humanCorrectedOpeningDate || HAND_SOURCE.test(show.openingDateSource || '');
  if (field === 'closing') return !!show.humanCorrectedClosingDate || HAND_SOURCE.test(show.closingDateSource || '');
  return false;
}

/** Years the row can belong to: its id suffix and its stored dates. */
function rowYears(show) {
  const ys = new Set();
  const m = /-(\d{4})$/.exec(show.id || '');
  if (m) ys.add(Number(m[1]));
  for (const d of [show.previewsStartDate, show.openingDate]) if (d) ys.add(Number(String(d).slice(0, 4)));
  return ys;
}

/**
 * Settle one disputed field from the row's Playbill production page, as
 * parsed by validate-show-venue.js (one entry of its `results`). Playbill is
 * the arbiter the pending-fix path trusts, so a field counts as wrong only
 * when Playbill and at least one checker independently land on the same
 * other value; Playbill alone against the row is a conflict, not a verdict.
 * Returns null when the page cannot settle the field: no same-production page
 * (venue must match), no value on the page, a closing still to come, a type
 * Playbill does not label (opera, special), or an Off-Broadway "original"
 * (Playbill does not apply this site's any-earlier-NYC-staging rule).
 */
function playbillVerdict(field, show, checkerValues, pb, today = new Date().toISOString().slice(0, 10)) {
  if (!pb || !pb.parsed || !['match', 'mismatch'].includes(pb.result) || pb.venueCheck !== 'match') return null;
  if (isPinnedField(field, show)) return null;
  // Same venue, different year: a return engagement or another production.
  const pbYear = pb.parsed.titleParse && pb.parsed.titleParse.year;
  const years = rowYears(show);
  if (pbYear && years.size && !years.has(Number(pbYear))) return null;
  const dates = pb.parsed.dates || {};
  const tag = pb.parsed.tagLine || {};
  const stored = nycStoredValue(show, field);
  let p = null;
  let same = (v) => String(v || '').slice(0, 10) === p;
  switch (field) {
    case 'theatre': return { verdict: 'correct', correctValue: null, url: pb.playbillUrl, note: 'Playbill production page venue matches' };
    case 'previewsStart': p = dates.firstPreview || null; break;
    case 'openingNight': p = dates.openingDate || null; break;
    case 'closing':
      p = show.status === 'closed' ? dates.closingDate || null : null;
      if (p && p > today) p = null;
      break;
    case 'type':
      if (!['play', 'musical'].includes(stored)) return null;
      p = ['play', 'musical'].includes(tag.showType) ? tag.showType : null;
      same = (v) => foldType(v) === p;
      break;
    case 'revival':
      p = tag.revivalStatus === 'revival' ? 'revival' : tag.revivalStatus === 'original' && isBroadwayCategory(show) ? 'new' : null;
      same = (v) => foldRevival(v, show.category) === p;
      break;
    default: return null;
  }
  if (p == null) return null;
  if (NYC_FIELD_KIND[field] === 'date' && stored && Math.abs(Date.parse(p) - Date.parse(stored)) / 864e5 > PLAYBILL_MAX_DATE_GAP_DAYS) return null;
  if (stored === p) return { verdict: 'correct', correctValue: null, url: pb.playbillUrl, note: `Playbill production page: ${p}` };
  if ((checkerValues || []).some(same)) return { verdict: 'wrong', correctValue: p, url: pb.playbillUrl, note: `Playbill production page and a checker agree on ${p}` };
  return { verdict: 'unverifiable', correctValue: null, url: pb.playbillUrl, note: `Playbill says ${p}, no checker agrees, row says ${stored}` };
}

const PLAN_FIELD = { previewsStart: 'previewsStartDate', openingNight: 'openingDate', closing: 'closingDate', type: 'type', revival: 'isRevival' };

/**
 * data-edit actions for every playbill-auto "wrong" adjudication, skipping
 * ids in `hold` (production identity a person must settle). Only
 * playbill-auto verdicts ever become row fixes; pages-auto never does.
 */
function buildPlaybillFixActions(adj, showById, hold = new Set()) {
  const actions = [];
  const held = [];
  for (const [k, v] of Object.entries(adj)) {
    if (v.by !== 'playbill-auto' || v.verdict !== 'wrong') continue;
    const [id, f] = k.split('|');
    const show = showById.get(id);
    const field = PLAN_FIELD[f];
    if (!show || !field || hold.has(id) || (f === 'revival' && !['revival', 'new'].includes(v.correctValue))) { held.push(k); continue; }
    const oldValue = show[field] === undefined ? null : show[field];
    const newValue = f === 'revival' ? v.correctValue === 'revival' : v.correctValue;
    actions.push({ type: 'data-edit', file: 'shows.json', showId: id, field, oldValue, newValue, description: `shows.json: ${id}.${field} (Playbill production page ${v.url})` });
  }
  return { actions, held };
}

/** Same answer under the field's fold (dates to the day, venue by stage). */
function sameNycAnswer(field, show, a, b) {
  if (a == null || b == null) return false;
  switch (NYC_FIELD_KIND[field]) {
    case 'date': return String(a).slice(0, 10) === String(b).slice(0, 10);
    // venue-write-guard-ok: read-only comparison of two venue strings, nothing is written
    case 'venue': return compareNycVenue(a, b) !== 'disagree';
    case 'tier': return foldTier(a) === foldTier(b);
    case 'type': return foldType(a) === foldType(b);
    case 'revival': return foldRevival(a, show.category) === foldRevival(b, show.category);
    default: return false;
  }
}

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) { return null; } };

/**
 * Settle a disputed field (no Playbill page) from the checkers' own cited
 * pages, using the support flag the check step recorded (the fetched page
 * states the value). Wrong: both checkers disagree with the row, agree with
 * each other, and pages on two different sites state that value. Correct: a
 * page states the stored value and the contrary answer has no page behind it.
 * Anything else stays pending. A page can state a date for another reason (an
 * announcement dated the day it ran), so these verdicts count in the error
 * table but never feed a row correction: that needs Playbill.
 */
function pagesVerdict(field, show, detail) {
  const d = (detail || []).filter((x) => x.cmp === 'agree' || x.cmp === 'disagree');
  if (d.length !== 2) return null;
  const [a, b] = d;
  if (a.cmp === 'disagree' && b.cmp === 'disagree') {
    const ha = hostOf(a.source); const hb = hostOf(b.source);
    // Two pages agreeing against the row often describe another production of the same title
    // (a transfer, the original house of a long run: Liberation, The Lion King in the full run).
    // So venue and tier never auto-rule wrong, and a date only when it is within a month of the row.
    if (field === 'theatre' || field === 'tier' || field === 'otherRuns') return null;
    if (NYC_FIELD_KIND[field] === 'date') {
      const gap = Math.abs(Date.parse(a.value) - Date.parse(nycStoredValue(show, field))) / 864e5;
      if (!(gap <= 31)) return null;
    }
    if (a.supported && b.supported && ha && hb && ha !== hb && sameNycAnswer(field, show, a.value, b.value)) {
      return { verdict: 'wrong', correctValue: a.value, url: a.source, note: `both checkers, pages on ${ha} and ${hb} state ${a.value}` };
    }
    return null;
  }
  const agree = a.cmp === 'agree' ? a : b;
  const other = a.cmp === 'agree' ? b : a;
  if (agree.supported && !other.supported) return { verdict: 'correct', correctValue: null, url: agree.source, note: `page states the stored value; ${other.checker} answer ${other.value} has no page behind it` };
  return null;
}

module.exports = {
  NYC_SINCE, NYC_FIELDS, NYC_FIELD_KIND, NYC_COHORT,
  isNycFactsRow, nycStratum, buildNycFactPrompt, nycStoredValue, nycCompareField, nycPageSupports,
  compareNycVenue, foldTier, foldType, foldRevival, otherRunsTriage, consistencyFindings, playbillVerdict, pagesVerdict, sameNycAnswer,
  isPinnedField, buildPlaybillFixActions, PLAYBILL_MAX_DATE_GAP_DAYS,
};
