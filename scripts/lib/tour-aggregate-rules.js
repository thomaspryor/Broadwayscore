'use strict';

/**
 * Is a `tourParent` roll-up a real tour? (BRO-7192). Pure, no IO.
 *
 * A tour aggregate (shows.json row whose id some legs name in `tourParent`)
 * rolls the per-city legs of ONE touring production into one combined score
 * and shows its legs' reviews a second time on the aggregate page
 * (Paranormal Activity: Chicago, LA, DC, SF, Boston). That duplication is only
 * honest when the legs are the same production on the road.
 *
 * Gun & Powder broke it: the 2020 Signature Theatre premiere (director Robert
 * O'Hara, a different cast) and the 2024 Paper Mill Playhouse production
 * (director Stevie Walker-Webb) were grouped as a "national tour". Two
 * separate productions four years apart are not a tour, so the aggregate
 * (tagged national-tour, venue "Regional Tryouts (Arlington, VA 2020; Millburn,
 * NJ 2024)") copied 12 review rows already shown on their own pages.
 *
 * Two facts a real tour cannot fail:
 *   - its legs open within MAX_LEG_SPAN_DAYS of each other (a tour is one
 *     continuous schedule; Paranormal Activity's five legs span 272 days);
 *   - the legs that name a director name the same one (a new director is a
 *     new production, a fact a venue's playbill states).
 */

// 18 months: longer than any pre-Broadway tour schedule in the data, far shorter than two
// engagements of the same musical years apart.
const MAX_LEG_SPAN_DAYS = 548;
const DAY = 86400000;

function isoDay(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T00:00:00Z`) : null;
}

/** Normalized director names of a show (role exactly Director / Direction / Directed by). */
function directorsOf(show) {
  const out = [];
  for (const c of (show && show.creativeTeam) || []) {
    if (!c || typeof c.name !== 'string' || typeof c.role !== 'string') continue;
    if (/^director$|^direction$|^directed by$/i.test(c.role.trim())) {
      out.push(c.name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());
    }
  }
  return [...new Set(out)].sort();
}

/** Aggregate id -> its legs (rows whose tourParent is that id), from a shows array. */
function legsByAggregate(shows) {
  const map = new Map();
  for (const s of shows || []) {
    if (s && typeof s.tourParent === 'string' && s.tourParent) {
      if (!map.has(s.tourParent)) map.set(s.tourParent, []);
      map.get(s.tourParent).push(s);
    }
  }
  return map;
}

/**
 * Problems with how one aggregate's legs are grouped, as error strings (empty
 * when it is a real tour).
 */
function aggregateProblems(aggregate, legs) {
  const id = aggregate ? aggregate.id : '(missing)';
  const problems = [];
  if (legs.length < 2) problems.push(`Tour aggregate "${id}" has ${legs.length} leg(s): a tour roll-up needs at least two stops`);
  const opens = legs.map((l) => isoDay(l.openingDate) ?? isoDay(l.previewsStartDate)).filter((d) => d !== null);
  if (opens.length >= 2) {
    const span = Math.round((Math.max(...opens) - Math.min(...opens)) / DAY);
    if (span > MAX_LEG_SPAN_DAYS) {
      problems.push(`Tour aggregate "${id}": its legs open ${span} days apart (limit ${MAX_LEG_SPAN_DAYS}); separate productions years apart are not one tour, so each keeps its own page and score (${legs.map((l) => l.id).join(', ')})`);
    }
  }
  const named = legs.map((l) => ({ id: l.id, dirs: directorsOf(l) })).filter((l) => l.dirs.length > 0);
  if (named.length >= 2) {
    const first = named[0].dirs.join('|');
    if (named.some((l) => l.dirs.join('|') !== first)) {
      problems.push(`Tour aggregate "${id}": its legs name different directors (${named.map((l) => `${l.id}: ${l.dirs.join(' & ')}`).join('; ')}); a new director is a new production, not a tour stop`);
    }
  }
  return problems;
}

/**
 * Every tourParent problem in `shows`: a leg pointing at a missing or
 * non-regional row, an aggregate that is itself a leg, and aggregates whose
 * legs are not one production (aggregateProblems).
 */
function tourAggregateProblems(shows) {
  const byId = new Map((shows || []).filter(Boolean).map((s) => [s.id, s]));
  const problems = [];
  for (const [aggId, legs] of legsByAggregate(shows)) {
    const agg = byId.get(aggId);
    if (!agg) {
      problems.push(`Legs ${legs.map((l) => l.id).join(', ')} name tourParent "${aggId}", which is not in shows.json`);
      continue;
    }
    if (agg.category !== 'regional') problems.push(`Tour aggregate "${aggId}" is category "${agg.category}": only a regional row can roll up regional legs`);
    if (agg.tourParent) problems.push(`Tour aggregate "${aggId}" is itself a leg of "${agg.tourParent}": roll-ups do not nest`);
    problems.push(...aggregateProblems(agg, legs));
  }
  return problems;
}

module.exports = { MAX_LEG_SPAN_DAYS, directorsOf, legsByAggregate, aggregateProblems, tourAggregateProblems };
