/**
 * All-time grosses attribution (BRO-5012).
 *
 * BroadwayWorld's all-time table gives one row per title. scrape-alltime.ts
 * writes it to the slug matchTitleToShow picks, and its monotonic merge never
 * lowers or removes a value, so when the match moved between productions over
 * the years (Mamma Mia! 2001 vs the 2025 return, Frozen 2018 vs a 2004 play of
 * the same name, a West End row) every slug it ever landed on kept an
 * identical copy. The /box-office all-time top 10 then listed Mamma Mia twice.
 *
 * sharedAllTimeClears groups shows.json slugs whose allTime is identical and
 * returns the copies to clear, keeping one owner per group: the Broadway
 * production whose run length matches that many performances; when several
 * could, the one whose run length is closest to the count. Off-Broadway and
 * West End slugs never own (the table is Broadway-only).
 * When no Broadway production fits, unholdableAllTimeClears handles it.
 *
 * misplacedAllTimeMoves handles the other half: prefer:'original' sends the
 * current row to the oldest production of a title even when only a revival
 * could have played it (Chicago's 11,711 performances on the 1975 original,
 * which ran two years), so Chicago was also listed twice. A Broadway slug
 * whose run cannot hold its count hands the row to the same-title Broadway
 * production that can (closest run length), and is cleared. A closed
 * production that already has a different row of its own keeps it: the larger
 * row is the title's total over several runs (holdsOwnFinalRow).
 *
 * unholdableAllTimeClears: BroadwayWorld totals a title over all its Broadway
 * runs, so a revived title's row can belong to no single production. A copy
 * still on a run that cannot hold its count is cleared (BRO-5016).
 */

const { normalizeTitle } = require('./title-match');
const { KNOWN_GAPS } = require('./grosses-integrity');

const DAY_MS = 24 * 60 * 60 * 1000;
const PERFS_PER_WEEK = 8;
// A run's capacity is ~8 shows a week from first preview to closing (or now);
// extra holiday shows and date slop get 15% plus two weeks.
const FIT_SLACK_RATIO = 1.15;
const FIT_SLACK_PERFS = 16;
// A real run plays most of its capacity; an open-ended or undated run that
// "could hold" any count is not evidence it played this one.
const FIT_MIN_SHARE = 0.6;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;
// category is the tier (an Off-Broadway show has market 'broadway').
const isBroadway = (show) => (show.category || show.market) === 'broadway';
const toMs = (d) => (typeof d === 'string' && ISO_DATE_RE.test(d) ? Date.parse(`${d.slice(0, 10)}T00:00:00Z`) : null);

// Without a first-preview date, assume previews ran this long before opening.
const PREVIEW_WEEKS_IF_UNKNOWN = 4;

/** Most performances the show's run could hold, or null without a start date. */
function runCapacity(show, nowMs) {
  const opening = toMs(show.openingDate);
  const start = toMs(show.previewsStartDate) ?? (opening == null ? null : opening - PREVIEW_WEEKS_IF_UNKNOWN * 7 * DAY_MS);
  if (start == null) return null;
  const end = toMs(show.closingDate) ?? nowMs;
  if (end < start) return 0;
  return ((end - start) / (7 * DAY_MS) + 1) * PERFS_PER_WEEK;
}

const canHold = (performances, capacity) => capacity != null && performances <= capacity * FIT_SLACK_RATIO + FIT_SLACK_PERFS;
const fits = (performances, capacity) => canHold(performances, capacity) && performances >= capacity * FIT_MIN_SHARE - FIT_SLACK_PERFS;

/**
 * @param {Record<string, {allTime?: {gross?:number|null, performances?:number|null, attendance?:number|null}}>} grossesShows
 * @param {Array<object>} shows - shows.json entries (slug, market/category, run dates)
 * @param {{ now?: Date }} [opts]
 * @returns {Array<{slug:string, owner:string, reason:string}>} slugs whose allTime should be cleared
 */
function sharedAllTimeClears(grossesShows, shows, { now = new Date() } = {}) {
  const bySlug = new Map((shows || []).map((s) => [s.slug || s.id, s]));
  const groups = new Map();
  for (const [slug, entry] of Object.entries(grossesShows || {})) {
    const a = entry && entry.allTime;
    if (!a || !a.gross || !bySlug.has(slug)) continue;
    const key = `${a.gross}|${a.performances ?? ''}|${a.attendance ?? ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(slug);
  }
  const nowMs = now.getTime();
  const clears = [];
  for (const slugs of groups.values()) {
    if (slugs.length < 2) continue;
    const perfs = grossesShows[slugs[0]].allTime.performances;
    if (!perfs) continue;
    let owner = null;
    let ownerDist = Infinity;
    for (const slug of slugs) {
      const show = bySlug.get(slug);
      if (!isBroadway(show)) continue;
      const cap = runCapacity(show, nowMs);
      if (!fits(perfs, cap)) continue;
      const dist = Math.abs(Math.log(Math.max(cap, 1) / perfs));
      if (dist < ownerDist) { owner = slug; ownerDist = dist; }
    }
    // No single run fits (a total summed over several revivals): keep every
    // Broadway copy, but a non-Broadway copy is still wrong.
    if (!owner) {
      const broadway = slugs.filter((slug) => isBroadway(bySlug.get(slug)));
      if (!broadway.length) continue;
      for (const slug of slugs) {
        const show = bySlug.get(slug);
        if (isBroadway(show)) continue;
        clears.push({ slug, owner: null, reason: `identical to ${broadway.join(', ')}; ${show.category || show.market} production; the all-time table is Broadway-only` });
      }
      continue;
    }
    for (const slug of slugs) {
      if (slug === owner) continue;
      const show = bySlug.get(slug);
      const run = `run ${show.previewsStartDate || show.openingDate || '?'}..${show.closingDate || 'now'}`;
      const why = !isBroadway(show)
        ? `${show.category || show.market} production; the all-time table is Broadway-only`
        : canHold(perfs, runCapacity(show, nowMs))
          ? `${run} fits ${perfs} performances less closely`
          : `${run} cannot hold ${perfs} performances`;
      clears.push({ slug, owner, reason: `identical to ${owner}; ${why}` });
    }
  }
  return clears.sort((x, y) => x.slug.localeCompare(y.slug));
}

/**
 * @returns {Array<{slug:string, to:string, reason:string}>} rows to move: max-merge
 *   slug's allTime into `to`, then clear slug
 */
function misplacedAllTimeMoves(grossesShows, shows, { now = new Date() } = {}) {
  const nowMs = now.getTime();
  const broadway = (shows || []).filter((s) => s && isBroadway(s));
  const byTitle = new Map();
  for (const s of broadway) {
    const key = normalizeTitle(s.title || '');
    if (!key) continue;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(s);
  }
  const moves = [];
  for (const s of broadway) {
    const slug = s.slug || s.id;
    const perfs = grossesShows?.[slug]?.allTime?.performances;
    if (!perfs || !grossesShows[slug].allTime.gross) continue;
    const cap = runCapacity(s, nowMs);
    if (cap == null || canHold(perfs, cap)) continue;
    let to = null;
    let toDist = Infinity;
    for (const sib of byTitle.get(normalizeTitle(s.title || '')) || []) {
      if (sib === s) continue;
      const sibCap = runCapacity(sib, nowMs);
      if (!fits(perfs, sibCap)) continue;
      if (holdsOwnFinalRow(grossesShows, sib, s, nowMs)) continue;
      const dist = Math.abs(Math.log(Math.max(sibCap, 1) / perfs));
      if (dist < toDist) { to = sib.slug || sib.id; toDist = dist; }
    }
    if (to) moves.push({ slug, to, reason: `run ${s.previewsStartDate || s.openingDate}..${s.closingDate || 'now'} cannot hold ${perfs} performances; ${to} can` });
  }
  return moves.sort((x, y) => x.slug.localeCompare(y.slug));
}

const EMPTY = () => ({ gross: null, performances: null, attendance: null });

/**
 * Apply both repairs to grosses.json `shows` in place: moves first (the larger
 * of the two rows, taken whole so fields from different scrapes never mix,
 * lands on the fitting production and the source is cleared), then
 * identical-copy clears.
 * @returns {{ moves: Array<{slug,to,reason}>, clears: Array<{slug,owner,reason}> }}
 */
function applyAllTimeAttribution(grossesShows, shows, opts = {}) {
  const moves = misplacedAllTimeMoves(grossesShows, shows, opts);
  for (const m of moves) {
    const from = grossesShows[m.slug].allTime;
    const into = grossesShows[m.to] && grossesShows[m.to].allTime;
    const row = into && (into.gross || 0) > (from.gross || 0) ? into : from;
    const moved = { gross: row.gross ?? null, performances: row.performances ?? null, attendance: row.attendance ?? null };
    if (grossesShows[m.to]) grossesShows[m.to].allTime = moved;
    else grossesShows[m.to] = { allTime: moved };
    grossesShows[m.slug].allTime = EMPTY();
  }
  const shared = sharedAllTimeClears(grossesShows, shows, opts);
  const sharedSlugs = new Set(shared.map((c) => c.slug));
  const clears = [...shared, ...unholdableAllTimeClears(grossesShows, shows, opts).filter((c) => !sharedSlugs.has(c.slug))];
  for (const c of clears) grossesShows[c.slug].allTime = EMPTY();
  // A moved row's source is emptied too (the 2025 Mamma Mia! handed the
  // title's total to the 2001 run), so it is refilled the same way.
  const emptied = [...clears, ...moves.map((m) => ({ slug: m.slug }))];
  const fills = opts.history ? fillClearedFromHistory(grossesShows, shows, opts.history, emptied, opts) : [];
  return { moves, clears, fills };
}

// History rows start in December 2001. A run's own weeks count as its whole
// run when they begin within three weeks of its first preview and end within
// two of its closing (running shows: the newest week).
const OWN_RUN_START_SLACK_DAYS = 21;
const OWN_RUN_END_SLACK_DAYS = 14;

// Calendar weeks from `first` to `last` inclusive that Broadway played, so a
// week missing from the history altogether counts as a hole, not just a stored
// week that lacks the row (the history is keyed by week ending, a few BWW-era
// keys by Monday, hence the rounding). Weeks inside a known gap (the COVID
// shutdown: the history has no key between its two ends) are not expected.
function expectedWeeks(first, last) {
  const span = (a, b) => Math.round((toMs(b) - toMs(a)) / (7 * DAY_MS));
  let dark = 0;
  for (const [from, to] of KNOWN_GAPS) if (first <= from && last >= to) dark += span(from, to) - 1;
  return span(first, last) + 1 - dark;
}

/**
 * A production's totals from its own weekly League rows. Only weeks inside
 * the run's dates count: a history not yet re-keyed per run (BRO-5016) still
 * files a title's earlier runs under one slug, and those must never be summed
 * back into the production. `complete` when the rows cover first preview to
 * closing with no missing week (a week the history has for other shows but not
 * this one is a scrape gap, and the sum would come up short), every row has a
 * count, and the count fits the run. `status`: complete, partial (rows start
 * late but are whole after), gaps (a hole, a short end or a missing count) or
 * misfit (more performances than the run could play).
 */
function ownRunTotals(history, show, { now = new Date() } = {}) {
  const slug = show.slug || show.id;
  // Without a first-preview date the opening is the latest the run can have
  // begun (a return engagement like Beetlejuice 2025 has no previews).
  const start = toMs(show.previewsStartDate) ?? toMs(show.openingDate);
  if (start == null) return null;
  const weeks = Object.keys(history?.weeks || {}).sort();
  const closing = toMs(show.closingDate);
  const end = closing != null && closing < now.getTime() ? closing : toMs(weeks[weeks.length - 1]);
  if (end == null) return null;
  const lo = start - OWN_RUN_START_SLACK_DAYS * DAY_MS;
  const hi = end + OWN_RUN_END_SLACK_DAYS * DAY_MS;
  const inRun = weeks.filter((w) => toMs(w) >= lo && toMs(w) <= hi);
  const rows = [];
  for (const w of inRun) {
    const r = history.weeks[w]?.[slug];
    if (r && typeof r === 'object' && r.gross != null) rows.push([w, r]);
  }
  if (!rows.length) return null;
  const first = rows[0][0];
  const last = rows[rows.length - 1][0];
  const gaps = Math.max(0, expectedWeeks(first, last) - rows.length);
  // Weekly grosses carry cents; round the sum so float drift never shows.
  const sum = (k) => Math.round(rows.reduce((a, [, r]) => a + (Number(r[k]) || 0), 0) * 100) / 100;
  const performances = sum('performances');
  const startsLate = toMs(first) > start + OWN_RUN_START_SLACK_DAYS * DAY_MS;
  const endsEarly = toMs(last) < end - OWN_RUN_END_SLACK_DAYS * DAY_MS;
  const counted = rows.every(([, r]) => r.performances != null);
  const fitsRun = canHold(performances, runCapacity(show, now.getTime()));
  const complete = gaps === 0 && !startsLate && !endsEarly && counted && fitsRun;
  // Short only at the start because the history itself starts then (December
  // 2001): the card can say "since" that week. A late first row anywhere else
  // is a missed week, and a hole, a short end or a missing count cannot be
  // labeled either.
  const beforeHistory = toMs(first) <= toMs(weeks[0]) + OWN_RUN_START_SLACK_DAYS * DAY_MS;
  const status = !fitsRun ? 'misfit'
    : complete ? 'complete'
      : gaps === 0 && !endsEarly && counted && beforeHistory ? 'partial' : 'gaps';
  return {
    gross: sum('gross'),
    performances,
    attendance: rows.every(([, r]) => r.attendance != null) ? sum('attendance') : null,
    weeks: rows.length,
    gaps,
    since: first,
    complete,
    status,
  };
}

/**
 * A cleared Broadway production gets its own run's totals back from the
 * weekly rows instead of a blank (BRO-5016): as allTime when the rows cover
 * the whole run, as partialRun (with `since`, the first week, which only the
 * show's own card reads) when they only start late, and nothing when a week
 * inside the run is missing. A history-filled allTime is marked
 * `allTimeSource: 'history'` so the next run refreshes it from the weekly rows
 * (a running show keeps growing) and the BWW merge never mixes it with a
 * scraped row. A slug whose allTime came from BWW drops any partialRun.
 * @returns {Array<{slug, status: 'complete'|'partial'|'gaps'|'misfit', weeks, gaps, since, gross}>} (only complete and partial are written)
 */
function fillClearedFromHistory(grossesShows, shows, history, clears, opts = {}) {
  const bySlug = new Map(shows.map((s) => [s.slug || s.id, s]));
  const cleared = new Set(clears.map((c) => c.slug));
  const fills = [];
  for (const [slug, entry] of Object.entries(grossesShows)) {
    const show = bySlug.get(slug);
    const at = entry && entry.allTime;
    const fromHistory = entry && entry.allTimeSource === 'history';
    const empty = !at || (at.gross == null && at.performances == null);
    if (!empty && !fromHistory) { delete entry.partialRun; continue; }
    if (!(cleared.has(slug) || entry.partialRun || fromHistory)) continue;
    const own = show && isBroadway(show) ? ownRunTotals(history, show, opts) : null;
    delete entry.partialRun;
    if (fromHistory) { entry.allTime = EMPTY(); delete entry.allTimeSource; }
    if (!own) continue;
    const { status } = own;
    fills.push({ slug, status, weeks: own.weeks, gaps: own.gaps, since: own.since, gross: own.gross });
    const totals = { gross: own.gross, performances: own.performances, attendance: own.attendance };
    if (status === 'complete') {
      entry.allTime = totals;
      entry.allTimeSource = 'history';
    } else if (status === 'partial') {
      entry.partialRun = { ...totals, since: own.since };
    }
  }
  // BRO-5599: a closed Broadway run the scrapers never tracked has no entry at
  // all, so the loop above never sees it (seven revivals showed no total gross
  // on /biz while the weekly rows held their whole run). Give it an allTime
  // only when the rows cover the whole run; partial or gappy rows stay blank.
  const now = (opts.now || new Date()).getTime();
  for (const show of shows) {
    const slug = show.slug || show.id;
    if (!slug || grossesShows[slug] || !isBroadway(show)) continue;
    const closing = toMs(show.closingDate);
    if (closing == null || closing >= now) continue;
    const own = ownRunTotals(history, show, opts);
    if (!own || own.status !== 'complete') continue;
    // A run that may have begun before the history does (it starts December
    // 2001) can look complete from one late row: leave it blank.
    if (mayPredateHistory(history, own)) continue;
    fills.push({ slug, status: own.status, weeks: own.weeks, gaps: own.gaps, since: own.since, gross: own.gross });
    grossesShows[slug] = {
      allTime: { gross: own.gross, performances: own.performances, attendance: own.attendance },
      allTimeSource: 'history',
    };
  }
  return fills;
}

/**
 * Closed Broadway runs whose weekly rows cover the whole run but that still
 * show no all-time gross (BRO-5599). The fill above should have written one,
 * so a hit means the attribution step has not run on this data. Runs with
 * partial or gappy rows are not listed: blank is the honest answer there.
 * @returns {Array<{slug:string, gross:number, weeks:number}>}
 */
// True when the run's rows could be missing its start because the history
// itself begins then (December 2001): such a total may look complete from one
// late row, so neither the fill nor the audit trusts it.
function mayPredateHistory(history, own) {
  const firstWeek = toMs(Object.keys(history?.weeks || {}).sort()[0]);
  return firstWeek != null && toMs(own.since) <= firstWeek + OWN_RUN_START_SLACK_DAYS * DAY_MS;
}

function closedRunsMissingAllTime(grossesShows, shows, history, opts = {}) {
  const now = (opts.now || new Date()).getTime();
  const out = [];
  for (const show of shows) {
    const slug = show.slug || show.id;
    const closing = toMs(show.closingDate);
    if (!slug || !isBroadway(show) || closing == null || closing >= now) continue;
    if (grossesShows?.[slug]?.allTime?.gross != null) continue;
    const own = ownRunTotals(history, show, opts);
    if (own && own.status === 'complete' && !mayPredateHistory(history, own)) out.push({ slug, gross: own.gross, weeks: own.weeks });
  }
  return out;
}

/**
 * A closed production's own row is final. A larger row for the same title is
 * BroadwayWorld's total over several runs (Fela! 2009 + 2012 = 529 shows), not
 * a newer copy of that production's, so it must not overwrite it. A running
 * target (Chicago 1996) does take the larger, fresher row.
 */
function holdsOwnFinalRow(grossesShows, target, source, nowMs) {
  const own = grossesShows?.[target.slug || target.id]?.allTime;
  const incoming = grossesShows?.[source.slug || source.id]?.allTime;
  if (!own || !own.gross || own.gross === incoming?.gross) return false;
  const closed = toMs(target.closingDate);
  return closed != null && closed < nowMs;
}

/**
 * Rows still on a Broadway run that cannot hold their count after the moves:
 * a total over several runs that no single production played (Beetlejuice
 * 2019 + 2022 + 2025 = 806 shows on all three slugs). It is no production's
 * figure, so each such copy is cleared rather than shown as one run's.
 * @returns {Array<{slug:string, owner:null, reason:string}>}
 */
function unholdableAllTimeClears(grossesShows, shows, { now = new Date() } = {}) {
  const nowMs = now.getTime();
  const clears = [];
  for (const s of shows || []) {
    if (!s || !isBroadway(s)) continue;
    const slug = s.slug || s.id;
    const a = grossesShows?.[slug]?.allTime;
    if (!a || !a.gross || !a.performances) continue;
    const cap = runCapacity(s, nowMs);
    if (cap == null || canHold(a.performances, cap)) continue;
    clears.push({ slug, owner: null, reason: `run ${s.previewsStartDate || s.openingDate}..${s.closingDate || 'now'} cannot hold ${a.performances} performances and no other run takes the row; a total over several runs` });
  }
  return clears.sort((x, y) => x.slug.localeCompare(y.slug));
}

module.exports = { applyAllTimeAttribution, sharedAllTimeClears, misplacedAllTimeMoves, unholdableAllTimeClears, ownRunTotals, fillClearedFromHistory, closedRunsMissingAllTime, runCapacity, constants:{ PERFS_PER_WEEK, FIT_SLACK_RATIO, FIT_SLACK_PERFS, FIT_MIN_SHARE } };
