/**
 * The /box-office market page (BRO-5007 v3): turns the market maths in
 * box-office-market.ts into one plain, serializable object with every sentence
 * already written. Numbers come from the Broadway League history only; nothing
 * here leans on a cost estimate (that lives on /biz and the Commercial
 * Scorecard). Unreleased: only reachable when featureFlags.commercial &&
 * boxOfficeV2.
 */
import {
  type MarketInput,
  type Mover,
  marketSummary,
  marketWeek,
  movers,
  perSeatTable,
  sellOutStreaks,
  premiumPull,
  historicPace,
  marketPerSeatByWeek,
  newMusicalCohort,
  runPerSeatSeries,
  isComparableRun,
  weekOfRun,
  PACE_MIN_WEEK,
  PACE_MAX_WEEK,
} from './box-office-market';
import {
  addDays,
  isPaired,
  isFullWeek,
  isReported,
  lastReportedWeeks,
  grossPerSeat,
  pctChange,
  priorSeason,
  seasonFirstWeek,
  seasonOfWeek,
  yearAgoWeek,
  TRAILING_WEEKS,
} from './box-office-weeks';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "2024-2025" → "2024–25". */
export function seasonLabel(season: string): string {
  return `${season.slice(0, 4)}–${season.slice(7, 9)}`;
}

/** $27.7M / $2.70M / $773K: market totals one decimal, show grosses two. */
export function money(n: number, digits = 2): string {
  if (Math.abs(n) >= 999_500) return `$${(n / 1_000_000).toFixed(digits)}M`;
  return `$${Math.round(n / 1000)}K`;
}

/** Whole-number percent, sign as an arrow word for prose: "6%". */
function pct(n: number): string {
  return `${Math.round(Math.abs(n))}%`;
}

/** Title shortened for chart labels: "Stranger Things: The First Shadow" → "Stranger Things". */
export function shortTitle(title: string): string {
  const cut = title.split(/[:(;]/)[0].trim();
  return cut.length >= 3 ? cut : title;
}

// ------------------------------------------------------------------
// The market story
// ------------------------------------------------------------------

/** Season-of-year word for a week ending: summer, fall, winter or spring. */
export function partOfYear(week: string): string {
  const m = Number(week.slice(5, 7));
  if (m >= 7 && m <= 8) return 'summer';
  if (m >= 9 && m <= 11) return 'fall';
  if (m === 12 || m <= 2) return 'winter';
  return 'spring';
}

/** A season-pace gap smaller than this reads as "about the same". */
export const PACE_FLAT_PCT = 2;

/**
 * "A soft fall so far. Broadway is running 6% behind last season's pace but
 * still ahead of 2024–25." Null without last season's comparable weeks.
 */
export function seasonPaceSentence(week: string, vsLast: number | null, vsTwoBack: number | null, twoBack: string): string | null {
  if (vsLast == null) return null;
  const part = partOfYear(week);
  const flat = Math.abs(vsLast) < PACE_FLAT_PCT;
  const lead = flat ? `A steady ${part} so far.` : vsLast < 0 ? `A soft ${part} so far.` : `A strong ${part} so far.`;
  let body = flat
    ? 'Broadway is on about the same pace as last season'
    : `Broadway is running ${pct(vsLast)} ${vsLast < 0 ? 'behind' : 'ahead of'} last season’s pace`;
  if (vsTwoBack != null && Math.abs(vsTwoBack) >= PACE_FLAT_PCT) {
    const ahead = vsTwoBack > 0;
    const label = seasonLabel(twoBack);
    if (flat) body += ` and ${ahead ? 'ahead of' : 'behind'} ${label}`;
    else if (ahead === vsLast > 0) body += ` and ${ahead ? 'ahead of' : 'behind'} ${label} too`;
    else body += ` but still ${ahead ? 'ahead of' : 'behind'} ${label}`;
  }
  return `${lead} ${body}.`;
}

/** A drop from the season's best week this large is worth explaining. */
export const CLOSINGS_DROP_SHARE = 0.1;

export interface Closing {
  title: string;
  /** Its gross in the season's best week. */
  gross: number;
}

/** "early August" / "mid-August" / "late August". */
export function partOfMonth(week: string): string {
  const d = Number(week.slice(8, 10));
  const month = MONTHS[Number(week.slice(5, 7)) - 1];
  return d <= 10 ? `early ${month}` : d <= 20 ? `mid-${month}` : `late ${month}`;
}

/**
 * "Most of the drop since mid-August is two big closings: A ($2.5M a week)
 * and B ($1.8M)." Only when this week is at least 10% under the season's best
 * week so far and the shows that have since closed account for at least half
 * of that drop.
 */
export function closingsSentence(peakWeek: string, peakGross: number, nowGross: number, closings: Closing[]): string | null {
  const drop = peakGross - nowGross;
  if (drop < peakGross * CLOSINGS_DROP_SHARE || !closings.length) return null;
  const sorted = [...closings].sort((a, b) => b.gross - a.gross);
  if (sorted.reduce((s, c) => s + c.gross, 0) < drop / 2) return null;
  const since = `Most of the drop since ${partOfMonth(peakWeek)}`;
  const [a, b] = sorted;
  if (sorted.length === 1) return `${since} is one big closing: ${a.title} (${money(a.gross, 1)} a week).`;
  if (sorted.length === 2) return `${since} is two big closings: ${a.title} (${money(a.gross, 1)} a week) and ${b.title} (${money(b.gross, 1)}).`;
  return `${since} is closings, led by ${a.title} (${money(a.gross, 1)} a week) and ${b.title} (${money(b.gross, 1)}).`;
}

// ------------------------------------------------------------------
// Smaller sentences
// ------------------------------------------------------------------

export interface MoverRow {
  slug: string;
  title: string;
  pct: number;
  gross: number;
  /** "same 8 shows · capacity 96%" or "7 shows vs 3 last week · per show ▼17%". */
  note: string;
}

export function moverNote(m: Mover): string {
  if (m.performances != null && m.prevPerformances != null && m.performances !== m.prevPerformances) {
    const per = m.perShowPct == null ? '' : ` · per show ${m.perShowPct >= 0 ? '▲' : '▼'}${pct(m.perShowPct)}`;
    return `${m.performances} shows vs ${m.prevPerformances} last week${per}`;
  }
  const same = m.performances != null ? `same ${m.performances} shows` : 'same schedule';
  return m.capacity != null ? `${same} · capacity ${Math.round(m.capacity)}%` : same;
}

/** A rank jump this big between gross and per seat earns a sentence. */
export const RANK_JUMP_MIN = 3;

/** "Ranked by gross, Oh, Mary! is #6. Per seat, it is #2." for the biggest climber in the per-seat top 6. */
export function rankJumpSentence(rows: Array<{ title: string; grossRank: number }>): string | null {
  let best: { title: string; grossRank: number; seatRank: number } | null = null;
  rows.slice(0, 6).forEach((r, i) => {
    const jump = r.grossRank - (i + 1);
    if (jump >= RANK_JUMP_MIN && (!best || jump > best.grossRank - best.seatRank)) best = { ...r, seatRank: i + 1 };
  });
  if (!best) return null;
  const b = best as { title: string; grossRank: number; seatRank: number };
  return `Ranked by gross, ${b.title} is #${b.grossRank}. Per seat, it is #${b.seatRank}.`;
}

/** How a show's gross per seat compares with the typical new musical at the same week. */
export function cohortCompare(mine: number, typical: number): string {
  const ratio = mine / typical;
  if (ratio >= 1.15) return 'well above';
  if (ratio >= 1.05) return 'a little above';
  if (ratio > 0.95) return 'about the same as';
  if (ratio > 0.85) return 'a little below';
  return 'well below';
}

export function cohortSentence(lines: Array<{ title: string; week: number; perSeat: number; typical: number }>): string | null {
  if (!lines.length) return null;
  return lines
    .map((l) => {
      const cmp = cohortCompare(l.perSeat, l.typical);
      const tail = `${cmp} the typical new musical still running at that point`;
      return `In week ${l.week}, ${shortTitle(l.title)} takes in about $${Math.round(l.perSeat)} a seat, ${tail} ($${Math.round(l.typical)}).`;
    })
    .join(' ');
}

// ------------------------------------------------------------------
// The page
// ------------------------------------------------------------------

/** Current new musicals drawn on the cohort chart (one colour each). */
export const COHORT_MAX_CURRENT = 4;

/** Historic pace lists only shows that outsold at least this share of past runs. */
export const PACE_STANDOUT_MIN_PCT = 50;

export interface MarketPage {
  week: string;
  tiles: {
    gross: number;
    lastWeekPct: number | null;
    lastYearGross: number | null;
    lastYearPct: number | null;
    seasonWeeks: number;
    seasonGross: number | null;
    vsLastSeasonPct: number | null;
    vsTwoBackPct: number | null;
    twoBackLabel: string;
    shows: number;
    topFourShare: number;
  };
  story: string | null;
  seasonChart: {
    firstWeek: string;
    thisSeason: Array<number | null>;
    lastSeason: Array<number | null>;
    range: Array<{ min: number; max: number } | null>;
    thisLabel: string;
    lastLabel: string;
    rangeLabel: string;
  };
  share: { top: Array<{ title: string; gross: number; share: number }>; otherCount: number; otherShare: number };
  movers: { gains: MoverRow[]; drops: MoverRow[] };
  perSeat: {
    rows: Array<{ slug: string; title: string; perSeat: number; grossRank: number; seats: number | null }>;
    ranked: number;
    tooNew: Array<{ title: string; perSeat: number }>;
    jump: string | null;
  };
  streaks: Array<{ title: string; weeks: number }>;
  premium: { median: number | null; rows: Array<{ title: string; over: number; isNew: boolean }> };
  pace: Array<{ title: string; beatsPct: number; week: number }>;
  priceMap: Array<{ slug: string; title: string; label: string; capacity: number; atp: number; seats: number }>;
  cohort: {
    musicals: number;
    fromYear: number;
    weeks: number;
    band: Array<{ p25: number; median: number; p75: number } | null>;
    lines: Array<{ title: string; kind: 'example' | 'current'; tag: string | null; series: Array<number | null> }>;
    story: string | null;
  };
  /** The full table's added columns, keyed by slug. */
  table: Record<string, { perSeat: number | null; yoyPct: number | null; isNew: boolean }>;
}

/** Past new musicals drawn on the cohort chart, with their outcome on the Commercial Scorecard. */
export const COHORT_EXAMPLES = ['dear-evan-hansen-2016', 'come-from-away-2017', 'king-kong-2018'];

/** Weeks the cohort chart spans at most. */
export const COHORT_CHART_MAX_WEEKS = 52;

export function buildMarketPage(
  input: MarketInput,
  week: string,
  opts: { designationOf?: (slug: string) => string | null | undefined } = {},
): MarketPage | null {
  const s = marketSummary(input, week);
  if (!s) return null;
  const title = (slug: string) => input.shows.get(slug)?.title ?? slug;
  const [last, twoBack] = s.season.prior;
  const vsLast = last?.gross && s.season.gross != null ? pctChange(s.season.gross, last.gross) : null;
  const vsTwoBack = twoBack?.gross && s.season.gross != null ? pctChange(s.season.gross, twoBack.gross) : null;

  // Season chart: this season so far, last season whole, the range of the three before.
  const season = s.season.season;
  const weeksOf = (sea: string, through?: string) => {
    const out: Array<number | null> = [];
    const next = seasonFirstWeek(priorSeason(sea, -1));
    for (let w = seasonFirstWeek(sea); w < next && (!through || w <= through); w = addDays(w, 7)) out.push(marketWeek(input, w)?.gross ?? null);
    return out;
  };
  const thisSeason = weeksOf(season, week);
  const lastSeason = weeksOf(priorSeason(season, 1));
  const before = [2, 3, 4].map((k) => weeksOf(priorSeason(season, k)));
  const range = Array.from({ length: Math.max(...before.map((b) => b.length)) }, (_, i) => {
    const v = before.map((b) => b[i]).filter((x): x is number => x != null);
    return v.length === before.length ? { min: Math.min(...v), max: Math.max(...v) } : null;
  });

  // Story: season pace, then closings since the season's best week.
  let peak: { week: string; gross: number } | null = null;
  for (let i = 0; i < thisSeason.length - 1; i++) {
    const g = thisSeason[i];
    if (g != null && (!peak || g > peak.gross)) peak = { week: addDays(seasonFirstWeek(season), 7 * i), gross: g };
  }
  let closings: Closing[] = [];
  if (peak) {
    const recent = [week, addDays(week, -7), addDays(week, -14)];
    closings = Object.entries(input.weeks[peak.week] ?? {})
      .filter(([slug, r]) => isReported(r) && !recent.some((w) => isReported(input.weeks[w]?.[slug])))
      .map(([slug, r]) => ({ title: title(slug), gross: r.gross as number }));
  }
  const story = [
    seasonPaceSentence(week, vsLast, vsTwoBack, twoBack?.season ?? priorSeason(season, 2)),
    peak ? closingsSentence(peak.week, peak.gross, s.gross, closings) : null,
  ].filter(Boolean).join(' ') || null;

  const top = s.ranked.slice(0, 4).map((r) => ({ title: title(r.slug), gross: r.gross, share: r.gross / s.gross }));

  const mv = movers(input, week);
  const moverRow = (m: Mover): MoverRow => ({ slug: m.slug, title: title(m.slug), pct: m.pct, gross: m.gross, note: moverNote(m) });

  const ps = perSeatTable(input, week);
  const perSeatRows = ps.ranked.map((r) => ({ slug: r.slug, title: title(r.slug), perSeat: r.perSeat, grossRank: r.grossRank, seats: r.seats }));

  const pp = premiumPull(input, week);
  const pace = historicPace(input, week, marketPerSeatByWeek(input)).filter((p) => p.beatsPct >= PACE_STANDOUT_MIN_PCT)
    .map((p) => ({ title: title(p.slug), beatsPct: p.beatsPct, week: p.week }));

  const priceMap = Object.entries(input.weeks[week] ?? {})
    .filter(([slug, r]) => isPaired(r) && r.capacity != null && r.atp != null && r.performances && (input.shows.get(slug)?.category ?? 'broadway') === 'broadway')
    .map(([slug, r]) => ({ slug, title: title(slug), label: shortTitle(title(slug)), capacity: r.capacity as number, atp: r.atp as number, seats: Math.round((r.seatsOffered as number) / (r.performances as number)) }));

  // Cohort: new musicals running now that are past week 4, against the middle half since 2016.
  const current = Array.from(input.shows.values())
    .filter((sh) => isComparableRun(sh) && sh.type === 'musical' && !sh.isRevival && isReported(input.weeks[week]?.[sh.slug]))
    .map((sh) => ({ sh, k: weekOfRun(sh.previewsStartDate!, week) }))
    .filter((c) => c.k >= PACE_MIN_WEEK && c.k <= COHORT_CHART_MAX_WEEKS)
    // The newest few, so each line keeps its own colour.
    .sort((a, b) => a.k - b.k || a.sh.slug.localeCompare(b.sh.slug))
    .slice(0, COHORT_MAX_CURRENT);
  const chartWeeks = Math.min(COHORT_CHART_MAX_WEEKS, Math.max(30, ...current.map((c) => c.k + 2)));
  const cohort = newMusicalCohort(input, week, chartWeeks);
  const lines: MarketPage['cohort']['lines'] = [];
  for (const slug of COHORT_EXAMPLES) {
    const sh = input.shows.get(slug);
    if (!sh || !isComparableRun(sh)) continue;
    lines.push({ title: sh.title, kind: 'example', tag: opts.designationOf?.(slug) ?? null, series: runPerSeatSeries(input, sh, chartWeeks) });
  }
  const storyLines: Array<{ title: string; week: number; perSeat: number; typical: number }> = [];
  for (const { sh } of current) {
    const series = runPerSeatSeries(input, sh, chartWeeks, week);
    lines.push({ title: sh.title, kind: 'current', tag: null, series });
    for (let i = series.length - 1; i >= 0; i--) {
      const v = series[i];
      const b = cohort.band[i];
      if (v != null && b) { storyLines.push({ title: sh.title, week: i + 1, perSeat: v, typical: b.median }); break; }
    }
  }

  const table: MarketPage['table'] = {};
  for (const { slug } of s.ranked) {
    const row = (w: string) => input.weeks[w]?.[slug];
    const yaw = yearAgoWeek((w) => isFullWeek(row(w)), week);
    const now = row(week);
    const perSeat = grossPerSeat(lastReportedWeeks(row, week));
    table[slug] = {
      perSeat,
      yoyPct: yaw ? pctChange(now?.gross, row(yaw)?.gross) : null,
      isNew: !yaw && lastReportedWeeks(row, week).length < TRAILING_WEEKS,
    };
  }

  return {
    week,
    tiles: {
      gross: s.gross,
      lastWeekPct: s.lastWeekPct,
      lastYearGross: s.lastYearGross,
      lastYearPct: s.lastYearPct,
      seasonWeeks: s.season.weeks,
      seasonGross: s.season.gross,
      vsLastSeasonPct: vsLast,
      vsTwoBackPct: vsTwoBack,
      twoBackLabel: seasonLabel(twoBack?.season ?? priorSeason(season, 2)),
      shows: s.shows,
      topFourShare: s.topFourShare,
    },
    story,
    seasonChart: {
      firstWeek: seasonFirstWeek(season),
      thisSeason,
      lastSeason,
      range,
      thisLabel: seasonLabel(season),
      lastLabel: seasonLabel(priorSeason(season, 1)),
      rangeLabel: `${seasonLabel(priorSeason(season, 4)).slice(0, 4)}–${seasonLabel(priorSeason(season, 2)).slice(5)}`,
    },
    share: { top, otherCount: Math.max(0, s.shows - top.length), otherShare: Math.max(0, 1 - top.reduce((t, x) => t + x.share, 0)) },
    movers: { gains: mv.gains.map(moverRow), drops: mv.drops.map(moverRow) },
    perSeat: {
      rows: perSeatRows,
      ranked: perSeatRows.length,
      tooNew: ps.tooNew.map((r) => ({ title: title(r.slug), perSeat: r.perSeat })),
      jump: rankJumpSentence(perSeatRows),
    },
    streaks: sellOutStreaks(input, week).map((x) => ({ title: title(x.slug), weeks: x.weeks })),
    premium: { median: pp.median, rows: pp.above.map((x) => ({ title: title(x.slug), over: x.over, isNew: x.isNew })) },
    pace,
    priceMap,
    cohort: {
      musicals: cohort.musicals,
      fromYear: cohort.fromYear,
      weeks: chartWeeks,
      band: cohort.band.map((b) => (b ? { p25: b.p25, median: b.median, p75: b.p75 } : null)),
      lines,
      story: cohortSentence(storyLines),
    },
    table,
  };
}

export { PACE_MIN_WEEK, PACE_MAX_WEEK, seasonOfWeek };
