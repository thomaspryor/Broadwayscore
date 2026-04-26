/**
 * temporal-byline-guard.js — Catch attributions to retired/deceased critics.
 *
 * Several critics regularly get reviews misattributed to them by the scraper
 * because their bylines persist in HTML templates / "related stories" lists
 * long after they stopped writing. We've cleaned 25+ Brantley/Teachout/Kissel
 * misattributions manually; this guard prevents future ones at write time.
 *
 * Each entry: { name, lastActiveDate, reason }.
 *   - lastActiveDate: ISO date past which this critic cannot have written.
 *     For deceased: date of death. For retired: retirement date or last known
 *     real byline + a buffer.
 *
 * If `freelanceAfter` is true, the critic occasionally publishes freelance
 * post-cutoff; we soft-warn instead of rejecting.
 *
 * Behavior of `validateTemporalAttribution`:
 *   - Returns { ok: true } if attribution is plausible.
 *   - Returns { ok: false, reason } if criticName has a hard cutoff and
 *     publishDate is past it.
 *   - Returns { ok: true, warning } if it's a soft case (freelancer).
 */

'use strict';

const RETIRED_CRITICS = [
  // Deceased
  { name: 'Charles Isherwood', lastActiveDate: null }, // explicitly NOT retired — alive at WSJ
  { name: 'Terry Teachout', lastActiveDate: '2022-01-13', reason: 'died 2022-01-13' },
  { name: 'Howard Kissel', lastActiveDate: '2012-02-24', reason: 'died 2012-02-24' },
  { name: 'Clive Barnes', lastActiveDate: '2008-11-19', reason: 'died 2008-11-19' },
  { name: 'John Simon', lastActiveDate: '2019-11-24', reason: 'died 2019-11-24' },
  { name: 'Michael Feingold', lastActiveDate: '2022-11-02', reason: 'died 2022-11-02' },

  // Retired (NYT chief critics)
  { name: 'Ben Brantley', lastActiveDate: '2020-10-30', freelanceAfter: true, reason: 'retired NYT 2020-10-30; rare freelance pieces through ~2023' },
  { name: 'Bruce Weber', lastActiveDate: '2010-12-31', reason: 'left NYT theater desk ~2010' },
  { name: 'Frank Rich', lastActiveDate: '1994-03-01', reason: 'left NYT as critic 1994' },

  // Other long-retired
  { name: 'Linda Winer', lastActiveDate: '2017-07-01', reason: 'retired Newsday 2017' },
  { name: 'John Lahr', lastActiveDate: '2013-12-31', reason: 'retired New Yorker ~2013' },
  { name: 'Marilyn Stasio', lastActiveDate: '2020-12-31', freelanceAfter: true, reason: 'semi-retired Variety ~2020' },
  { name: 'Jeremy Gerard', lastActiveDate: '2020-01-01', freelanceAfter: true, reason: 'mostly retired ~2020' },
  { name: 'Peter Marks', lastActiveDate: '2024-12-31', freelanceAfter: true, reason: 'WaPo ended theater desk 2024' },
];

const _retiredIndex = (() => {
  const map = new Map();
  for (const e of RETIRED_CRITICS) {
    if (e.lastActiveDate) map.set(e.name.toLowerCase(), e);
  }
  return map;
})();

/**
 * Validate that an attribution is temporally plausible.
 *
 * @param {string} criticName
 * @param {string} publishDate - ISO date or YYYY-MM-DD; can also accept "Month D, YYYY" forms.
 * @returns {{ok: boolean, reason?: string, warning?: string, hardBlock?: boolean}}
 */
function validateTemporalAttribution(criticName, publishDate) {
  if (!criticName || !publishDate) return { ok: true };
  const entry = _retiredIndex.get(String(criticName).toLowerCase());
  if (!entry) return { ok: true };

  const pubIso = _toIso(publishDate);
  if (!pubIso) return { ok: true };

  if (pubIso <= entry.lastActiveDate) return { ok: true };

  if (entry.freelanceAfter) {
    return {
      ok: true,
      warning: `Attribution to ${criticName} after ${entry.lastActiveDate} (${entry.reason}). Possible freelance piece — verify byline.`,
    };
  }

  return {
    ok: false,
    hardBlock: true,
    reason: `${criticName} is past their last-active date (${entry.lastActiveDate}; ${entry.reason}). Article publishDate ${pubIso} cannot be authored by them.`,
  };
}

function _toIso(d) {
  if (!d) return null;
  const s = String(d);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const t = Date.parse(s);
  if (!isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  return null;
}

module.exports = { validateTemporalAttribution, RETIRED_CRITICS };
