'use strict';
/**
 * BRO-7291 class 3 (wrong production): a city-hub regional show's review that is about the same title at a
 * DIFFERENT theatre. Real case: come-from-away-north-regional-2026 (North Shore Music Theatre, Beverly MA)
 * carried berkshireonstage.blog's review of the Sharon Playhouse (CT) production, which names Sharon
 * Playhouse eight times and North Shore never. Pure; no I/O.
 *
 * Fires only when the text (1) never names our venue or its town, (2) names one other theatre at least twice
 * and (3) places the production in another state ("Sharon, CT") while never naming ours. The state test is
 * what separates a different production from the usual company-vs-building naming (Impostors Theatre
 * performing at The Den Theatre, both in Chicago): a sweep of 6,662 hub reviews without it hit 33 such
 * same-city false positives.
 */
const STATES = { AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california', CO: 'colorado', CT: 'connecticut', DE: 'delaware', DC: 'district of columbia', FL: 'florida', GA: 'georgia', HI: 'hawaii', ID: 'idaho', IL: 'illinois', IN: 'indiana', IA: 'iowa', KS: 'kansas', KY: 'kentucky', LA: 'louisiana', ME: 'maine', MD: 'maryland', MA: 'massachusetts', MI: 'michigan', MN: 'minnesota', MS: 'mississippi', MO: 'missouri', MT: 'montana', NE: 'nebraska', NV: 'nevada', NH: 'new hampshire', NJ: 'new jersey', NM: 'new mexico', NY: 'new york', NC: 'north carolina', ND: 'north dakota', OH: 'ohio', OK: 'oklahoma', OR: 'oregon', PA: 'pennsylvania', RI: 'rhode island', SC: 'south carolina', SD: 'south dakota', TN: 'tennessee', TX: 'texas', UT: 'utah', VT: 'vermont', VA: 'virginia', WA: 'washington', WV: 'west virginia', WI: 'wisconsin', WY: 'wyoming' };
// "Sharon, CT" / "Sharon, Connecticut": a town, a comma, then a state.
const TOWN_STATE_RE = new RegExp(`\\b[A-Z][a-z]+(?:\\s+[A-Z][a-z]+)?,\\s+(${Object.keys(STATES).join('|')}|${Object.values(STATES).map((n) => n.replace(/(^|\s)\w/g, (c) => c.toUpperCase())).join('|')})\\b`, 'g');
const stateCode = (s) => (STATES[s] ? s : Object.keys(STATES).find((k) => STATES[k] === String(s).toLowerCase()) || null);
const VENUE_WORD = '(?:Playhouse|Theatre|Theater|Stage Company|Repertory(?: Theatre| Company)?|Rep|Opera House|Arts Center|Performing Arts Center)';
const OTHER_VENUE_RE = new RegExp(`((?:[A-Z][\\w'’.&-]*\\s+){1,4}${VENUE_WORD})\\b`, 'g');
// Licensing houses and generic phrases that look like venues but are on every regional program.
const NOT_A_VENUE = /^(?:the\s+)?(?:music theatre international|concord theatricals|theatrical rights worldwide|the broadway theatre|broadway theatre|musical theatre|community theatre|regional theatre|new york theatre|american theatre|national theatre)$/i;
const GENERIC = new Set(['the', 'theatre', 'theater', 'playhouse', 'stage', 'company', 'repertory', 'rep', 'center', 'centre', 'arts', 'performing', 'music', 'opera', 'house', 'of', 'at', 'and', 'a', 'in']);

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** `key` ("bramble loft") named in folded text, allowing up to two generic words between ("Bramble Arts Loft"). */
const namesKey = (hay, key) => new RegExp(`\\b${key.split(' ').map(esc).join("(?:[^a-z0-9']+[a-z0-9']+){0,2}?[^a-z0-9']+")}\\b`).test(hay);

/**
 * Ways the text can name our venue: the distinctive core ("North Shore Music Theatre" -> "north shore") and its
 * first two distinctive words ("Drury Lane- Oakbrook" -> "drury lane"). The town is not used: character names
 * collide with towns ("Beverly" is a Come From Away role).
 */
function ownVenueKeys(venue) {
  const keys = new Set();
  // "Victory Gardens Theater - Biograph": each dash-separated part names the venue on its own.
  for (const part of String(venue || '').split(',')[0].split(/\s+[-–—]\s+|-\s+/)) {
    const words = fold(part).split(/[^a-z0-9']+/).filter((w) => w && !GENERIC.has(w) && !/^(?:productions|ensemble|boston|chicago)$/.test(w));
    keys.add(words.join(' '));
    keys.add(words.slice(0, 2).join(' '));
  }
  return [...keys].filter((k) => k.length >= 4);
}

/** The other theatre most named in a text that never names ours: { key, venue, mentions } or null. */
function otherVenueNamed(text, url, show, minMentions) {
  const keys = ownVenueKeys(show.venue);
  if (!keys.length) return null;
  const hay = fold(`${text} ${String(url || '').replace(/[-_/]+/g, ' ')}`);
  if (keys.some((k) => namesKey(hay, k))) return null;
  const counts = new Map();
  for (const m of text.replace(/\s+/g, ' ').matchAll(OTHER_VENUE_RE)) {
    const name = m[1].replace(/^(?:The|At|And|In|By|Of)\s+/, '').trim();
    if (NOT_A_VENUE.test(name)) continue;
    const words = fold(name).split(/\s+/).filter((w) => !GENERIC.has(w));
    if (!words.length) continue;
    const k = words.join(' ');
    counts.set(k, { key: k, venue: name, mentions: ((counts.get(k) || {}).mentions || 0) + 1 });
  }
  const top = [...counts.values()].sort((a, b) => b.mentions - a.mentions)[0];
  return top && top.mentions >= minMentions ? top : null;
}

/**
 * @param {{ fullText?: string, url?: string }} review
 * @param {{ localOnly?: boolean, venue?: string }} show
 * @param {{ minMentions?: number }} [opts]
 * @returns {{ venue: string, mentions: number, state: string } | null}  the other theatre the review is about, or null
 */
function regionalVenueMismatch(review, show, opts = {}) {
  if (!show || !show.localOnly || !show.venue || !review) return null;
  const text = String(review.fullText || '').replace(/\s+/g, ' ');
  if (text.length < 400) return null;
  const own = stateCode(String(show.venue).split(',').pop().trim());
  if (!own) return null;
  const top = otherVenueNamed(text, review.url, show, opts.minMentions || 3);
  if (!top) return null;
  // The other theatre must be placed in another state in the same breath ("at the Sharon Playhouse, 44
  // Amenia Road in Sharon, CT"); a state named elsewhere (the play is set in Westport, CT) does not count.
  const states = new Set([...text.matchAll(TOWN_STATE_RE)].map((m) => stateCode(m[1])).filter(Boolean));
  if (states.has(own)) return null;
  const venueRe = new RegExp(top.venue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  for (const v of text.matchAll(venueRe)) {
    const near = text.slice(v.index, v.index + v[0].length + 150);
    const st = [...near.matchAll(TOWN_STATE_RE)].map((m) => stateCode(m[1])).find((c) => c && c !== own);
    if (st) return { venue: top.venue, mentions: top.mentions, state: st };
  }
  return null;
}

/**
 * Show-level twin (BRO-7291): when two or more outlets' reviews never name our venue and agree on the SAME
 * other theatre, the show record's venue is what is wrong (octet-regional-2026: stored "Goodman Theatre",
 * the Tribune and the Reader both review Raven Theatre's production). Returns { venue, outlets } or null.
 * @param {{ localOnly?: boolean, venue?: string }} show
 * @param {{ fullText?: string, url?: string, outletId?: string }[]} reviews  the show's unflagged reviews
 * @param {string[]} cityVenues  stored venues of the city's other shows. The other theatre must be one of them:
 *   reviews name the producing COMPANY (Theo Ubique, BrightSide) where we store the building, and only a
 *   theatre we already list as a venue is evidence that the building is wrong (25 of 31 raw hits were companies).
 */
function showVenueDisagreement(show, reviews, cityVenues = []) {
  if (!show || !show.localOnly || !show.venue) return null;
  if (/^(?:live online|online|virtual|streaming|various|tba|tbd)\b/i.test(show.venue)) return null; // placeholder, not a building
  const ours = ownVenueKeys(show.venue);
  // key -> the stored venue string it came from ("Raven Theatre, Chicago, IL"), so a fix writes the stored form
  const known = new Map();
  for (const v of cityVenues) if (v && v !== show.venue) for (const k of ownVenueKeys(v)) if (!known.has(k)) known.set(k, v);
  const by = new Map();
  let namesOurs = 0;
  for (const r of reviews || []) {
    const text = String(r.fullText || '').replace(/\s+/g, ' ');
    if (text.length < 400) continue;
    if (ours.some((k) => namesKey(fold(text), k))) { namesOurs++; continue; } // company + our building (TUTA at Bramble)
    const top = otherVenueNamed(text, r.url, show, 2);
    if (!top || !known.has(top.key)) continue;
    if (!by.has(top.key)) by.set(top.key, { venue: top.venue, stored: known.get(top.key), outlets: new Set() });
    by.get(top.key).outlets.add(r.outletId || r.url);
  }
  const best = [...by.values()].sort((a, b) => b.outlets.size - a.outlets.size)[0];
  if (!best || best.outlets.size < 2 || best.outlets.size <= namesOurs) return null;
  return { venue: best.venue, stored: best.stored, outlets: [...best.outlets] };
}

module.exports = { regionalVenueMismatch, showVenueDisagreement, ownVenueKeys };
