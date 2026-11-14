'use strict';
// venue-write-guard-ok: venue here is a name from the curated OWE_GUARDIAN_HOUSES table below, staged as a candidate; the shows.json write goes through buildOffWestEndVenueShowEntry -> sanitizeVenueForWrite.
/**
 * West End Guardian reviews -> Off-West End staging (BRO-5171).
 *
 * THE GAP: audit-reverse-discovery.js reports Guardian critic reviews of
 * London productions missing from shows.json (market 'west-end'), but no
 * promoter read them back, so each one sat on the "reviewed shows missing
 * from the site" health row until someone added it by hand (De Profundis at
 * the Coronet and End of the World and Hard-Boiled Wonderland at the
 * Barbican, BRO-4689). The UK-regional twin is stageUkRegionalCandidates
 * (lib/uk-regional-guardian.js).
 *
 * The rows staged here go through promote-owe-venue-candidates.js's existing
 * review-evidence path (S8-T3): the Guardian URL is the evidence, fetched
 * and checked to name the title before anything is written.
 *
 * Rules (BRO-4689 /second-opinion):
 *   1. Venue from a curated table only (OWE_GUARDIAN_HOUSES: the dated
 *      OWE_VENUE_CONFIGS readers plus the Off-West End houses that have
 *      none), matched on the Guardian URL slug AFTER "-review-". Catalogue
 *      venue names are never fuzzy-matched. National Theatre, Royal Court and
 *      Old Vic are filed 'west-end' in shows.json, and this promoter only
 *      writes 'off-west-end', so they are deliberately absent.
 *   2. Dated: openingDate is the review's publish date (Europe/London), a
 *      date the review page carries; press night was on or before it, so its
 *      source 'guardian-review' is overwritable (date-source-confidence.js).
 *      The closing date comes from the review's own "At the X, London, until
 *      7 October" line, read when the promoter fetches the page.
 *   3. Tombstone: a Guardian URL the promoter already dropped from staging
 *      (its prune lines in data/audit/owe-promotion-log.jsonl carry
 *      sourceUrl) is never staged again.
 *   4. Dedupe against every west-end / off-west-end row, closed included,
 *      by house + title + run dates (isSameProduction, shared with the
 *      regional stager).
 *
 * Pure (no I/O) per CLAUDE.md §15.
 */

const { OWE_VENUE_CONFIGS } = require('./venue-listing-discover');
const { normalizeVenueName } = require('./venue-classification');
const { foldDiacritics } = require('./title-match');
const { findSameProduction } = require('./uk-regional-guardian');
const { candidateHash } = require('./owe-venue-staging');

const slugify = (s) => foldDiacritics(String(s || ''))
  .toLowerCase()
  .replace(/[‘’']/g, '')
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '');

// Off-West End houses with no dated reader, as shows.json spells them
// (`names`), and the extra slug phrases the Guardian uses for them.
const EXTRA_OWE_HOUSES = [
  { venue: 'Barbican Theatre', names: ['Barbican Centre'], slugs: ['barbican'] },
  { venue: 'Coronet Theatre', names: ['The Coronet Theatre'], slugs: ['coronet'] },
  { venue: 'Donmar Warehouse', slugs: ['donmar'] },
  { venue: 'Charing Cross Theatre' },
  { venue: 'Marylebone Theatre' },
  { venue: 'Soho Theatre', names: ['Soho Theatre Upstairs'] },
  { venue: 'Soho Theatre Walthamstow' },
  { venue: 'Jermyn Street Theatre' },
  { venue: 'Sam Wanamaker Playhouse', inside: "Shakespeare's Globe" },
  { venue: "Shakespeare's Globe", names: ['Globe Theatre'], slugs: ['shakespeares-globe', 'globe-theatre-london'] },
  { venue: 'The Other Palace', names: ['The Other Palace - Main Theatre', 'The Other Palace - Studio'] },
  { venue: 'The Yard Theatre', slugs: ['yard-theatre'] },
  { venue: 'Theatre503' },
  { venue: 'Gate Theatre' },
  { venue: 'Omnibus Theatre' },
  { venue: 'White Bear Theatre' },
  { venue: 'The Cockpit', slugs: ['cockpit-theatre'] },
  { venue: 'Battersea Arts Centre' },
];

// Shorter phrases the Guardian slugs use for houses that have a reader.
const READER_SLUG_ALIASES = {
  'Kiln Theatre': ['kiln'],
  'Almeida Theatre': ['almeida'],
  'Menier Chocolate Factory': ['menier'],
  'Orange Tree Theatre': ['orange-tree'],
  'Arcola Theatre': ['arcola'],
  'Finborough Theatre': ['finborough'],
  'New Diorama Theatre': ['new-diorama'],
  "Wilton's Music Hall": ['wiltons'],
  'Theatre Royal Stratford East': ['stratford-east'],
  'Rose Theatre Kingston': ['rose-theatre-kingston', 'rose-kingston'],
  'Young Vic': ['young-vic'],
  'Riverside Studios': ['riverside-studios'],
};

const stripThe = (s) => String(s).replace(/^the-/, '');

/**
 * [{venue, names: [catalogue spellings], slugs: [slug phrases]}]. Built once
 * from OWE_VENUE_CONFIGS + EXTRA_OWE_HOUSES; adding a house is one entry in
 * EXTRA_OWE_HOUSES (or a new dated reader).
 */
const OWE_GUARDIAN_HOUSES = [
  ...OWE_VENUE_CONFIGS.map((c) => ({
    venue: c.name,
    names: [c.name, ...(c.coversVenues || []), ...(c.coverageExact || [])],
    slugs: [stripThe(slugify(c.name)), ...(READER_SLUG_ALIASES[c.name] || [])],
  })),
  ...EXTRA_OWE_HOUSES.map((h) => ({
    venue: h.venue,
    inside: h.inside || null,
    names: [h.venue, ...(h.names || [])],
    slugs: [stripThe(slugify(h.venue)), ...(h.slugs || [])],
  })),
];

const HOUSE_BY_NAME = new Map();
for (const h of OWE_GUARDIAN_HOUSES) {
  for (const n of h.names) {
    const k = normalizeVenueName(n);
    if (k && !HOUSE_BY_NAME.has(k)) HOUSE_BY_NAME.set(k, h);
  }
}

/** The curated house a venue string (staged row or shows.json row) names, by normalizeVenueName equality. */
function oweHouseOf(venue) {
  const k = normalizeVenueName(venue);
  return k ? HOUSE_BY_NAME.get(k) : undefined;
}

/**
 * The slug words after "-review-" in a Guardian review URL: the standfirst,
 * which names the venue ("de-profundis-review-oscar-wilde-coronet-theatre-
 * london"). The slugified title prefix is skipped first, so a title holding
 * the word "review" does not cut the slug early.
 */
function guardianSlugTail(url, title) {
  let last;
  try {
    last = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
  } catch { return ''; }
  last = last.toLowerCase();
  const prefix = slugify(title);
  if (prefix && last.startsWith(`${prefix}-review-`)) return last.slice(prefix.length + '-review-'.length);
  const i = last.lastIndexOf('-review-');
  return i >= 0 ? last.slice(i + '-review-'.length) : '';
}

/**
 * Which curated Off-West End house a Guardian review URL names, or null when
 * it names none or more than one. Whole slug-phrase matches only.
 */
function oweHouseFromGuardianUrl(url, title) {
  const tail = guardianSlugTail(url, title);
  if (!tail) return null;
  const padded = `-${tail}-`;
  const pairs = [];
  for (const h of OWE_GUARDIAN_HOUSES) {
    for (const s of h.slugs) if (s && padded.includes(`-${s}-`)) pairs.push({ h, s });
  }
  // A phrase inside a longer matched phrase is not a second venue:
  // "soho-theatre-walthamstow" is not also "soho-theatre".
  const kept = new Set(pairs
    .filter((p) => !pairs.some((o) => o.s !== p.s && `-${o.s}-`.includes(`-${p.s}-`)))
    .map((p) => p.h));
  // A room inside a named house wins over the house ("...-sam-wanamaker-
  // playhouse-shakespeares-globe-london" is the Wanamaker).
  for (const h of [...kept]) if (h.inside) for (const o of [...kept]) if (o.venue === h.inside) kept.delete(o);
  return kept.size === 1 ? [...kept][0] : null;
}

/** YYYY-MM-DD of an ISO timestamp in London time (the Guardian's own zone). */
function londonDate(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const RUN_END_RE = new RegExp(`\\bat\\s+(?:the\\s+)?[^.]{2,120}?\\buntil\\s+(\\d{1,2})\\s+(${MONTHS.join('|')})(?:\\s+(\\d{4}))?\\b`, 'gi');

/**
 * The closing date a Guardian review states in its "At the Coronet theatre,
 * London, until 7 October" line, or null. A yearless date takes the publish
 * year, and the next year only when that would put it more than 60 days
 * before publication (a December review "until 10 January"). An end before
 * the publish date (a review of a run already over) gives null.
 */
function guardianRunEndDate(pageText, publishedIso) {
  // The London run line closes the review; an earlier "at the Traverse until
  // 25 August" is a previous run, so the last match wins.
  const all = [...String(pageText || '').matchAll(RUN_END_RE)];
  const m = all.length ? all[all.length - 1] : null;
  const published = londonDate(publishedIso);
  if (!m || !published) return null;
  const day = Number(m[1]);
  const month = MONTHS.indexOf(m[2].toLowerCase());
  let year = m[3] ? Number(m[3]) : Number(published.slice(0, 4));
  const iso = (y) => `${y}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const valid = (s) => { const d = new Date(`${s}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.getUTCDate() === day; };
  if (!m[3] && Date.parse(iso(year)) < Date.parse(published) - 60 * 86400000) year += 1;
  if (!valid(iso(year))) return null;
  // The row opens on the publish date, so an earlier end would make it
  // closed-before-open: no usable date rather than a wrong one.
  return iso(year) >= published ? iso(year) : null;
}

// Promotion-log kinds that mean "dropped from staging" (evaluateCandidates'
// prune()). 'promote' is not one: a promoted show is caught by the dedupe.
const PRUNE_KINDS = new Set(['skip-duplicate', 'skip-retired', 'skip-unconfirmed', 'skip-invalid-venue', 'skip-id-collision']);

/**
 * Guardian URLs the promoter dropped from staging, from the promotion log's
 * lines (parsed objects or raw JSONL strings). Only lines the promoter marked
 * `pruned: true` count, so a hold never tombstones a row.
 */
function guardianTombstones(logLines) {
  const out = new Set();
  for (const raw of logLines || []) {
    let e = raw;
    if (typeof raw === 'string') {
      if (!raw.includes('guardian-review')) continue;
      try { e = JSON.parse(raw); } catch { continue; }
    }
    if (e && e.source === 'guardian-review' && e.pruned === true && PRUNE_KINDS.has(e.kind) && typeof e.sourceUrl === 'string') out.add(e.sourceUrl);
  }
  return out;
}

/**
 * The London catalogue row that is the same production as a Guardian row
 * (same curated house, same title, review date inside the row's run), or
 * null. Any status counts, so a closed run dedupes; a revival does not.
 */
function findCataloguedOweProduction(row, shows) {
  const london = (shows || []).filter((s) => s && (s.category === 'west-end' || s.category === 'off-west-end'));
  return findSameProduction({ title: row.title, venue: row.venue, date: row.openingDate || row.articlePublishedAt }, london, { houseOf: oweHouseOf }) || null;
}

/**
 * Staging rows for the West End Guardian reviews reverse discovery found
 * missing. Same row shape as a --stage-file evidence row.
 *
 * @param {Array<{title, url, date, market, source}>} candidates data/audit/reverse-discovery-candidates.json `candidates`
 * @param {object} ctx
 * @param {Array<object>} ctx.shows shows.json rows (any category; west-end / off-west-end are used)
 * @param {Set<string>} [ctx.tombstones] from guardianTombstones()
 * @param {Array<object>} [ctx.staged] current staging rows (their candidateHash is skipped)
 * @returns {{rows: object[], skipped: Array<{title, url, reason}>}}
 */
function stageOweGuardianCandidates(candidates, ctx = {}) {
  const tombstones = ctx.tombstones instanceof Set ? ctx.tombstones : new Set();
  const london = (ctx.shows || []).filter((s) => s && (s.category === 'west-end' || s.category === 'off-west-end'));
  const stagedHashes = new Set((ctx.staged || []).map((c) => c && (c.candidateHash || candidateHash(c))).filter(Boolean));
  const rows = [];
  const skipped = [];
  for (const c of candidates || []) {
    if (!c || c.market !== 'west-end' || c.source !== 'guardian-review') continue;
    if (!c.title || !c.url) continue;
    const skip = (reason) => skipped.push({ title: c.title, url: c.url, reason });
    if (tombstones.has(c.url)) { skip('tombstoned: already dropped from staging by the promoter'); continue; }
    const house = oweHouseFromGuardianUrl(c.url, c.title);
    if (!house) { skip('review URL names no curated Off-West End house (or more than one)'); continue; }
    const openingDate = londonDate(c.date);
    if (!openingDate) { skip('no review publish date'); continue; }
    const row = {
      title: c.title,
      venue: house.venue,
      category: 'off-west-end',
      source: 'guardian-review',
      discoverySource: 'guardian-review',
      sourceUrl: c.url,
      articlePublishedAt: c.date,
      openingDate,
      openingDateSource: 'guardian-review',
      evidence: [{ kind: 'review-url', url: c.url, outletId: 'guardian' }],
      provisional: true,
    };
    const have = findCataloguedOweProduction(row, london);
    if (have) { skip(`already in shows.json as ${have.id}`); continue; }
    const h = candidateHash(row);
    if (stagedHashes.has(h)) { skip('already staged'); continue; }
    stagedHashes.add(h);
    rows.push(row);
  }
  return { rows, skipped };
}

module.exports = {
  OWE_GUARDIAN_HOUSES,
  oweHouseOf,
  guardianSlugTail,
  oweHouseFromGuardianUrl,
  londonDate,
  guardianRunEndDate,
  guardianTombstones,
  findCataloguedOweProduction,
  stageOweGuardianCandidates,
};
