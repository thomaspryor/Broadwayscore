'use strict';

/**
 * counted-review-integrity.js (BRO-4886)
 *
 * Invariants over the COUNTED review set (data/reviews.json), the rows that
 * actually feed a show's score. The upstream paths that let a bad row in are
 * many (aggregator parsers, byline dedup, the LLM wrong-production check, a
 * stale openingDate, a mislinked priorRuns). Each has been fixed on its own
 * before and a new one appears every few weeks. A check on the OUTPUT does not
 * care which path failed, so it also catches the next one.
 *
 * Found by the revival-promo spot check (2026-10-08): the same Vulture review
 * counted on four unrelated Private Lives pages, a 2016 London review on the
 * 1987 Into the Woods page, a 2008 National Theatre review on Osage County 2007,
 * a never-opened Who's Afraid 2020 page with a score, an "outlet" named after a
 * singer, one review counted twice under two critics, an openingDate four
 * weeks late, and a priorRuns link that could not resolve.
 *
 * Pure: no I/O. The CLI (scripts/audit-counted-review-integrity.js) loads the
 * data. Every check returns plain objects so a test can pin the real shapes.
 */

const DAY_MS = 86400000;

// How long a run may be before its URL year stops being informative (a show
// that runs for years collects reviews dated every year of its life).
const LONG_RUN_YEARS = 3;
// A cluster of this many counted reviews inside CLUSTER_WINDOW_DAYS that all
// predate openingDate by CLUSTER_MIN_GAP_DAYS or more means the date is wrong.
const CLUSTER_MIN_REVIEWS = 5;
const CLUSTER_WINDOW_DAYS = 4;
const CLUSTER_MIN_GAP_DAYS = 14;
// priorRuns entry vs a sibling show: same venue and openings this close.
const PRIOR_RUN_VENUE_GAP_DAYS = 45;
// Quotes shorter than this are too generic to treat as identical content.
const MIN_QUOTE_CHARS = 50;
// Same title opening this close together is one production re-listed (a
// transfer, a second venue, a tour stop), not two productions.
const SAME_PRODUCTION_MAX_GAP_DAYS = 540;
const LISTED_PER_STOP = new Set(['tour', 'regional']);

const CHECKS = [
  'cross-show-duplicate',
  'same-show-multi-byline',
  'url-year-outside-run',
  'unopened-show-counted',
  'junk-outlet',
  'opening-date-cluster',
  'prior-run-link',
];

function parseDay(value) {
  if (!value) return null;
  const s = String(value).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return Date.UTC(+iso[1], +iso[2] - 1, +iso[3]);
  const t = Date.parse(s.replace(/(\d+)(st|nd|rd|th)\b/, '$1'));
  return Number.isNaN(t) ? null : t;
}

function yearOf(value) {
  const ms = parseDay(value);
  return ms === null ? null : new Date(ms).getUTCFullYear();
}

/** A 4-digit year written as a date path segment (/2022/07/10/, /2022/07/, -2022-07-10). */
function urlYear(url) {
  if (!url || typeof url !== 'string') return null;
  let pathname = url;
  try { pathname = new URL(url).pathname; } catch { /* relative or malformed: use as is */ }
  const m = pathname.match(/(?:^|[/_-])((?:19|20)\d{2})[/_-](?:0?[1-9]|1[0-2])(?:[/_-]|$)/)
    || pathname.match(/(?:^|\/)((?:19|20)\d{2})(?:\/|$)/);
  return m ? Number(m[1]) : null;
}

function canonVenue(venue) {
  return String(venue || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\btheatre\b|\btheater\b|\bthe\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function baseTitle(show) {
  return String((show && show.title) || '')
    .replace(/\s*\(.*?\)/g, '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^the /, '')
    .trim();
}

function normText(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function canonUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return null;
  }
}

function runWindow(show) {
  const open = parseDay(show.openingDate) ?? parseDay(show.previewsStartDate);
  const close = parseDay(show.closingDate);
  return { open, close };
}

function linkedId(run) {
  if (typeof run === 'string') return run;
  if (run && typeof run === 'object') return run.id || run.showId || run.productionId || null;
  return null;
}

/** Are two shows the same production (declared prior run, or one live run listed twice)? */
function isRelatedProduction(a, b) {
  for (const [x, y] of [[a, b], [b, a]]) {
    for (const run of x.priorRuns || []) {
      if (linkedId(run) === y.id) return true;
    }
  }
  if (baseTitle(a) !== baseTitle(b)) return false;
  // A tour or regional production is listed once per stop.
  if (LISTED_PER_STOP.has(a.category) && LISTED_PER_STOP.has(b.category)) return true;
  const wa = runWindow(a);
  const wb = runWindow(b);
  if (wa.open === null || wb.open === null) return false;
  const endA = wa.close ?? Infinity;
  const endB = wb.close ?? Infinity;
  // Overlapping windows of the same title = the same production listed under two venues/markets.
  if (wa.open <= endB && wb.open <= endA) return true;
  return Math.abs(wa.open - wb.open) <= SAME_PRODUCTION_MAX_GAP_DAYS * DAY_MS;
}

function row(check, show, review, detail, extra) {
  return Object.assign({
    check,
    showId: show ? show.id : (review && review.showId) || null,
    outlet: review ? (review.outlet || review.outletId || null) : null,
    critic: review ? (review.criticName || null) : null,
    score: review && review.assignedScore !== undefined ? review.assignedScore : null,
    detail,
  }, extra || {});
}

// ── 1. The same counted review on shows that are not the same production ─────
function checkCrossShowDuplicates(shows, reviews) {
  const byId = new Map(shows.map((s) => [s.id, s]));
  const groups = new Map();
  for (const r of reviews) {
    const quote = normText(r.pullQuote);
    if (quote.length < MIN_QUOTE_CHARS) continue;
    const key = `${r.outletId}|${normText(r.criticName)}|${quote.slice(0, 100)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const out = [];
  for (const members of groups.values()) {
    const ids = [...new Set(members.map((m) => m.showId))];
    if (ids.length < 2) continue;
    const showsHere = ids.map((id) => byId.get(id)).filter(Boolean);
    const unrelated = [];
    for (let i = 0; i < showsHere.length; i += 1) {
      for (let j = i + 1; j < showsHere.length; j += 1) {
        if (!isRelatedProduction(showsHere[i], showsHere[j])) {
          unrelated.push(showsHere[i].id, showsHere[j].id);
        }
      }
    }
    if (!unrelated.length) continue;
    const flagged = [...new Set(unrelated)];
    for (const id of flagged) {
      const review = members.find((m) => m.showId === id);
      out.push(row('cross-show-duplicate', byId.get(id), review,
        `same outlet, critic and quote also counted on ${ids.filter((x) => x !== id).join(', ')}`,
        { alsoOn: ids.filter((x) => x !== id) }));
    }
  }
  return out;
}

// ── 2. One review counted twice under two critic names ───────────────────────
function checkSameShowMultiByline(shows, reviews) {
  const byId = new Map(shows.map((s) => [s.id, s]));
  const groups = new Map();
  const add = (key, r) => {
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  };
  for (const r of reviews) {
    const url = canonUrl(r.url);
    if (url) add(`u|${r.showId}|${r.outletId}|${url}`, r);
    const quote = normText(r.pullQuote);
    if (quote.length >= MIN_QUOTE_CHARS) {
      add(`q|${r.showId}|${r.outletId}|${r.assignedScore}|${quote.slice(0, 80)}`, r);
    }
  }
  const out = [];
  const seen = new Set();
  for (const members of groups.values()) {
    const critics = new Set(members.map((m) => normText(m.criticName) || '(none)'));
    if (members.length < 2 || critics.size < 2) continue;
    for (const r of members.slice(1)) {
      const k = `${r.showId}|${r.outletId}|${normText(r.criticName)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(row('same-show-multi-byline', byId.get(r.showId), r,
        `same review also counted as ${members[0].criticName || '(no critic)'} (${members[0].assignedScore})`,
        { keeps: members[0].criticName || null }));
    }
  }
  return out;
}

// ── 3. A review whose URL year is outside the show's run ─────────────────────
function checkUrlYearOutsideRun(shows, reviews) {
  const byId = new Map(shows.map((s) => [s.id, s]));
  const out = [];
  for (const r of reviews) {
    const show = byId.get(r.showId);
    if (!show) continue;
    const y = urlYear(r.url);
    if (!y) continue;
    if (String(show.title || '').includes(String(y))) continue; // "1984", "2000 Years": the year is the title
    const openYear = yearOf(show.openingDate) ?? yearOf(show.previewsStartDate);
    const closeYear = yearOf(show.closingDate);
    if (!openYear || !closeYear) continue; // open-ended or undated: nothing to compare against
    if (closeYear - openYear >= LONG_RUN_YEARS) continue;
    if (y >= openYear - 1 && y <= closeYear + 1) continue;
    const covered = (show.priorRuns || []).some((run) => {
      if (!run || typeof run !== 'object') return false;
      const a = yearOf(run.openingDate);
      const b = yearOf(run.closingDate) ?? a;
      return a !== null && y >= a - 1 && y <= b + 1;
    });
    if (covered) continue;
    out.push(row('url-year-outside-run', show, r,
      `URL year ${y} is outside the ${openYear}-${closeYear} run`, { urlYear: y }));
  }
  return out;
}

// ── 4. Counted reviews on a show that never opened ───────────────────────────
function checkUnopenedShowCounted(shows, reviews) {
  const never = new Map(shows.filter((s) => s.cancelledBeforeOpening === true || s.status === 'cancelled')
    .map((s) => [s.id, s]));
  return reviews.filter((r) => never.has(r.showId))
    .map((r) => row('unopened-show-counted', never.get(r.showId), r, 'show was cancelled before opening'));
}

// ── 5. A "critic outlet" that is really a topic page or a person ─────────────
const TOPIC_URL = /(?:^|\.)topics\.[a-z.]+\/|\/timestopics\/|\/people\/[a-z]\/[a-z-]+\/index\.html/i;

function checkJunkOutlets(shows, reviews, outletRegistry) {
  const byId = new Map(shows.map((s) => [s.id, s]));
  const outlets = (outletRegistry && outletRegistry.outlets) || outletRegistry || {};
  const out = [];
  for (const r of reviews) {
    const entry = outlets[r.outletId];
    const topicUrl = typeof r.url === 'string' && TOPIC_URL.test(r.url);
    const domainlessDefunct = entry && !entry.domain && entry.accessModel === 'defunct';
    const unregistered = !entry;
    if (!topicUrl && !domainlessDefunct && !unregistered) continue;
    const why = topicUrl ? 'URL is a topic/people index page, not a review'
      : domainlessDefunct ? 'outlet has no domain and is marked defunct in the registry'
        : 'outlet is not in the outlet registry';
    out.push(row('junk-outlet', byId.get(r.showId), r, why));
  }
  return out;
}

// ── 6. openingDate later than the reviews that followed it ───────────────────
function checkOpeningDateCluster(shows, reviews) {
  const byShow = new Map();
  for (const r of reviews) {
    const day = parseDay(r.publishDate);
    if (day === null) continue;
    if (!byShow.has(r.showId)) byShow.set(r.showId, []);
    byShow.get(r.showId).push(day);
  }
  const out = [];
  for (const show of shows) {
    const open = parseDay(show.openingDate);
    const days = byShow.get(show.id);
    if (open === null || !days || days.length < CLUSTER_MIN_REVIEWS) continue;
    // A declared prior run legitimately puts reviews before the new opening.
    if ((show.priorRuns || []).length) continue;
    days.sort((a, b) => a - b);
    for (let i = 0; i + CLUSTER_MIN_REVIEWS <= days.length; i += 1) {
      const end = days[i + CLUSTER_MIN_REVIEWS - 1];
      if (end - days[i] > CLUSTER_WINDOW_DAYS * DAY_MS) continue;
      if (open - end < CLUSTER_MIN_GAP_DAYS * DAY_MS) continue;
      const inWindow = days.filter((d) => d >= days[i] && d <= days[i] + CLUSTER_WINDOW_DAYS * DAY_MS);
      const modal = inWindow.slice().sort((a, b) =>
        inWindow.filter((d) => d === b).length - inWindow.filter((d) => d === a).length)[0];
      const suggested = new Date(modal).toISOString().slice(0, 10);
      out.push(row('opening-date-cluster', show, null,
        `${inWindow.length} counted reviews cluster on ${suggested}, ${Math.round((open - modal) / DAY_MS)} days before openingDate ${show.openingDate}`,
        { openingDate: show.openingDate, suggestedOpeningDate: suggested, reviewsInCluster: inWindow.length }));
      break;
    }
  }
  return out;
}

// ── 7. priorRuns that cannot resolve to the older show's page ────────────────
function checkPriorRunLinks(shows) {
  const ids = new Set(shows.map((s) => s.id));
  const out = [];
  for (const show of shows) {
    for (const run of show.priorRuns || []) {
      const id = linkedId(run);
      if (id) {
        if (!ids.has(id)) {
          out.push(row('prior-run-link', show, null, `priorRuns points at ${id}, which is not a show`, { missingId: id }));
        }
        continue;
      }
      if (!run || typeof run !== 'object') continue;
      const venue = canonVenue(run.venue);
      const runOpen = parseDay(run.openingDate);
      if (!venue || runOpen === null) continue;
      const match = shows.find((o) => o.id !== show.id
        && baseTitle(o) === baseTitle(show)
        && canonVenue(o.venue) === venue
        && parseDay(o.openingDate) !== null
        && Math.abs(parseDay(o.openingDate) - runOpen) <= PRIOR_RUN_VENUE_GAP_DAYS * DAY_MS);
      if (match && match.category !== show.category) {
        out.push(row('prior-run-link', show, null,
          `priorRuns entry for ${run.venue} has no id and ${match.id} is in a different category, so its reviews will not carry over`,
          { suggestedId: match.id }));
      }
    }
  }
  return out;
}

// ── 8. Excluded as wrong production although everything points at this run ──
// Not part of the counted set (it is what is NOT counted), so it takes the
// review-text files. A flagged file whose publishDate falls inside the run
// window and whose URL year sits inside the run years is the signature of a
// false positive: the 2022 Into the Woods Broadway opening-night reviews were
// thrown out this way after a wrong openingDate, and 431 files across the
// corpus match (2026-10-08). A candidate is a lead for a human or the recovery
// scripts, never an automatic clear.
function findFlaggedGenuineCandidates({ shows, files }) {
  const byId = new Map(shows.map((s) => [s.id, s]));
  const out = [];
  for (const { showId, file, data } of files) {
    const show = byId.get(showId);
    if (!show || !data) continue;
    if (!(data.wrongProduction || data.wrongShow)) continue;
    if (data.wrongProductionManualClear || data.wrongProductionOverride || data.wrongShowManualClear) continue;
    const open = parseDay(show.openingDate);
    if (open === null) continue;
    const close = parseDay(show.closingDate) ?? open + 365 * DAY_MS;
    const published = parseDay(data.publishDate);
    if (published === null || published < open - 45 * DAY_MS || published > close + 30 * DAY_MS) continue;
    const y = urlYear(data.url);
    if (!y || y < new Date(open).getUTCFullYear() || y > new Date(close).getUTCFullYear() + 1) continue;
    out.push({
      check: 'flagged-in-window',
      showId,
      file,
      outlet: data.outlet || null,
      critic: data.criticName || null,
      detail: `flagged ${data.wrongShow ? 'wrongShow' : 'wrongProduction'} but dated ${data.publishDate} with a ${y} URL, inside the run`,
      reason: String(data.wrongProductionNote || data.contentTierReason || '').slice(0, 120),
    });
  }
  return out;
}

/**
 * @param {{shows: object[], reviews: object[], outletRegistry?: object}} data
 * @returns {{issues: object[], counts: Object<string, number>, total: number}}
 */
function detectCountedReviewIssues({ shows, reviews, outletRegistry }) {
  const issues = [
    ...checkCrossShowDuplicates(shows, reviews),
    ...checkSameShowMultiByline(shows, reviews),
    ...checkUrlYearOutsideRun(shows, reviews),
    ...checkUnopenedShowCounted(shows, reviews),
    ...checkJunkOutlets(shows, reviews, outletRegistry),
    ...checkOpeningDateCluster(shows, reviews),
    ...checkPriorRunLinks(shows),
  ];
  const counts = Object.fromEntries(CHECKS.map((c) => [c, 0]));
  for (const i of issues) counts[i.check] += 1;
  return { issues, counts, total: issues.length };
}

module.exports = {
  CHECKS,
  detectCountedReviewIssues,
  checkCrossShowDuplicates,
  checkSameShowMultiByline,
  checkUrlYearOutsideRun,
  checkUnopenedShowCounted,
  checkJunkOutlets,
  checkOpeningDateCluster,
  checkPriorRunLinks,
  findFlaggedGenuineCandidates,
  isRelatedProduction,
  urlYear,
};
