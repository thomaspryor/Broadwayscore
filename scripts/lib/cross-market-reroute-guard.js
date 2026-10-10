'use strict';
// venue-write-guard-ok: the evidence object records which venue markers the review text named for the reroute verdict; it never writes a venue into shows.json (the reroute only moves a review file).

/**
 * Cross-market reroute guard — BRO-4204 2026 data audit, sprint task S6-T2.
 *
 * migrate-reroute-backlog.js --cross-market moves a wrongProduction-flagged
 * review file to a same-title sibling in the OTHER market when the review's
 * publish year sits closest to that sibling's opening year. Year proximity is
 * not evidence about WHICH production a critic saw: 37 London reviews of the
 * 2026 Harold Pinter Theatre "Romeo and Juliet" (Robert Icke), the Globe
 * "Much Ado", the Old Vic "Christmas Carol", etc. were relayed by Theatre
 * Record with no outlet URL, filed under the 1977/1984/1994 Broadway
 * revivals by the date guard, then "rescued" onto the 2026 NYC productions
 * (Delacorte, Winter Garden, PAC NYC) because the years matched — and
 * force-included there by the blanket wrongProductionOverride stamp the
 * migration wrote (revoked by audit S1-T1).
 *
 * This module is the pure decision the migration must consult before any
 * cross-market move. A reroute is allowed only when ALL hold:
 *
 *   1. The file carries an outlet URL whose host belongs to a DUAL-MARKET
 *      outlet (outlet-registry `isDualMarket: true` — Variety, NYT, Guardian,
 *      The Stage, ...). A single-market London outlet does not review
 *      Broadway, and a file with no URL at all (a Theatre Record / roundup
 *      relay) has no outlet identity to verify.
 *   2. The review text — or its contentVerification verdict — NAMES the
 *      target production: its venue ("the Delacorte") or its director
 *      ("Saheem Ali"). Naming a DIFFERENT same-title production's venue or
 *      director instead ("Harold Pinter Theatre", "Robert Icke") is a skip.
 *
 * A human breadcrumb `crossMarketRerouteApproved: true` on the file bypasses
 * both checks (someone read the review).
 *
 * The decision NEVER grants wrongProductionOverride: `stampOverride` is
 * always false. A reroute may leave `reroutedFrom` / `reroutedAt`
 * breadcrumbs on the moved file and nothing else — the target's own guards
 * still run against the moved review.
 *
 * Pure: no fs, no process. The caller supplies the parsed outlet registry.
 * Tested by scripts/lib/cross-market-reroute-guard.test.mjs with the real
 * Romeo and Juliet shape (CLAUDE.md §15 — the test require()s this function).
 */

const { extractHost, hostMatchesDomain, getOutletDomains } = require('./outlet-domain-validation');

// Review-file fields that hold review prose. `wrongFullText` is where the
// wrong-production detector parks the body it rejected — still the critic's
// words, and the whole point here is to read them.
const TEXT_FIELDS = [
  'fullText', 'wrongFullText', 'headline', 'subhead',
  'bwwExcerpt', 'dtliExcerpt', 'showScoreExcerpt', 'nycTheatreExcerpt',
  'lboRoundupExcerpt', 'westEndTheatreExcerpt', 'llmPullQuote',
];

// Trailing venue tokens that carry no identity ("Delacorte Theater" →
// "Delacorte"). Stripped one at a time from the END only.
const STRIP_TRAILING = new Set([
  'theatre', 'theater', 'playhouse', 'hall', 'house', 'centre', 'center',
  'arts', 'performing', 'space', 'stage', 'complex', 'auditorium',
]);

// Single-word stems too generic to identify a venue on their own. The full
// venue string still matches ("Public Theater"), the bare stem does not.
const GENERIC_STEMS = new Set([
  'public', 'national', 'royal', 'metropolitan', 'american', 'british',
  'london', 'york', 'city', 'civic', 'community', 'little', 'new', 'old',
  'grand', 'main', 'downtown', 'uptown', 'east', 'west', 'north', 'south',
  'central', 'park', 'garden', 'gardens', 'square', 'circle', 'lyric',
  'palace', 'apollo', 'globe', 'studio', 'festival', 'summer', 'winter',
  'shakespeare', 'company', 'players', 'repertory', 'ensemble', 'opera',
]);

const DIRECTOR_ROLE = /director|direction|directed/i;
const NOT_A_STAGE_DIRECTOR = /music|musical|choreo|assistant|associate|casting|technical|production|fight|intimacy|movement|resident|artistic|stage|company|puppet|video|sound|lighting|dialect|voice|projection|design/i;

function normalizeText(s) {
  return String(s == null ? '' : s)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/\btheatre\b/g, 'theater')
    .replace(/[^a-z0-9'&]+/g, ' ')
    .trim();
}

function collectStrings(value, out) {
  if (value == null) return out;
  if (typeof value === 'string') { out.push(value); return out; }
  if (Array.isArray(value)) { for (const v of value) collectStrings(v, out); return out; }
  if (typeof value === 'object') { for (const v of Object.values(value)) collectStrings(v, out); return out; }
  return out;
}

/** Everything the guard is allowed to read as "the review's words". */
function evidenceTextOf(file) {
  const parts = [];
  for (const f of TEXT_FIELDS) if (file && typeof file[f] === 'string') parts.push(file[f]);
  if (file && file.contentVerification) collectStrings(file.contentVerification, parts);
  return normalizeText(parts.join(' \n '));
}

/**
 * Venue marker variants for one show: each slash/paren-separated venue part in
 * full, plus its distinctive stem (trailing generic tokens stripped) when the
 * stem is still identifying (≥2 tokens, or one token ≥6 chars that isn't a
 * generic word).
 */
function venueMarkers(venue) {
  const markers = [];
  if (!venue) return markers;
  const parts = String(venue).split(/\s*(?:\/|\||;|\(|\))\s*/).map(p => p.trim()).filter(Boolean);
  for (const part of parts) {
    let tokens = normalizeText(part).split(' ').filter(Boolean);
    if (tokens[0] === 'the') tokens = tokens.slice(1);
    if (tokens.length === 0) continue;
    const full = tokens.join(' ');
    if (full.length >= 4) markers.push(full);
    let stem = tokens.slice();
    while (stem.length > 1 && STRIP_TRAILING.has(stem[stem.length - 1])) stem = stem.slice(0, -1);
    const stemStr = stem.join(' ');
    if (stemStr !== full) {
      const identifying = stem.length >= 2
        || (stem.length === 1 && stem[0].length >= 6 && !GENERIC_STEMS.has(stem[0]));
      if (identifying) markers.push(stemStr);
    }
  }
  return [...new Set(markers)];
}

function directorNames(show) {
  const names = [];
  if (!show) return names;
  if (typeof show.director === 'string' && show.director.trim()) names.push(show.director.trim());
  for (const m of Array.isArray(show.creativeTeam) ? show.creativeTeam : []) {
    if (!m || typeof m.name !== 'string' || typeof m.role !== 'string') continue;
    if (!DIRECTOR_ROLE.test(m.role) || NOT_A_STAGE_DIRECTOR.test(m.role)) continue;
    names.push(m.name.trim());
  }
  return [...new Set(names.filter(Boolean))];
}

/** { venue: [...], director: [...] } normalized marker strings for a show. */
function productionMarkers(show) {
  return {
    venue: venueMarkers(show && show.venue),
    director: directorNames(show).map(normalizeText).filter(n => n.split(' ').length >= 2),
  };
}

function findMarkers(text, markers) {
  const hits = [];
  if (!text) return hits;
  for (const kind of ['venue', 'director']) {
    for (const m of markers[kind]) {
      if (m && text.includes(m)) hits.push({ kind, marker: m });
    }
  }
  return hits;
}

const _dualMarketCache = new WeakMap();
/** [{ id, domains: [...] }] for every isDualMarket outlet in the registry. */
function dualMarketOutlets(outletRegistry) {
  if (!outletRegistry || typeof outletRegistry !== 'object') return [];
  const cached = _dualMarketCache.get(outletRegistry);
  if (cached) return cached;
  const outlets = outletRegistry.outlets && typeof outletRegistry.outlets === 'object'
    ? outletRegistry.outlets : outletRegistry;
  const list = [];
  for (const [id, entry] of Object.entries(outlets)) {
    if (!entry || entry.isDualMarket !== true) continue;
    const domains = getOutletDomains(entry);
    if (domains.length > 0) list.push({ id, domains });
  }
  _dualMarketCache.set(outletRegistry, list);
  return list;
}

/** The dual-market outlet id whose registered domain owns `host`, or null. */
function dualMarketOutletForHost(host, outletRegistry) {
  if (!host) return null;
  for (const { id, domains } of dualMarketOutlets(outletRegistry)) {
    if (domains.some(d => hostMatchesDomain(host, d))) return id;
  }
  return null;
}

/**
 * Decide whether a flagged review file may be rerouted across markets onto
 * `candidateShow`.
 *
 * @param {object} args
 * @param {object} args.file           parsed review-text JSON
 * @param {object} args.candidateShow  shows.json record of the proposed target
 * @param {object} [args.sourceShow]   shows.json record the file currently sits under
 * @param {object} [args.outletRegistry] parsed data/outlet-registry.json ({outlets} or bare map)
 * @param {object[]} [args.siblings]   other same-title shows.json records (any market);
 *                                     naming one of THEM instead of the target is a skip
 * @returns {{ allow: boolean, reason: string, reasons: string[],
 *            evidence: object, stampOverride: false }}
 */
function decideCrossMarketReroute({ file, candidateShow, sourceShow, outletRegistry, siblings } = {}) {
  const evidence = { host: null, dualMarketOutletId: null, matched: [], otherProductionMatches: [] };
  const done = (allow, reasons) => ({
    allow, reasons, reason: reasons.join('; '), evidence, stampOverride: false,
  });

  if (!file || typeof file !== 'object') return done(false, ['no-file']);
  if (!candidateShow || !candidateShow.id) return done(false, ['no-candidate-show']);

  if (file.crossMarketRerouteApproved === true) return done(true, ['human-approved']);

  const reasons = [];

  // 1. Outlet identity: URL host must be a dual-market outlet's domain.
  const url = typeof file.url === 'string' ? file.url.trim() : '';
  if (!url) {
    reasons.push('no-url');
  } else {
    const host = extractHost(url);
    evidence.host = host;
    if (!host) {
      reasons.push('unparseable-url');
    } else {
      const outletId = dualMarketOutletForHost(host, outletRegistry);
      evidence.dualMarketOutletId = outletId;
      if (!outletId) reasons.push(`host-not-dual-market-outlet:${host}`);
    }
  }

  // 2. Content evidence: the review names the target production.
  const text = evidenceTextOf(file);
  const targetHits = findMarkers(text, productionMarkers(candidateShow));
  evidence.matched = targetHits;

  const others = [];
  if (sourceShow && sourceShow.id && sourceShow.id !== candidateShow.id) others.push(sourceShow);
  for (const s of Array.isArray(siblings) ? siblings : []) {
    if (s && s.id && s.id !== candidateShow.id && !others.some(o => o.id === s.id)) others.push(s);
  }
  for (const other of others) {
    const hits = findMarkers(text, productionMarkers(other));
    if (hits.length > 0) evidence.otherProductionMatches.push({ showId: other.id, hits });
  }

  if (targetHits.length === 0) {
    reasons.push('target-venue-or-director-not-named');
    for (const m of evidence.otherProductionMatches) reasons.push(`names-other-production:${m.showId}`);
  }

  return done(reasons.length === 0, reasons.length === 0 ? ['dual-market-url+target-named'] : reasons);
}

module.exports = {
  decideCrossMarketReroute,
  // Exposed for tests / other guards
  productionMarkers,
  venueMarkers,
  directorNames,
  evidenceTextOf,
  dualMarketOutletForHost,
  normalizeText,
};
