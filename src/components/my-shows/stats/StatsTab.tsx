'use client';
/**
 * Stats tab on web My Shows (BRO-6170 design prototype): the iOS Stats screen
 * re-expressed in the website's visual language.
 *
 * Owns three things: the active scope, the module order (scope → scorecard →
 * shows per year → theaters → critics (+ gold, audience) → Aisle Mates →
 * canon → ratings), and the drill-down payload each module hands back. All
 * maths lives in @/lib/stats (shared engine) and @/lib/stats-ui (ported app
 * helpers) behind computeStatsBundle; nothing here computes a statistic.
 */

import { Component, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { UserReview, ShowLookup } from '@/types/user';
import { matchVenueToHouse, type CanonEntry, type HouseVisit, type StatsCanon, type StatsReviews } from '@/lib/stats';
import {
  EMPTY_CANON,
  HOUSE_INDEX,
  MIN_ENTRIES_FOR_STATS,
  computeStatsBundle,
  decodeStatsShowsStrict,
  mergeShows,
  type StatsShow,
} from '@/lib/stats-ui/bundle';
import { localToday, scopeSuffix, type ScopeOption } from '@/lib/stats-ui/scope';
import { reviewerDetail, type Reviewer } from '@/lib/stats-ui/aisle-mates';
import { formatHours, formatMonth, houseShortName } from '@/lib/stats-ui/format';
import ScopePill from './ScopePill';
import HeroTiles, { type HeroTile } from './HeroTiles';
import ShowsPerYear from './ShowsPerYear';
import TheaterTracker, { type HouseRecord } from './TheaterTracker';
import { AudienceCard, GoldCard, YouVsCritics } from './YouVsCritics';
import AisleMates from './AisleMates';
import CanonChecklists, { type CanonFilter } from './CanonChecklists';
import RatingsModule from './RatingsModule';
import StatsDrilldown, { type DrilldownPayload } from './StatsDrilldown';
import type { DataState } from './primitives';

export interface StatsTabProps {
  reviews: UserReview[];
  showMap: Record<string, ShowLookup>;
  isMockMode: boolean;
}

type Load<T> = { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error' };

/** A data file still pending after this long counts as failed (module shows Retry). */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Fetch a static JSON file under /data once per mount, with a timeout and a
 * retry. A non-2xx, a malformed body, a parse() throw or a timeout all land
 * in 'error' — never an unhandled rejection or an endless spinner.
 */
function useStaticJson<T>(path: string, parse: (raw: unknown) => T): [Load<T>, () => void] {
  const [state, setState] = useState<Load<T>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, FETCH_TIMEOUT_MS);
    setState({ status: 'loading' });
    fetch(path, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((raw) => setState({ status: 'ready', data: parse(raw) }))
      .catch((e) => {
        // An abort from unmount/re-run is not a failure; one from the timer is.
        if (timedOut || (e as Error).name !== 'AbortError') setState({ status: 'error' });
      })
      .finally(() => clearTimeout(timer));
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // parse is a module-level function; path is a constant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return [state, retry];
}

const parseCanon = (raw: unknown): StatsCanon => {
  const d = (raw ?? {}) as Partial<StatsCanon>;
  return {
    ceremonies: Array.isArray(d.ceremonies) ? d.ceremonies : [],
    bestMusical: Array.isArray(d.bestMusical) ? d.bestMusical : [],
    bestPlay: Array.isArray(d.bestPlay) ? d.bestPlay : [],
  };
};
const parseReviews = (raw: unknown): StatsReviews => {
  const d = (raw ?? {}) as Partial<StatsReviews>;
  return {
    critics: Array.isArray(d.critics) ? d.critics : [],
    outlets: Array.isArray(d.outlets) ? d.outlets : [],
    shows: d.shows && typeof d.shows === 'object' ? d.shows : {},
  };
};

const byDateDesc = (a: UserReview, b: UserReview) => (b.date_seen ?? '').localeCompare(a.date_seen ?? '');

/** Last line of defence: a render bug in one module must not blank My Shows. */
class StatsErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error('[stats] render failed', error);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="card px-6 py-10 text-center" data-testid="stats-crashed">
        <h3 className="text-lg font-bold text-white">Your stats hit a snag</h3>
        <p className="text-sm text-gray-400 mt-2">Your diary is safe. Try loading the stats again.</p>
        <button type="button" onClick={() => this.setState({ failed: false })} className="btn-secondary text-sm min-h-[44px] mt-5">
          Try again
        </button>
      </div>
    );
  }
}

export default function StatsTab(props: StatsTabProps) {
  return (
    <StatsErrorBoundary>
      <StatsTabContent {...props} />
    </StatsErrorBoundary>
  );
}

const loadState = (l: Load<unknown>): DataState => (l.status === 'ready' ? 'ready' : l.status);

function StatsTabContent({ reviews, showMap }: StatsTabProps) {
  const today = useMemo(() => localToday(), []);
  const [canonLoad, retryCanon] = useStaticJson('/data/stats-canon.json', parseCanon);
  const [reviewsLoad, retryReviews] = useStaticJson('/data/stats-reviews.json', parseReviews);
  // Slim web catalog (scripts/generate-stats-shows.js): critic score + review
  // count, audience grade, status — projected from the iOS app's catalog.
  const [catalogLoad, retryCatalog] = useStaticJson('/data/stats-shows.json', decodeStatsShowsStrict);

  // Only the FIRST canon load gates the page; a retry after a failure keeps
  // the rest of the view on screen.
  const [canonSettled, setCanonSettled] = useState(false);
  useEffect(() => {
    if (canonLoad.status !== 'loading') setCanonSettled(true);
  }, [canonLoad.status]);

  const [scope, setScope] = useState<ScopeOption | null>(null);
  const [drill, setDrill] = useState<DrilldownPayload | null>(null);

  const canon = canonLoad.status === 'ready' ? canonLoad.data : EMPTY_CANON;
  const statsReviews = reviewsLoad.status === 'ready' ? reviewsLoad.data : null;
  const catalog = catalogLoad.status === 'ready' ? catalogLoad.data : null;
  const shows = useMemo(() => mergeShows(showMap, catalog ?? []), [showMap, catalog]);

  const bundle = useMemo(
    () => computeStatsBundle({ reviews, shows, canon, statsReviews, scope, today }),
    [reviews, shows, canon, statsReviews, scope, today],
  );
  const { scope: active, reviewsInScope, diary, theaters } = bundle;

  const sortedInScope = useMemo(() => [...reviewsInScope].sort(byDateDesc), [reviewsInScope]);
  /** Lifetime modules (theaters, canon, gold, audience, Aisle Mates) drill into the whole diary. */
  const sortedAll = useMemo(() => [...reviews].sort(byDateDesc), [reviews]);
  const reviewsFor = useCallback(
    (ids: Iterable<string>, from: UserReview[] = sortedInScope) => {
      const wanted = new Set(ids);
      return from.filter((r) => wanted.has(r.show_id));
    },
    [sortedInScope],
  );
  const houseOf = useCallback(
    (showId: string) => matchVenueToHouse(shows[showId]?.venue, HOUSE_INDEX, { category: shows[showId]?.category }),
    [shows],
  );
  const selectYear = useCallback(
    (year: number) => {
      const target = bundle.scopes.find((s) => s.kind === 'year' && s.year === year);
      if (target) setScope(target);
    },
    [bundle.scopes],
  );

  // Canon gates first paint: season scopes come from its ceremony dates. If it
  // fails (or times out) the page renders without seasons and the canon
  // module offers a retry.
  if (!canonSettled && canonLoad.status === 'loading') {
    return (
      <div className="flex justify-center py-16" aria-busy="true">
        <div className="w-6 h-6 rounded-full border-2 border-brand border-t-transparent animate-spin" />
      </div>
    );
  }

  if (bundle.allRows.length < MIN_ENTRIES_FOR_STATS) {
    const logged = bundle.allRows.length;
    return (
      <div className="card px-6 py-10 text-center" data-testid="stats-ghost">
        <div className="flex items-end gap-2 h-24 max-w-xs mx-auto mb-6" aria-hidden="true">
          {[0.35, 0.6, 0.45, 0.8, 0.55, 0.9, 0.5].map((h, i) => (
            <div key={i} className="flex-1 rounded-t bg-surface-overlay" style={{ height: `${h * 100}%` }} />
          ))}
        </div>
        <h3 className="text-lg font-bold text-white">Log {MIN_ENTRIES_FOR_STATS - logged} more to open your Scorecard</h3>
        <p className="text-sm text-gray-400 mt-2">
          Stats need at least {MIN_ENTRIES_FOR_STATS} shows in your diary. You have {logged}.
        </p>
      </div>
    );
  }

  const suffix = scopeSuffix(active);
  const lifetimeSuffix = active.kind === 'all' ? '' : ' · all time';
  const open = (p: DrilldownPayload) => setDrill(p);
  const catalogShows = (ids: string[]) => ids.map((id) => shows[id]).filter((s): s is StatsShow => !!s);

  // ── Drill-down handlers (ported from iOS StatsScreen) ────────────────
  const openHero = (which: HeroTile) => {
    if (which === 'hours') {
      open({
        title: 'Hours in a seat',
        caption: `${formatHours(diary.minutesInSeat)} across ${diary.total} entries${suffix}`,
        reviews: sortedInScope,
        facts: [
          { label: 'Total', value: formatHours(diary.minutesInSeat) },
          { label: 'Average show', value: formatHours(Math.round(diary.minutesInSeat / Math.max(diary.total, 1))) },
          { label: 'Estimated', value: `${Math.round(diary.runtimeFallbackShare * 100)}%` },
        ],
      });
    } else if (which === 'theaters') {
      open({
        title: 'Theaters',
        caption: `${diary.distinctTheaters} venues${suffix} · ${diary.distinctBroadwayHouses} Broadway houses`,
        reviews: sortedInScope,
        groupByVenue: true,
      });
    } else {
      open({
        title: which === 'period' ? 'Every year you logged' : `Shows${suffix || ', all time'}`,
        caption: `${diary.total} ${diary.total === 1 ? 'entry' : 'entries'}`,
        reviews: sortedInScope,
      });
    }
  };

  const openMonth = (monthKey: string) => {
    const rows = sortedInScope.filter((r) => (r.date_seen ?? '').startsWith(monthKey));
    open({ title: formatMonth(monthKey), caption: `${rows.length} ${rows.length === 1 ? 'show' : 'shows'}`, reviews: rows });
  };

  const openRecord = (kind: 'busiest' | 'streak') => {
    if (kind === 'busiest' && diary.busiestMonth) return openMonth(diary.busiestMonth.month);
    if (kind === 'streak' && diary.currentStreak > 0) {
      const months = diary.byMonth.slice(-diary.currentStreak).map((m) => m.month);
      open({
        title: 'Current streak',
        caption: `${diary.currentStreak} months in a row with at least one show`,
        reviews: sortedInScope.filter((r) => months.some((m) => (r.date_seen ?? '').startsWith(m))),
      });
    }
  };

  const openHouse = (house: HouseVisit) => {
    const rows = sortedAll.filter((r) => houseOf(r.show_id) === house.name);
    open({
      title: house.name,
      caption: house.visited ? `${house.count} ${house.count === 1 ? 'visit' : 'visits'}${lifetimeSuffix}` : 'You have not been here yet',
      reviews: rows,
      shows: house.visited
        ? undefined
        : Object.values(shows).filter(
            (s) => (s.status === 'open' || s.status === 'previews') && matchVenueToHouse(s.venue, HOUSE_INDEX, { category: s.category }) === house.name,
          ),
      facts: [
        { label: 'Capacity', value: house.capacity ? house.capacity.toLocaleString('en-US') : '–' },
        { label: 'Opened', value: house.yearBuilt ? String(house.yearBuilt) : '–' },
        { label: 'Your visits', value: String(house.count) },
      ],
      emptyText: house.visited ? 'No shows logged here yet.' : 'Nothing playing here right now.',
    });
  };

  const openHouseRecord = (kind: HouseRecord) => {
    const rec = theaters.records[kind === 'home' ? 'homeTheater' : kind];
    if (rec) openHouse(rec);
  };

  const openRing = () => {
    const visited = theaters.houses.filter((h) => h.visited).map((h) => houseShortName(h.name));
    open({
      title: `${theaters.visited} of ${theaters.operating} Broadway houses`,
      caption: visited.join(' · '),
      reviews: sortedAll.filter((r) => !!houseOf(r.show_id)),
      groupByVenue: true,
    });
  };

  const openExtraCredit = () => {
    const venues = new Set(theaters.extraCredit.map((e) => e.venue));
    open({
      title: 'Beyond Broadway',
      caption: `${venues.size} Off-Broadway and other venues${lifetimeSuffix}`,
      reviews: sortedAll.filter((r) => venues.has(shows[r.show_id]?.venue ?? '')),
      groupByVenue: true,
    });
  };

  const openAligned = () =>
    open({
      title: bundle.critics.label,
      caption: `${bundle.critics.aligned} of ${bundle.critics.comparable} shows within 10 points of the critics`,
      reviews: reviewsFor(bundle.critics.alignedShowIds),
    });

  const openPick = (showId: string) =>
    open({ title: shows[showId]?.title ?? 'Show', caption: 'Your rating vs. the critics', reviews: reviewsFor([showId], sortedAll) });

  const openGold = (which: 'seen' | 'unseen') => {
    const { gold } = bundle;
    if (which === 'seen') {
      open({
        title: 'Critical Gold you have seen',
        caption: `${gold.seen} of ${gold.total} open now`,
        reviews: reviewsFor(gold.seenShowIds, sortedAll),
      });
    } else {
      open({
        title: 'Critical Gold to see',
        caption: `${gold.unseen.length} open shows scoring at Critical Gold`,
        shows: catalogShows(gold.unseen.map((g) => g.id)),
        emptyText: 'You have seen every Critical Gold show open right now.',
      });
    }
  };

  const openAudience = () =>
    open({
      title: 'The audience & you',
      caption: `${bundle.audience.aligned} of ${bundle.audience.comparable} shows within a grade of the audience`,
      reviews: reviewsFor(bundle.audience.alignedShowIds, sortedAll),
    });

  const openReviewer = (who: Reviewer, label: string) => {
    if (!statsReviews) return;
    const detail = reviewerDetail(bundle.allRows, statsReviews, who);
    const scoreOverrides: Record<string, number> = {};
    for (const s of detail.shared) scoreOverrides[s.showId] = s.theirScore;
    for (const u of detail.unseen) scoreOverrides[u.showId] = u.theirScore;
    const facts = [
      detail.biggestAgreementShowId ? { label: 'Closest call', value: shows[detail.biggestAgreementShowId]?.title ?? '–' } : null,
      detail.biggestFightShowId ? { label: 'Biggest fight', value: shows[detail.biggestFightShowId]?.title ?? '–' } : null,
      { label: 'Shows together', value: String(detail.shared.length) },
    ].filter((f): f is { label: string; value: string } => f !== null);
    open({
      title: label,
      caption: `Scores shown are ${who.kind === 'critic' ? 'their' : 'the outlet’s'} own, not the site average`,
      reviews: reviewsFor(
        detail.shared.map((s) => s.showId),
        sortedAll,
      ),
      shows: catalogShows(detail.unseen.slice(0, 10).map((u) => u.showId)),
      showsLabel: 'Their picks you haven’t seen',
      scoreOverrides,
      facts,
      emptyText: 'No shared shows yet.',
    });
  };

  const openCanonList = (which: 'musical' | 'play', filter: CanonFilter) => {
    const list = which === 'musical' ? bundle.canonStats.bestMusical : bundle.canonStats.bestPlay;
    const label = which === 'musical' ? 'Best Musical' : 'Best Play';
    if (filter === 'unseen') {
      const inCatalog = catalogShows(list.unseen.map((e) => e.id));
      const missing = list.unseen.length - inCatalog.length;
      open({
        title: `${label} winners to see`,
        caption: missing > 0 ? `${list.unseen.length} unseen · ${inCatalog.length} in the catalog` : `${list.unseen.length} of ${list.total}`,
        shows: inCatalog,
        emptyText: 'Every winner in the catalog is in your diary.',
      });
      return;
    }
    const entries = filter === 'before' ? list.entries.filter((e) => e.sawBeforeItWon) : list.entries.filter((e) => e.seen);
    open({
      title: filter === 'before' ? `${label}: saw it before it won` : `${label} winners you’ve seen`,
      caption: `${entries.length} of ${list.total}`,
      reviews: reviewsFor(
        entries.map((e) => e.id),
        sortedAll,
      ),
    });
  };

  const openCanonEntry = (entry: CanonEntry) => {
    if (entry.seen) {
      open({
        title: entry.t,
        caption: `${entry.season} winner${entry.sawBeforeItWon ? ', and you saw it before it won' : ''}`,
        reviews: reviewsFor([entry.id], sortedAll),
      });
    } else {
      open({
        title: entry.t,
        caption: `${entry.season} winner, not in your diary`,
        shows: catalogShows([entry.id]),
        emptyText: 'Not in the current catalog.',
      });
    }
  };

  const openBucket = (value: number) => {
    const rows = sortedInScope.filter((r) => Math.round(r.rating * 2) / 2 === value);
    open({ title: `${value}★`, caption: `${rows.length} ${rows.length === 1 ? 'show' : 'shows'}${suffix}`, reviews: rows });
  };

  const openUnrated = () => {
    const rows = sortedInScope.filter((r) => !(r.rating > 0));
    open({ title: 'Not yet rated', caption: `${rows.length} ${rows.length === 1 ? 'entry' : 'entries'} without a rating`, reviews: rows });
  };

  const catalogState = loadState(catalogLoad);

  return (
    <div className="space-y-4" data-testid="stats-tab">
      <ScopePill scopes={bundle.scopes} active={active} onChange={setScope} />
      <HeroTiles bundle={bundle} onOpen={openHero} />
      <ShowsPerYear bundle={bundle} today={today} onSelectYear={selectYear} onOpenMonth={openMonth} onOpenRecord={openRecord} />
      <TheaterTracker
        bundle={bundle}
        onOpenHouse={openHouse}
        onOpenRecord={openHouseRecord}
        onOpenRing={openRing}
        onOpenExtraCredit={openExtraCredit}
      />
      <YouVsCritics bundle={bundle} catalog={catalogState} onRetryCatalog={retryCatalog} onOpenAligned={openAligned} onOpenPick={openPick} />
      {catalogState === 'ready' && (bundle.gold.total > 0 || bundle.audience.comparable >= 5) && (
        <div className="grid sm:grid-cols-2 gap-4">
          <GoldCard bundle={bundle} onOpenGold={openGold} />
          <AudienceCard bundle={bundle} onOpen={openAudience} />
        </div>
      )}
      <AisleMates bundle={bundle} data={loadState(reviewsLoad)} onRetry={retryReviews} onOpenReviewer={openReviewer} />
      <CanonChecklists
        bundle={bundle}
        hasCanon={canon.bestMusical.length + canon.bestPlay.length > 0}
        data={loadState(canonLoad)}
        onRetry={retryCanon}
        onOpenList={openCanonList}
        onOpenEntry={openCanonEntry}
      />
      <RatingsModule bundle={bundle} onOpenBucket={openBucket} onOpenUnrated={openUnrated} />
      {diary.undated > 0 && (
        <p className="text-xs text-fg-muted px-1">
          {diary.undated} {diary.undated === 1 ? 'entry has' : 'entries have'} no date, so {diary.undated === 1 ? 'it does' : 'they do'} not appear in the
          year, month or season views.
        </p>
      )}
      <StatsDrilldown payload={drill} shows={shows} onClose={() => setDrill(null)} />
    </div>
  );
}
