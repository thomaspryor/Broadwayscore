'use strict';

/**
 * BRO-7683: a BroadwayWorld local review of a production the hub does not have -> an add-show action.
 * scripts/bww-regional-add-plan.js fetches the review and asks Gemini what it reviewed; everything here is pure:
 * the prompt, the check that every fact the model returns is printed in the review, and the shows.json row.
 *
 * Only professional productions are added (the hubs carry what Theatre-In-X and the theatres' own seasons list);
 * community, school and touring productions and non-theatre events are declined and recorded, so the coverage
 * audit stops reporting them.
 */

const { normalizeTitle } = require('./title-match');
const { displayTitle } = require('./bww-local-reviews');
const { resolveMetroInfo, norm } = require('./venue-metro');
const { sanitizeVenueForWrite } = require('./venue-classification');
const S = require('./city-season');

const MAX_RUN_DAYS = 150;
// A run with no closing date that started this long ago is treated as closed (regional runs are weeks long;
// scripts/lib/tic-stage.js does the same at 120 days for Theatre-In-Chicago listings).
const OPEN_ENDED_DAYS = 60;
const KINDS = ['professional', 'community', 'school', 'touring', 'not-theatre'];
const TYPES = ['play', 'musical', 'opera'];
const STATES = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '));

function buildPrompt({ headline, text, reviewDate }) {
  return `Below is a BroadwayWorld theatre review published ${reviewDate}. Headline: "${headline}".
Say what production it reviews. Use only what the text says; never guess.
- "title": the show's title in normal capitalisation, without the company name or a subtitle the headline adds.
- "kind": "professional" (a professional or semi-professional theatre or opera company's own production, including Equity and non-Equity companies),
  "community" (community or amateur theatre), "school" (a university, college, high-school or youth production), "touring" (a national or international tour stop or a touring company),
  or "not-theatre" (concert, cabaret act, solo music evening, dance, ballet, magic, comedy, circus, immersive game).
- "type": "play", "musical" or "opera".
- "theatre": the building or stage it plays at, as the text names it (e.g. "Kennedy Center Opera House", "Theater Wit"). If only the company is named, the company.
- "company": the producing company, or null.
- "town": the town or city the theatre is in: as the text names it, else for a well-known venue its town, else null. "state": the two-letter US state code, only if the text or a well-known venue makes it certain (else null).
- "firstPerformance", "openingDate", "closingDate": "YYYY-MM-DD" when the text gives that date (year from the review date; a run is rarely over 4 months), else null.
Return JSON: {"title":string,"kind":string,"type":string,"theatre":string|null,"company":string|null,"town":string|null,"state":string|null,"firstPerformance":string|null,"openingDate":string|null,"closingDate":string|null}

REVIEW TEXT:
${String(text || '').slice(0, 20000)}`;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const FULL = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const isIso = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && !Number.isNaN(Date.parse(d));
/** The text prints this date's month next to its day number ("Nov 16", "November 16th", "16 November"). */
function datePrinted(text, iso) {
  if (!isIso(iso)) return false;
  const i = Number(iso.slice(5, 7)) - 1;
  const day = Number(iso.slice(8, 10));
  const m = `(?:${MONTHS[i]}\\.?|${FULL[i]})`;
  return new RegExp(`\\b${m}\\s*${day}(?:st|nd|rd|th)?\\b|\\b${day}(?:st|nd|rd|th)?\\s*(?:of\\s+)?${m}\\b`, 'i').test(text) || text.includes(iso)
    || new RegExp(`\\b${i + 1}/${day}(?:/\\d{2,4})?\\b`).test(text);
}

const words = (s) => normalizeTitle(s).split(' ').filter(Boolean);

/**
 * Check the model's reading against the review text. Returns { ok, reason?, facts } where facts keeps only
 * what the text supports (an unsupported date becomes null; an unsupported title or theatre fails).
 */
function checkReading(reading, { text, today, headline }) {
  const r = reading || {};
  const t = ` ${norm(text)} `;
  if (!KINDS.includes(r.kind)) return { ok: false, reason: `unknown kind "${r.kind}"` };
  const title = String(r.title || '').trim();
  if (!title) return { ok: false, reason: 'no title' };
  // Every word of the title (accents, case and punctuation aside) must be in the text.
  if (!words(title).every((w) => t.includes(` ${w} `) || t.includes(` ${w}`))) return { ok: false, reason: `title "${title}" not in the text` };
  // The model must have read the production the headline names, not another show the page mentions.
  if (headline) {
    const h = ` ${norm(headline)} `;
    if (!words(title).every((w) => h.includes(` ${w} `))) return { ok: false, reason: `read "${title}", the headline is "${headline}"` };
  }
  const facts = { ...r, title, type: TYPES.includes(r.type) ? r.type : null };
  if (r.kind !== 'professional') return { ok: true, facts };
  const theatre = String(r.theatre || r.company || '').trim();
  if (!theatre) return { ok: false, reason: 'no theatre named' };
  if (!words(theatre).filter((w) => w.length > 2).every((w) => t.includes(` ${w}`))) return { ok: false, reason: `theatre "${theatre}" not in the text` };
  facts.theatre = theatre;
  facts.town = r.town && t.includes(` ${norm(r.town)} `) ? String(r.town).trim() : null;
  // The model's town for a venue the text names without one (placeFor uses it only when it lands in the hub's metro).
  facts.modelTown = r.town ? String(r.town).trim() : null;
  facts.state = r.state && STATES.has(String(r.state).toUpperCase()) ? String(r.state).toUpperCase() : null;
  for (const k of ['firstPerformance', 'openingDate', 'closingDate']) facts[k] = isIso(r[k]) && datePrinted(text, r[k]) ? r[k] : null;
  if (facts.closingDate && facts.openingDate && facts.closingDate < facts.openingDate) facts.closingDate = null;
  facts.today = today;
  return { ok: true, facts };
}

/**
 * The town and state for a venue: the review's own, else the hub's home city when the venue already appears in a
 * shows.json row of that hub (same house), else null (the row is held, never guessed).
 */
function placeFor(facts, { hubSlug, hubShows, hubHome }) {
  if (facts.town && facts.state) return { town: facts.town, state: facts.state };
  const th = norm(facts.theatre).replace(/^the /, '');
  const known = hubShows.find((s) => norm(String(s.venue || '').split(',')[0]).replace(/^the /, '') === th);
  if (known) {
    const parts = String(known.venue).split(',').map((p) => p.trim());
    if (parts.length >= 3) return { town: parts[parts.length - 2], state: parts[parts.length - 1] };
  }
  if (facts.town && hubHome && norm(facts.town) === norm(hubHome.town)) return hubHome;
  if (!facts.town && facts.state === 'DC') return { town: 'Washington', state: 'DC' };
  // A well-known venue the review names without its town ("Folger Shakespeare Library", "Merrimack Repertory
  // Theatre"): the model's town is kept only when that venue resolves into this hub's metro, so a wrong guess
  // cannot file a show under another city.
  const town = facts.town || facts.modelTown;
  const state = facts.state || (hubHome && town && norm(town) === norm(hubHome.town) ? hubHome.state : null);
  if (town && state) {
    const m = resolveMetroInfo(`${facts.theatre}, ${town}, ${state}`);
    if (m && m.slug === hubSlug) return { town, state };
  }
  return null;
}

/**
 * The shows.json row for a checked professional reading. ctx: { review, hubSlug, hubShows, hubHome, taken, today }.
 * Returns { show } or { hold: reason }.
 */
function buildShow(facts, ctx) {
  const { review, hubSlug, hubShows = [], hubHome, taken, today } = ctx;
  const place = placeFor(facts, { hubSlug, hubShows, hubHome });
  if (!place) return { hold: `no town for "${facts.theatre}"` };
  const venue = sanitizeVenueForWrite(`${facts.theatre}, ${place.town}, ${place.state}`);
  if (!venue) return { hold: `placeholder venue "${facts.theatre}"` };
  const metro = resolveMetroInfo(venue);
  const start = facts.openingDate || facts.firstPerformance || review.date;
  // Leading articles make poor id words ("A Red Orchid" -> "-a-").
  const id = S.showId({ title: facts.title, theatre: String(facts.theatre).replace(/^(a|an|the)\s+/i, ''), start }, taken);
  if (!id) return { hold: 'id taken twice' };
  // A closing date before the run starts (the start fell back to the review date) or a run longer than five months
  // (the model joined two seasons) is not this run's closing: leave it for the closing-date jobs.
  let end = facts.closingDate;
  if (end && (end < start || Date.parse(end) - Date.parse(start) > MAX_RUN_DAYS * 86400000)) end = null;
  const stale = !end && Date.parse(today) - Date.parse(start) > OPEN_ENDED_DAYS * 86400000;
  const status = (end && end < today) || stale ? 'closed' : start > today ? 'previews' : 'open';
  const show = {
    id, title: displayTitle(facts.title), slug: id, venue, status,
    type: facts.type || (/\bmusical\b/i.test(facts.title) ? 'musical' : 'play'),
    category: 'regional', market: 'regional',
    openingDate: start,
    openingDateSource: facts.openingDate ? 'bww-review-text' : facts.firstPerformance ? 'bww-review-text:first-performance' : 'bww-first-review',
    ...(facts.firstPerformance && facts.firstPerformance < start ? { previewsStartDate: facts.firstPerformance } : {}),
    ...(end ? { closingDate: end, closingDateSource: 'bww-review-text' } : {}),
    discoverySource: 'bww-local-reviews',
    ...(metro && metro.hub ? { localOnly: true } : {}),
    city: (metro && metro.slug) || hubSlug,
    discoveredAt: today,
    evidenceUrls: [review.url],
  };
  return { show };
}

/**
 * The hub row this production already has: same title and year, and the row's venue names the theatre OR the
 * producing company (a company playing a second stage, e.g. American Repertory Theater at Farkas Hall).
 */
function existingRow(facts, show, shows) {
  const row = { title: show.title, start: show.openingDate, end: show.closingDate || show.openingDate };
  for (const th of [facts.theatre, facts.company]) {
    if (!th) continue;
    const hit = S.findExisting({ ...row, theatre: th }, shows);
    if (hit) return hit;
  }
  return null;
}

module.exports = { buildPrompt, checkReading, datePrinted, placeFor, buildShow, existingRow, KINDS, MAX_RUN_DAYS, OPEN_ENDED_DAYS };
