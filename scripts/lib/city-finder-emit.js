'use strict';
/**
 * BRO-8455: the decisions city-finder-stage.js `emit` makes about a staged production, as pure functions
 * (CLAUDE.md section 15). Fixes three silent drops/mis-types found in the San Diego + Boston audit:
 *  - non-professional companies (pro:false in city-finder-config) were emitted (OnStage, Scripps Ranch, OnWord, Sullivan Rep);
 *  - the review floor (3, or 2 when open) dropped real productions with 1-2 reviews without a trace;
 *  - the musical regex listed San Diego titles only, so Boston musicals were typed "play".
 */

/** One-night / short-run events that are not a staged production (a variety night, a reading, a benefit). */
const EVENT_TITLE_RE = /\b(ted talks?|variety (night|show)|open mic|cabaret night|gala|benefit (?:concert|performance|reading|night)|fundraiser|reading series|new play festival|showcase)\b/i;

const MUSICAL_RE = new RegExp(`\\b(?:${[
  'musical', 'rent(?!\\s+control)', 'hairspray', 'mean girls', 'cher show', 'rock of ages', 'guys and dolls', 'come from away',
  'evan hansen', 'seussical', 'spongebob', 'most happy fella', 'american rhythm', 'we will rock you', 'carrie',
  'charlie and the chocolate factory', 'something rotten', 'annie(?: jr)?(?!\\s+baker)', 'on your feet', 'joseph and the amazing technicolor dreamcoat',
  'merrily we roll along', 'frozen', 'jagged little pill', 'finding nemo', 'little shop of horrors', 'grease',
  'sweeney todd', 'into the woods', 'les mis[ée]rables', 'the music man', 'fiddler on the roof', 'matilda', 'newsies',
  'kinky boots', 'beauty and the beast', 'the little mermaid', 'the lion king', 'mamma mia', 'heathers', 'urinetown', 'falsettos',
  'bat boy', 'once on this island', 'the producers', 'spamalot', 'ragtime',
].join('|')})\\b`, 'i');

/** 'musical' or 'play' for a production title. */
function typeForTitle(title) {
  return MUSICAL_RE.test(String(title || '')) ? 'musical' : 'play';
}

/**
 * @param {{ title: string, pro?: boolean, start?: string, end?: string|null, reviews: unknown[] }} p
 * @param {{ min?: number, today: string }} opts  min: review floor (default 1: a production with one review is
 *   listed unscored; the display layer applies its own minimum before a score shows)
 * @returns {{ emit: true } | { emit: false, reason: string }}
 */
function emitDecision(p, { min = 1, today } = {}) {
  if (p.pro === false) return { emit: false, reason: 'non-professional company (pro:false)' };
  if (EVENT_TITLE_RE.test(p.title)) return { emit: false, reason: 'one-night event, not a production' };
  if (p.start && p.end && p.start === p.end) return { emit: false, reason: 'single-day event' };
  const n = (p.reviews || []).length;
  const openNow = !!(p.end && today && p.end >= today && p.start <= today);
  const floor = openNow ? Math.min(min, 2) : min;
  if (n < floor) return { emit: false, reason: `${n} reviews (floor ${floor})` };
  return { emit: true };
}

module.exports = { typeForTitle, emitDecision, EVENT_TITLE_RE, MUSICAL_RE };
