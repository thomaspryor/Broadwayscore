'use strict';

/**
 * Olivier Award nominees per ceremony, from Wikipedia's
 * "YYYY Laurence Olivier Awards" page (BRO-4851, WE historical backfill).
 *
 * Used as an independent "this production was reviewed and noticed" signal
 * for historical West End discovery. Nominee lines carry title + venue but no
 * dates, so this source can only corroborate a dated listing, never create a
 * candidate on its own.
 *
 * Fetching goes through precursor-wikipedia.js's fetchWikitext (shared UA +
 * rate limit) rather than a third Wikipedia reader. The per-category pages
 * enrich-olivier-awards.js reads have no venues, which is why this reads the
 * ceremony page instead.
 *
 * Nominee line shapes (2025 page, verified 2026-10-07):
 *   *'''''[[Giant (play)|Giant]]'' by [[Mark Rosenblatt]] – [[Royal Court Theatre|Jerwood Downstairs, Royal Court]]'''
 *   **''[[MJ the Musical]]'' – [[Prince Edward Theatre]]
 *   **''[[The Years (play)|The Years]]'' adapted by … – [[Almeida Theatre]] and [[Harold Pinter Theatre]]
 *   **[[Person]] as Role in ''[[Show]]'' – [[Venue]]   (performer categories)
 */

const { fetchWikitext, sleep } = require('./precursor-wikipedia');

const ITALIC_LINKED_TITLE = /''+\s*\[\[(?:[^|\]]+\|)?([^\]]+)\]\]\s*''/;
const ITALIC_PLAIN_TITLE = /''+([^'[\]\n]{2,120}?)''/;

function stripWikiLinks(s) {
  return s.replace(/\[\[(?:[^|\]]+\|)?([^\]]+)\]\]/g, '$1');
}

/**
 * @param {string} wikitext
 * @returns {Array<{title: string, venues: string[]}>}
 */
function parseOlivierCeremonyNominees(wikitext) {
  const out = [];
  for (const line of String(wikitext || '').split('\n')) {
    if (!/^\*/.test(line)) continue;
    const m = line.match(ITALIC_LINKED_TITLE) || line.match(ITALIC_PLAIN_TITLE);
    if (!m) continue;
    const title = stripWikiLinks(m[1]).replace(/'{2,}/g, '').trim();
    // Venue text follows the LAST spaced dash on the line; drop templates
    // like {{double dagger|alt=Winner}}.
    const dashes = [...line.matchAll(/\s[–—-]\s/g)];
    if (!dashes.length) continue;
    const last = dashes[dashes.length - 1];
    const tail = line.slice(last.index + last[0].length)
      .replace(/\{\{[^{}]*\}\}/g, '')
      .replace(/'{2,}/g, '');
    const venues = stripWikiLinks(tail)
      .split(/\s+and\s+|,\s*(?=[A-Z@])/)
      .map(v => v.replace(/<[^>]+>/g, '').trim())
      .filter(v => v.length >= 3);
    if (!title || venues.length === 0) continue;
    out.push({ title, venues });
  }
  return out;
}

/**
 * @param {number} year ceremony year (e.g. 2025 covers roughly Mar 2024–Feb 2025 openings)
 * @returns {Promise<Array<{title: string, venues: string[], year: number}>>} [] when the page is missing
 */
async function fetchOlivierCeremonyNominees(year) {
  const wikitext = await fetchWikitext(`${year} Laurence Olivier Awards`);
  await sleep(600);
  if (!wikitext) return [];
  return parseOlivierCeremonyNominees(wikitext).map(n => ({ ...n, year }));
}

module.exports = { parseOlivierCeremonyNominees, fetchOlivierCeremonyNominees };
