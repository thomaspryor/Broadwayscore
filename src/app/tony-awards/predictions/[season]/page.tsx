import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getBroadwayShows } from '@/lib/data-core';
import { getOptimizedImageUrl } from '@/lib/images';
import { BlendedTrioDisplay, ShowListCard } from '@/components/show-cards';
import { createShowSerializer } from '@/lib/serialize-show';
import { groupShowsByTonyShape } from '@/lib/tony-season-groups';
import { generateBreadcrumbSchema, BASE_URL } from '@/lib/seo';
import { featureFlags } from '@/config/feature-flags';
import { SeasonSelect } from '@/components/SeasonSelect';
import FeaturedSpot from '@/components/FeaturedSpot';
import { CategorySection, SHOW_LEVEL_CATEGORIES } from '@/components/tony-noms/CategorySection';
import { CeremonyCountdown } from '@/components/tony/CeremonyCountdown';
import { TrackRecord } from '@/components/tony/TrackRecord';
import { PredictionRetrospective, getRetrospective } from '@/components/tony/PredictionRetrospective';
import { getNomineesByCategory, enrichMajorCategoriesWithOdds, getOddsLastUpdated } from '@/lib/data-tony-nominees';
import { tonySeasonForCeremonyYear } from '@/lib/tony-cutoffs';
import {
  getTonySeasonWindow,
  getTonySeasonWindowFor,
  getAllPredictionSeasons,
  getEligibleShows,
  getEligibleShowsForPastSeason,
  getIneligibleShows,
  groupIntoCategories,
  getSeasonOutcomes,
  getWinnersForSeason,
  hasNominationsBeenAnnounced,
  serializeShow,
  computeBlendedAccuracyStats,
  getSeasonSummary,
  getTonyTrackRecord,
  isBtcPromoActive,
} from '@/lib/data-tony-predictions';

const allSeasons = getAllPredictionSeasons();
const allSeasonLabels = allSeasons.map(s => s.label);

export function generateStaticParams() {
  return allSeasons.map(s => ({ season: s.label }));
}

export function generateMetadata({ params }: { params: { season: string } }): Metadata {
  const season = allSeasons.find(s => s.label === params.season);
  if (!season) return {};

  // A current season with no Tony nominations yet has no predictions to offer.
  // Titling that page "Predictions, Odds & Predicted Winners" is what put it in
  // Google's index for "2027 tony predictions" — someone searched that, landed
  // here, and found a single show flagged as a 100% predicted winner. Describe
  // the page as what it actually is, and keep it out of the index until the
  // model has something to say. See tony-nominees-premature, 2026-08-11.
  const preSeason = season.label === getTonySeasonWindow().label && !hasNominationsBeenAnnounced(season);

  const title = preSeason
    ? `Tony Awards ${season.ceremonyYear} — Eligible Shows So Far`
    : `Tony Awards ${season.ceremonyYear} Predictions, Odds & Predicted Winners`;
  const description = preSeason
    ? `Broadway shows that have opened in the ${season.label} Tony season so far, plus those announced without a date. Tony eligibility has not been ruled on yet and predictions are not available until nominations are announced.`
    : `${season.ceremonyYear} Tony Award odds and predicted winners for every category. Per-category model blends critic, audience, and precursor signal — tuned on 11 years of Tony history. Updated daily.`;

  return {
    title,
    description,
    ...(preSeason && { robots: { index: false, follow: true } }),
    alternates: {
      canonical: `${BASE_URL}/tony-awards/predictions/${season.label}`,
    },
    openGraph: {
      title,
      description,
      url: `${BASE_URL}/tony-awards/predictions/${season.label}`,
      type: 'article',
      images: [{ url: `${BASE_URL}/og/tony-predictions.png`, width: 1200, height: 630, alt: title }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
    },
  };
}

export default function TonySeasonPredictionsPage({ params }: { params: { season: string } }) {
  if (!featureFlags.tonyPredictions) notFound();
  if (!/^\d{4}-\d{4}$/.test(params.season)) notFound();

  const season = allSeasons.find(s => s.label === params.season);
  if (!season) notFound();

  const current = getTonySeasonWindow();
  const isCurrent = season.label === current.label;

  const allShows = getBroadwayShows();
  // Broadway shows already announced but without a confirmed opening date yet —
  // invisible to getEligibleShows() (it requires openingDate) so the current-season
  // page otherwise only shows shows that have already opened. We can't assign these
  // to a Tony season (or a category) without a date, so they're listed separately,
  // unscored, current season only. See plan in tony-nominees-premature investigation,
  // 2026-08-11 — user asked for "all Broadway shows announced for the season."
  // Exclude stale announcements. A dateless show whose previews were supposed to start
  // BEFORE this season began never happened (or quietly died) — wanted-2022 and
  // 10-things-2024 are still sitting in shows.json with 2022/2024 preview dates and
  // would otherwise render as fresh 2026-27 announcements. No previewsStartDate at all
  // is fine: that's a genuinely undated future announcement (Dreamgirls, Purple Rain).
  // Shows with previews scheduled INSIDE the season window but no openingDate yet.
  // These are unambiguously this season's shows — Paranormal Activity starts previews
  // 2026-08-14 — and listing them as "no date" was wrong. getEligibleShows can't see
  // them (it keys off openingDate), and openingDate is null because our Broadway date
  // source (IBDB) is currently returning a bot challenge, so the enrichment that would
  // fill it in is failing. Surface them with the date we DO have, labelled as previews.
  // See tony-nominees-premature, 2026-08-11.
  const previewsThisSeason = isCurrent
    ? allShows
        .filter(s => (s.status === 'announced' || s.status === 'upcoming') && !s.openingDate)
        .filter(s => s.previewsStartDate && s.previewsStartDate >= season.start && s.previewsStartDate <= season.end)
        .sort((a, b) => (a.previewsStartDate ?? '').localeCompare(b.previewsStartDate ?? ''))
    : [];

  // Truly undated: no openingDate AND no previewsStartDate. Announced, nothing scheduled.
  // (Shows with a LAPSED preview date are stale/abandoned announcements — excluded.)
  const announcedNoDate = isCurrent
    ? allShows
        .filter(s => (s.status === 'announced' || s.status === 'upcoming') && !s.openingDate && !s.previewsStartDate)
        .sort((a, b) => a.title.localeCompare(b.title))
    : [];
  // Single source of truth for accuracy stats — same function as /tony-awards/predictions overview.
  const accuracyStats = computeBlendedAccuracyStats(allShows);
  // Summaries for the collapsible Track Record block — same data used by the
  // umbrella /tony-awards/predictions page so the two stay in sync.
  const allSummaries = allSeasons.map(s => getSeasonSummary(allShows, s));
  // Source of truth for the headline (also consumed by the homepage promo).
  const trackRecord = getTonyTrackRecord(allShows);
  const trackRecordHits = trackRecord.hits;
  const trackRecordCells = trackRecord.cells;
  const trackRecordPct = trackRecord.pct;
  const blendedHits = Math.round((accuracyStats.blendedRank1WinPct / 100) * accuracyStats.categorySeasonCount);
  const criticHits = Math.round((accuracyStats.criticsOnlyRank1WinPct / 100) * accuracyStats.categorySeasonCount);

  // All 26 nominee categories (4 major + 8 performer + 14 craft) for this season.
  // Used to render performer/craft categories alongside the 4-major CategorySection rows.
  // Filter to non-empty: getNomineesByCategory uses strict-window eligibility, so
  // COVID-truncated 2020-21 (and likely 1996-97 / 1997-98) return empty arrays for
  // most non-major categories — would render an empty "Performer & Craft" header.
  const allNomineeCategories = getNomineesByCategory(season);
  const nonMajorCategories = allNomineeCategories.filter(c =>
    !SHOW_LEVEL_CATEGORIES.has(c.title) && c.shows.length > 0
  );
  const seasonRecord = tonySeasonForCeremonyYear(season.ceremonyYear);
  const ceremonyDate = seasonRecord?.ceremonyDate ?? null;
  // Once the ceremony has happened, the forward-looking "predicted winners"
  // CTA is moot — winners are known and the retrospective covers them.
  // Evaluated at build time (static export), same as the May-23 gate below.
  const ceremonyHasPassed = !!ceremonyDate && Date.now() >= new Date(`${ceremonyDate}T00:00:00Z`).getTime();
  const eligible = isCurrent
    ? getEligibleShows(allShows, season)
    : getEligibleShowsForPastSeason(allShows, season);
  const nominationsAnnounced = isCurrent && hasNominationsBeenAnnounced(season);
  // Our Pick %/Predicted Winner are real predictions, not eligibility trivia — showing
  // them for the CURRENT season before real Tony nominations exist means a single show
  // that happened to open first gets rendered as a "100%" predicted winner. Past seasons
  // (isCurrent false) keep the full reveal since those are historical results, not
  // premature predictions. See tony-nominees-premature investigation, 2026-08-11.
  const showOurPick = featureFlags.tonyPredictionsOurPick && (!isCurrent || nominationsAnnounced);
  // Use nomineesOnly mode whenever Tony nominees are known: every past season,
  // and the current season once nominations are announced. This routes shows
  // by their actual nominated category from awards.json instead of the
  // shows.json type/isRevival flags (which are sometimes mis-set).
  const useNomineesOnly = !isCurrent || nominationsAnnounced;
  // Enrich the 4 major categories with prediction-market odds (GD/Kalshi/Polymarket),
  // precursor wins, and press picks — same enrichment the Nominations Center uses —
  // so the predictions table renders the same columns instead of "—".
  const categories = enrichMajorCategoriesWithOdds(
    groupIntoCategories(eligible, useNomineesOnly ? { nomineesOnly: true, season } : undefined),
    season,
  );
  const outcomes = getSeasonOutcomes(allShows, season);

  // Shows with a confirmed opening date in this season that aren't scored yet.
  // groupIntoCategories parks these in cat.upcoming, which CategorySection never
  // renders — so before nominations they were completely invisible, and with only
  // one show scored the page showed nothing but "Predictions coming soon". These
  // are the MOST relevant shows on the page (dated, in-season, real contenders):
  // Evita, The Sound of Music, Paddington, Dolly, School Girls, Gloria, and more.
  // Deduped across categories and sorted by opening date, soonest first.
  // See tony-nominees-premature, 2026-08-11 — "list all Broadway shows announced".
  // Includes cat.shows (already opened) as well as cat.upcoming: with fewer than 2
  // scored shows the category sections don't render at all, so listing only `upcoming`
  // would still hide the one show that HAS opened. Both together = every dated show
  // in the season, which is what "list all announced shows" actually means.
  const openingThisSeason = isCurrent && !nominationsAnnounced
    ? Array.from(
        new Map(
          categories
            .flatMap(cat => [...cat.shows, ...cat.upcoming].map(s => [s.slug, s] as const))
        ).values()
      ).sort((a, b) => (a.openingDate ?? '').localeCompare(b.openingDate ?? ''))
    : [];

  // Render every season list on ShowListCard — the same component the homepage,
  // /off-broadway and /west-end use (CLAUDE.md rule 4). The bespoke two-column
  // thumbnail rows these sections used to carry had no score slot at ALL, so a
  // show with a real critic score (Celebrity Autobiography, 68.95) rendered
  // blank while the section copy promised "scores appear once each one opens".
  //
  // Serialize from the full ComputedShow rather than the SerializedTonyShow in
  // `openingThisSeason`: that shape carries no id / type / isRevival and no
  // per-tier review counts, and ScoreBadge needs the tier counts to decide
  // whether a score is publishable at all.
  const serializeCard = createShowSerializer();
  const showBySlug = new Map(allShows.map(s => [s.slug, s]));
  // A show whose previews start inside the season window belongs in the same
  // buckets as everything else: it IS a play or a musical, it IS or isn't a
  // revival, and it is unambiguously opening this season (owner, 2026-08-13).
  // Splitting it into a separate "in previews" list implied those facts were
  // unknown when only the opening DATE is. The card shows its previews date.
  const openingThisSeasonCards = [
    ...openingThisSeason
      .map(s => showBySlug.get(s.slug))
      .filter((s): s is NonNullable<typeof s> => s != null),
    ...previewsThisSeason,
    // Announced with no date at all still belongs in its category list — it is
    // a play or a musical either way, and the owner's rule is that EVERY
    // announced Broadway show appears here (2026-08-13). The card prints TBA
    // where a date would go.
    ...announcedNoDate,
  ]
    // Sort on the earliest date we actually have. Dateless shows sort last
    // rather than first, which is what an empty string would do.
    .sort((a, b) =>
      (a.openingDate || a.previewsStartDate || '9999').localeCompare(b.openingDate || b.previewsStartDate || '9999'))
    .map(s => serializeCard(s));
  // Grouped musical/play and new/revival, the shape the Tony show-level
  // categories take. Grouping is on facts we store (type, isRevival), NOT on
  // Tony eligibility — that's an Administration Committee ruling nobody has made
  // yet, which is what the disclaimer below the heading still says.
  const seasonGroups = groupShowsByTonyShape(openingThisSeasonCards);
  const awaitingOpeningNight = previewsThisSeason.length;

  // Softmax win probabilities per major category (T=7) — same logic as Nominations Center,
  // so the predictions page and /tony-awards/nominees render identical Our Pick % values.
  const T = 7;
  const categoryWinProbs = new Map<string, Map<string, number>>();
  for (const cat of categories) {
    const scored = cat.shows.filter(s => s.blendedScore != null);
    if (scored.length === 0) continue;
    const exps = scored.map(s => Math.exp(s.blendedScore! / T));
    const sumExps = exps.reduce((a, b) => a + b, 0);
    const probs = new Map<string, number>();
    scored.forEach((show, i) => probs.set(show.slug, exps[i] / sumExps));
    categoryWinProbs.set(cat.key, probs);
  }

  // Shows ruled ineligible by the Tony Administration Committee, grouped by
  // category. Surfaced as a footer under each category so visitors who looked
  // for a missing show see why it's missing rather than assuming the site
  // dropped it. Empty groups are simply not rendered.
  const ineligibleByCategory = getIneligibleShows(allShows, season).reduce<
    Record<string, Array<{ slug: string; title: string; note: string }>>
  >((acc, item) => {
    if (!acc[item.categoryKey]) acc[item.categoryKey] = [];
    acc[item.categoryKey].push({ slug: item.slug, title: item.title, note: item.note });
    return acc;
  }, {});

  const totalScored = categories.reduce((sum, cat) => sum + cat.shows.length, 0);
  const totalUpcoming = categories.reduce((sum, cat) => sum + cat.upcoming.length, 0);

  // For past seasons, compute a result summary
  const outcomeValues = Object.values(outcomes);
  const winnerCount = outcomeValues.filter(o => o === 'winner').length;

  // Build per-category report card for past seasons.
  // Winner lookup uses awards.json directly so a show whose isRevival flag
  // is mis-set in shows.json (e.g., A Soldier's Play 2020 won Best Revival
  // of a Play but is flagged isRevival:false) still appears in the right
  // category card.
  const reportCard = !isCurrent && winnerCount > 0
    ? (() => {
        const winnersByCategory = getWinnersForSeason(season);
        const showById = new Map(allShows.map(s => [s.id, s]));
        return categories.map(cat => {
          const predicted = cat.shows[0] || null;
          const winnerShowId = winnersByCategory.get(cat.title);
          const winnerShow = winnerShowId ? showById.get(winnerShowId) : null;
          const winner = winnerShow ? serializeShow(winnerShow, cat.key as Parameters<typeof serializeShow>[1]) : null;
          const correct = !!(predicted && winner && predicted.slug === winner.slug);
          const winnerRankInOurList = winner
            ? cat.shows.findIndex(s => s.slug === winner.slug)
            : -1;
          return {
            category: cat.title.replace('Best ', '').replace('Revival of a ', 'Revival '),
            categoryKey: cat.key,
            predicted,
            winner,
            correct,
            winnerRank: winnerRankInOurList >= 0 ? winnerRankInOurList + 1 : null,
          };
        }).filter(rc => rc.winner);
      })()
    : [];

  // How many of our #1 picks won? Count from the same source we render.
  const rank1Wins = reportCard.filter(rc => rc.correct).length;
  const reportCardCount = reportCard.length;
  // Map of categoryKey → 'correct' | 'missed' for the list section badges
  const categoryOutcomeStatus: Record<string, { status: 'correct' | 'missed'; winnerTitle: string; winnerRank: number | null; predictedTitle: string | null }> = {};
  for (const rc of reportCard) {
    if (!rc.winner) continue;
    categoryOutcomeStatus[rc.categoryKey] = {
      status: rc.correct ? 'correct' : 'missed',
      winnerTitle: rc.winner.title,
      winnerRank: rc.winnerRank,
      predictedTitle: rc.predicted?.title || null,
    };
  }

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Tony Awards', url: `${BASE_URL}/tony-awards` },
    { name: 'Predictions', url: `${BASE_URL}/tony-awards/predictions` },
    { name: season.label, url: `${BASE_URL}/tony-awards/predictions/${season.label}` },
  ]);

  const faqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      {
        '@type': 'Question',
        name: isCurrent && !nominationsAnnounced
          ? `Which Broadway shows are eligible for the ${season.ceremonyYear} Tony Awards?`
          : isCurrent
            ? `What Broadway shows are likely to win Tony Awards in ${season.ceremonyYear}?`
            : `Which shows won Tony Awards in the ${season.label} season?`,
        acceptedAnswer: {
          '@type': 'Answer',
          text: isCurrent && !nominationsAnnounced
            ? `The ${season.label} Tony season is still in progress. Shows are listed by Broadway opening date; the Tony Awards Administration Committee has not ruled on category eligibility yet, and Broadway Scorecard does not publish predictions for a season until nominations are announced.`
            : isCurrent
            ? `Broadway Scorecard ranks every Tony-eligible show in the ${season.label} season using a per-category blend of critic scores, audience grades, and (for Best Play) a precursor Awards Score. The model was tuned against 11 years of Tony history.`
            : winnerCount > 0
              ? `The ${season.label} Tony season saw ${winnerCount} major category winners. The #1 ranked show won ${rank1Wins} of ${winnerCount} categories.`
              : `The ${season.label} Tony season data includes all eligible shows ranked by our per-category prediction model.`,
        },
      },
      {
        '@type': 'Question',
        name: 'How are Tony predictions calculated on Broadway Scorecard?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: `Each Tony category uses its own blend recipe tuned across ${accuracyStats.seasonCount} Tony seasons. Best Musical: 45% critic + 45% audience + 10% cast acting Tony nominations count (a same-ballot voter-sentiment signal that activates after Tony nominations are announced). Best Play: 100% precursor awards combining Drama League/OCC/Drama Desk top-category signal with Pulitzer, NYDCC, and Tony nomination breadth. Best Revival of a Musical: 95% audience + 5% broad precursor signal, with weights fit by log-loss on the displayed softmax. Best Revival of a Play: 20% critic + 60% audience + 20% Awards Score. Best Musical and Best Revival of a Musical also penalize shows without a Best Direction of a Musical Tony nomination (no winner has lacked one in 11 seasons) and jukebox musicals (no wins outside the COVID-truncated 2019-20 ceremony). Across ${accuracyStats.seasonCount} seasons the model picks the eventual winner ${trackRecordHits} of ${trackRecordCells} times (${trackRecordPct}%).`,
        },
      },
      {
        '@type': 'Question',
        name: 'What is the Awards Score?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'A 0-100 score derived from a show’s nominations at the three precursor industry awards — Drama League (weighted 1.0), Outer Critics Circle (0.9), and Drama Desk (0.7). The matching top category (Outstanding Musical / Play / Revival) earns +30 × tier weight for a win or +10 × tier weight for a nomination. Other nominations are then weighted by the importance of the category — Book / Music / Lyrics / Score (A+ tier, weight 2.0), Direction / Lead Acting / Choreography (A tier, 1.5), Featured Acting / Orchestrations (B tier, 1.0), Design (C tier, 0.5). The weighted-nominations total is normalized by an eligible-pool ceiling so plays and musicals are comparable. Awards Score only contributes to the Best Play prediction; for other categories it’s shown for transparency but not weighted.',
        },
      },
      {
        '@type': 'Question',
        name: 'How often are Tony predictions updated?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'Predictions update automatically as new reviews are published and audience scores change. During awards season (April through June), rankings can shift daily as last-minute reviews come in.',
        },
      },
    ],
  };

  // ItemList per Tony category for SEO rich results.
  // - Current season: position by predicted rank (cat.shows order = blendedScore desc).
  // - Past season: actual winner at position 1, then rest by blendedScore desc.
  // - Now includes non-major (performer + craft) categories so search engines
  //   see structured data for all 26 categories, not just the top 4.
  const majorWinnersByCategory = !isCurrent ? getWinnersForSeason(season) : null;
  const showIdToSlug = new Map(allShows.map(s => [s.id, s.slug]));
  function orderForItemList(shows: typeof categories[number]['shows'], winnerSlug: string | null) {
    if (!winnerSlug) return shows.slice(0, 10);
    const winnerIdx = shows.findIndex(s => s.slug === winnerSlug);
    if (winnerIdx <= 0) return shows.slice(0, 10);
    const reordered = [shows[winnerIdx], ...shows.slice(0, winnerIdx), ...shows.slice(winnerIdx + 1)];
    return reordered.slice(0, 10);
  }
  // Suppress the ranked ItemList entirely for a current season with no nominations.
  // The on-page "Predicted Winner" pill is gated on showOurPick, but this structured
  // data is a separate ranking claim aimed at Google — it was still emitting
  // "position 1: Celebrity Autobiography, Best Revival of a Play 2026-2027" off a
  // one-show category. See tony-nominees-premature, 2026-08-11.
  //
  // Deliberately NO minimum-size floor beyond this gate: once nominees are real, a
  // 1-2 nominee category is a real Tony category, not a thin ranking. 2018-19 Best
  // Revival of a Musical had 2 nominees and the COVID-truncated 2020-21 has 11
  // single-nominee categories — a blanket floor would strip valid schema from them.
  const suppressItemLists = isCurrent && !nominationsAnnounced;
  const allItemListCategories = suppressItemLists ? [] : [...categories, ...nonMajorCategories];
  const categoryItemLists = allItemListCategories.filter(cat => cat.shows.length > 0).map(cat => {
    const winnerShowId = majorWinnersByCategory?.get(cat.title);
    const winnerSlug = winnerShowId ? showIdToSlug.get(winnerShowId) ?? null : null;
    const ordered = orderForItemList(cat.shows, winnerSlug);
    return {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: `${cat.title} - Tony Awards ${season.label}`,
      numberOfItems: ordered.length,
      itemListElement: ordered.map((show, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        item: {
          '@type': 'TheaterEvent',
          name: show.title,
          url: `${BASE_URL}/show/${show.slug}`,
          location: {
            '@type': 'PerformingArtsTheater',
            name: show.venue || 'Broadway Theater',
            address: show.venue || 'New York, NY',
          },
          eventStatus: 'https://schema.org/EventScheduled',
          eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
        },
      })),
    };
  });

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([faqSchema, breadcrumbSchema, ...categoryItemLists]) }}
      />

      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        {/* Back Link */}
        <Link href="/tony-awards/predictions" className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium mb-4 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          All Predictions
        </Link>

        {/* Header + Season Selector */}
        <div className="mb-4">
          <div className="flex items-start justify-between gap-3 mb-2">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-3xl sm:text-4xl font-bold text-white">
                {/* Saying "Predictions" while the page states predictions aren't available
                    was the same overclaim in the largest type on the page. */}
                {isCurrent && !nominationsAnnounced ? 'Tony Awards Season Tracker' : 'Tony Awards Predictions'}
              </h1>
              <SeasonSelect
                basePath="/tony-awards/predictions"
                seasons={allSeasonLabels}
                currentSeason={season.label}
              />
            </div>
            {ceremonyDate && (
              <span className="hidden sm:inline-flex text-xs font-medium px-3 py-1.5 rounded-full bg-brand/10 text-brand border border-brand/20 flex-shrink-0 whitespace-nowrap self-start mt-1">
                Ceremony {new Date(`${ceremonyDate}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
              </span>
            )}
          </div>
          <p className="text-gray-400 mt-2 max-w-2xl">
            {nominationsAnnounced
              ? <>Tony nominees ranked by our per-category model — critic, audience, and (for Best Play) precursor Awards Score. {(() => {
                  const iso = getOddsLastUpdated();
                  if (!iso) return 'Updated daily.';
                  const d = new Date(iso);
                  const stamp = d.toLocaleString('en-US', {
                    timeZone: 'America/New_York',
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                    hour12: true,
                  });
                  return `Updated frequently during the day · last update ${stamp} ET.`;
                })()}</>
              : winnerCount > 0
                ? `How our per-category model would have predicted the ${season.ceremonyYear} Tony Awards.`
                : isCurrent
                  // Pre-nominations this page has no predictions on it, so the old
                  // "Data-driven predictions … Updated daily" line contradicted both the
                  // eligibility banner below and the FAQ schema. Describe the real content.
                  ? `Broadway shows opening in the ${season.label} season, tracked as they open. Predictions start once Tony nominations are announced.`
                  : 'Data-driven predictions powered by per-category blends of critic, audience, and precursor-award signal — tuned on 11 years of Tony history. Updated daily.'}
          </p>
          {ceremonyDate && isCurrent && (
            <div className="mt-2 flex items-center gap-2">
              <span className="sm:hidden text-xs font-medium px-2.5 py-1 rounded-full bg-brand/10 text-brand border border-brand/20 whitespace-nowrap">
                Ceremony {new Date(`${ceremonyDate}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
              </span>
              <CeremonyCountdown ceremonyDate={ceremonyDate} />
            </div>
          )}
        </div>

        {/* Eligibility-not-yet-determined banner — current season, before nominations.
            Shows here are grouped by opening date only; the Tony Awards Administration
            Committee hasn't ruled on eligibility (new vs. revival, play vs. musical,
            or eligible at all) for any of them yet. Those rulings land closer to
            nominations (typically spring). See plan in tony-nominees-premature
            investigation, 2026-08-11. */}
        {isCurrent && !nominationsAnnounced && (
          <div className="mb-4 px-4 py-3 rounded-xl border border-white/10 bg-surface-overlay text-sm text-gray-300">
            <span className="font-semibold text-white">Eligibility not yet determined.</span>{' '}
            Shows below are grouped by Broadway opening date only. The Tony Awards Administration
            Committee hasn&apos;t ruled on category eligibility (new vs. revival, play vs. musical, or
            eligible at all) for the {season.label} season — those rulings, and official nominations,
            come later in the season.
          </div>
        )}

        {/* Link to winners page — visible for current season in the run-up to
            the ceremony only, and only once showOurPick is genuinely live (real
            predictions exist, not a 1-2-show fake "100%"). /tony-awards/winners-2026
            is a hand-built page for that ceremony specifically — there is no
            dynamic winners/[season] route yet, so this CTA must stay hardcoded
            to ceremonyYear 2026 until a winners-2027 page gets built (see plan in
            tony-nominees-premature investigation, 2026-08-11). After the ceremony
            the retrospective below replaces this forward-looking CTA. */}
        {isCurrent && !ceremonyHasPassed && showOurPick && season.ceremonyYear === 2026 && (
          <div className="mb-4 px-4 py-3 rounded-xl border border-amber-500/20 bg-amber-500/5 text-sm flex items-center justify-between gap-3">
            <span className="text-gray-300">See our #1 pick for all 26 categories on one page.</span>
            <Link href="/tony-awards/winners-2026" className="text-amber-400 font-semibold whitespace-nowrap hover:text-amber-300 transition-colors">
              Predicted winners →
            </Link>
          </div>
        )}

        {/* Track Record — collapsed by default on the season page.
            Summary line stays inline so the credibility signal is visible
            without expanding; full breakdown lives inside the details. */}
        <details className="mb-6 group rounded-xl border border-white/5 bg-surface-overlay">
          <summary className="p-4 sm:p-5 cursor-pointer list-none [&::-webkit-details-marker]:hidden flex items-center justify-between gap-3 hover:bg-white/[0.02] transition-colors">
            <div className="flex items-baseline gap-2 sm:gap-3 flex-wrap text-sm">
              <span className="text-brand font-bold tabular-nums">{trackRecordPct}%</span>
              <span className="text-gray-300">Our #1 pick wins the Tony</span>
              <span className="text-gray-500 text-xs">across {accuracyStats.seasonCount} seasons &middot; tap to see track record</span>
            </div>
            <svg className="w-4 h-4 text-gray-500 transition-transform group-open:rotate-180 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </summary>
          <div className="px-4 sm:px-5 pb-5 pt-2 border-t border-white/5">
            <TrackRecord summaries={allSummaries} seasonCount={accuracyStats.seasonCount} />
          </div>
        </details>

        {/* Post-ceremony retrospective — renders only for ceremony years with
            an entry in data/tony-prediction-retrospectives.json */}
        <PredictionRetrospective ceremonyYear={season.ceremonyYear} />

        {/* Report Card (past seasons only) — suppressed when a full
            multi-predictor retrospective exists for this ceremony, since the
            retrospective's Big Four grid covers our model's per-category
            result and more. Falls back to the report card for older seasons. */}
        {reportCard.length > 0 && !getRetrospective(season.ceremonyYear) && (
          <div className="mb-10">
            <div className="flex items-center gap-3 mb-4">
              <h2 className="text-lg font-bold text-white">Prediction Report Card</h2>
              <span className={`text-sm font-bold px-2 py-0.5 rounded ${
                rank1Wins === reportCardCount ? 'bg-emerald-500/20 text-emerald-400' :
                rank1Wins >= reportCardCount * 0.75 ? 'bg-blue-500/20 text-blue-400' :
                rank1Wins >= reportCardCount * 0.5 ? 'bg-amber-500/20 text-amber-400' :
                'bg-red-500/20 text-red-400'
              }`}>
                {rank1Wins}/{reportCardCount}
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {reportCard.map(rc => (
                <div key={rc.category} className={`p-4 rounded-xl border-2 ${rc.correct ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-amber-500/40 bg-amber-500/5'}`}>
                  <div className="flex items-center justify-between mb-3 gap-2">
                    <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">{rc.category}</p>
                    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-bold uppercase tracking-wide ${
                      rc.correct
                        ? 'bg-emerald-500/25 text-emerald-300 ring-1 ring-emerald-400/40'
                        : 'bg-amber-500/25 text-amber-300 ring-1 ring-amber-400/40'
                    }`}>
                      {rc.correct ? (
                        <>
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24" aria-hidden="true">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                          Correct
                        </>
                      ) : (
                        <>
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24" aria-hidden="true">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                          Missed{rc.winnerRank ? ` (#${rc.winnerRank})` : ''}
                        </>
                      )}
                    </span>
                  </div>
                  {/* Predicted #1 */}
                  {rc.predicted && (
                    <div className="flex items-center gap-3 mb-2">
                      <div className="w-10 h-10 rounded-lg overflow-hidden bg-surface-raised flex-shrink-0">
                        {rc.predicted.thumbnailPath ? (
                          <img src={getOptimizedImageUrl(rc.predicted.thumbnailPath, 'thumbnail')} alt={rc.predicted.title} className="w-full h-full object-cover" width={40} height={40} />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-sm">🎭</div>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-gray-500">Our #1 pick</p>
                        <p className="text-sm font-medium text-white truncate">{rc.predicted.title}</p>
                      </div>
                      <BlendedTrioDisplay
                        blendedScore={rc.predicted.blendedScore}
                        compositeScore={rc.predicted.compositeScore}
                        reviewCount={rc.predicted.reviewCount}
                        status={rc.predicted.status}
                        audienceGrade={rc.predicted.audienceGrade}
                        awardsScore={rc.predicted.awardsScore}
                        awardsWeighted={rc.predicted.tonyCategoryKey === 'best-play'}
                        size="sm"
                      />
                    </div>
                  )}
                  {/* Actual winner (only show if different from predicted) */}
                  {rc.winner && !rc.correct && (
                    <div className="flex items-center gap-3 pt-2 border-t border-white/5">
                      <div className="w-10 h-10 rounded-lg overflow-hidden bg-surface-raised flex-shrink-0">
                        {rc.winner.thumbnailPath ? (
                          <img src={getOptimizedImageUrl(rc.winner.thumbnailPath, 'thumbnail')} alt={rc.winner.title} className="w-full h-full object-cover" width={40} height={40} />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-sm">🏆</div>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-amber-400">Actual winner</p>
                        <p className="text-sm font-medium text-white truncate">{rc.winner.title}</p>
                      </div>
                      <BlendedTrioDisplay
                        blendedScore={rc.winner.blendedScore}
                        compositeScore={rc.winner.compositeScore}
                        reviewCount={rc.winner.reviewCount}
                        status={rc.winner.status}
                        audienceGrade={rc.winner.audienceGrade}
                        awardsScore={rc.winner.awardsScore}
                        awardsWeighted={rc.winner.tonyCategoryKey === 'best-play'}
                        size="sm"
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* How This Works (current season only, pre-noms) */}
        {isCurrent && !nominationsAnnounced && (
          <details className="mb-10 rounded-xl border border-white/5 bg-surface-overlay">
            <summary className="p-4 sm:p-5 cursor-pointer text-sm font-semibold text-white uppercase tracking-wide hover:text-brand transition-colors list-none [&::-webkit-details-marker]:hidden">
              How This Works
            </summary>
            <div className="px-4 sm:px-5 pb-4 sm:pb-5">
              <p className="text-sm text-gray-400 leading-relaxed">
                Each Tony category gets its own recipe, tuned against {accuracyStats.seasonCount} years of Tony history. The model
                correctly picks the winner {trackRecordHits} of {trackRecordCells} times ({trackRecordPct}%) across that backtest:
              </p>
              <ul className="text-sm text-gray-400 leading-relaxed mt-3 space-y-1.5 list-disc pl-5">
                <li><span className="text-white font-medium">Best Musical:</span> 45% critic + 45% audience + 10% cast acting Tony nominations count (a same-ballot voter-sentiment signal that activates after Tony nominations are announced; pre-noms, the model falls back to the prior precursor blend).</li>
                <li><span className="text-white font-medium">Best Play:</span> 100% precursor awards, combining DL/OCC/DD top-category signal with Pulitzer, NYDCC, and Tony nomination breadth.</li>
                <li><span className="text-white font-medium">Best Revival of a Musical:</span> 95% audience + 5% broad precursor signal, with weights fit by log-loss on the displayed softmax.</li>
                <li><span className="text-white font-medium">Best Revival of a Play:</span> 20% critic + 60% audience + 20% Awards Score.</li>
              </ul>
              <p className="text-sm text-gray-400 leading-relaxed mt-3">
                Best Musical and Best Revival of a Musical also apply a feasibility filter: shows
                without a Best Direction of a Musical Tony nomination get a ×0.85 penalty (no winner
                has lacked one in 11 tracked seasons), and jukebox musicals get the same penalty for
                Best Musical (only Moulin Rouge has won, in the COVID-truncated 2019&ndash;20 ceremony).
              </p>
              <p className="text-sm text-gray-400 leading-relaxed mt-3">
                Awards Score combines Drama League (weight 1.0), OCC (0.9), and Drama Desk (0.7) signal,
                with each nomination weighted by category importance &mdash; top categories like Best Musical
                are credited via a +30 win / +10 nom bonus, then non-top nominations are tiered (Book/Music/Lyrics
                A+ = 2.0, Direction/Lead Acting A = 1.5, Featured/Orchestrations B = 1.0, Design C = 0.5).
                Best Play also pulls in a broader prestige signal across Pulitzer, NYDCC, Olivier, Obie, and
                Lortel ceremonies (Tony wins themselves masked to prevent leakage), log-scaled to 0&ndash;100.
              </p>
              <Link href="/methodology" className="text-sm text-brand hover:text-brand-hover transition-colors mt-2 inline-block">
                Learn about our scoring methodology &rarr;
              </Link>
              <p className="text-xs text-gray-500 leading-relaxed mt-4 pt-3 border-t border-white/5">
                Score model updated 2026-05-23: Best Play now uses a two-signal awards score (40% top-cat
                precursor + 60% broad ceremony signal), and Best Musical/Best Revival Musical recipes were
                rebalanced. Best Play in-sample accuracy 11/11. Total backtest accuracy {trackRecordHits} of {trackRecordCells} ({trackRecordPct}%).
              </p>
            </div>
          </details>
        )}

        {/* Coming Soon — shown when the season has too few shows to make meaningful
            predictions. Kept deliberately compact: it used to be the ONLY thing on the
            page in this state, which is why a season with 9 dated shows looked empty.
            The real season list renders below it. */}
        {totalScored < 2 && winnerCount === 0 ? (
          <div className="rounded-xl border border-white/10 bg-surface-overlay p-5 mb-8">
            <h2 className="text-base font-bold text-white mb-1">Predictions start after nominations</h2>
            <p className="text-gray-400 text-sm">
              The {season.label} Tony season is still early &mdash; the shows below have been announced
              or have opened, but our model doesn&apos;t rank them until Tony nominations are announced.
            </p>
            <Link
              href={`/tony-awards/predictions/${allSeasonLabels[1] ?? ''}`}
              className="inline-block mt-3 text-sm text-brand hover:text-brand-hover transition-colors"
            >
              See {allSeasonLabels[1]} predictions and results &rarr;
            </Link>
          </div>
        ) : (
          <>
            {/* 4 major categories — single shared CategorySection layout for visual parity with Nominations Center */}
            {categories.map(cat => (
              <CategorySection
                key={cat.key}
                sectionId={cat.key}
                category={cat}
                description={cat.description}
                winProbs={categoryWinProbs.get(cat.key)}
                ceremonyDate={ceremonyDate}
                categoryOutcome={categoryOutcomeStatus[cat.key]}
                ineligible={ineligibleByCategory[cat.key]}
                showOurPick={showOurPick}
              />
            ))}

            {/* Beat the Critics promo — current season + entries-open gate only */}
            {isCurrent && isBtcPromoActive() && (
              <FeaturedSpot
                eyebrow="Beat the Critics"
                title="Think you know Broadway better than the critics?"
                description="Pick the Tony winners against our model and the top critics. One entry wins a $200 TodayTix gift card."
                ctaLabel="Make your picks"
                href="/beat-the-critics"
                accent="btc"
                stat={{ value: '$200', label: 'TodayTix gift card', compactLabel: 'Prize' }}
                secondary={[
                  { value: '26', label: 'categories' },
                  { value: 'Jun 7', label: 'ceremony' },
                ]}
                trackingId="tony_predictions_mid_btc"
              />
            )}
          </>
        )}

        {/* Dated and in-season, but not yet scored. These live in cat.upcoming, which
            CategorySection doesn't render, so before this they were invisible — the page
            showed only "Predictions coming soon" while 9 real dated shows sat hidden.
            No scores or ranking: unopened shows have nothing to rank on. */}
        {openingThisSeason.length > 0 && (
          <section className="mb-10">
            <h2 className="text-lg font-bold text-white mb-1">This season&apos;s Broadway shows</h2>
            <p className="text-sm text-gray-400 mb-6">
              {openingThisSeasonCards.length} show{openingThisSeasonCards.length !== 1 ? 's' : ''} scheduled
              for the {season.label} season, grouped the way the Tony show categories are.
              {awaitingOpeningNight > 0 && <> {awaitingOpeningNight} of them {awaitingOpeningNight === 1 ? 'has' : 'have'} a
              previews date but no announced opening night yet.</>} Eligibility itself is not yet
              determined — the Tony Administration Committee rules on that, and it hasn&apos;t.
              Scores appear once each show opens and reviews land.
            </p>
            {seasonGroups.map(group => (
              <div key={group.key} className="mb-8 last:mb-0">
                <h3 className="text-xs font-bold uppercase tracking-wider text-gray-400 mb-3">
                  {group.title}
                  <span className="ml-2 text-gray-600 tabular-nums">{group.shows.length}</span>
                </h3>
                <div className="space-y-3" role="list" aria-label={group.title}>
                  {group.shows.map((show, i) => (
                    <ShowListCard key={show.id} show={show} index={i} scoreMode="critics" />
                  ))}
                </div>
              </div>
            ))}
          </section>
        )}

        {/* Previews-dated shows used to live in their own "In previews this season"
            section here. They now fold into the grouped season block above: a show
            with a previews date IS a play or a musical and IS or isn't a revival,
            and it is unambiguously opening this season — only the opening DATE is
            unknown, which its card states. Owner, 2026-08-13. */}

        {/* The "Announced, no opening night yet" section is gone: those shows now
            sit in the grouped season block above with TBA in the date slot.
            Every announced Broadway show belongs on this list (owner, 2026-08-13);
            a show with no date is still a play or a musical. */}

        {/* Performer + craft categories — no model predictions; data depends on season:
            - Current season: GD/Kalshi/Polymarket odds + critic/audience/award scores
            - Past seasons: critic/audience/award scores only (markets are closed) */}
        {totalScored >= 2 && nonMajorCategories.length > 0 && (
          <section className="mt-10">
            <div className="mb-4">
              <h2 className="text-xl font-bold text-white">Performer &amp; Craft Categories</h2>
              <p className="text-sm text-gray-400 mt-1">
                {isCurrent
                  ? <>Our model doesn&apos;t predict these — they&apos;re shown with Gold Derby, Kalshi, and Polymarket odds plus precursor signal.</>
                  : <>Historical {season.label} nominees with critic scores, audience grades, and Award Score.</>}
              </p>
            </div>
            {nonMajorCategories.map(cat => (
              <CategorySection key={cat.key} category={cat} ceremonyDate={ceremonyDate} hideMarketOdds={!isCurrent} showOurPick={showOurPick} />
            ))}
          </section>
        )}

        {/* Data Source Note */}
        <div className="text-sm text-gray-500 border-t border-white/5 pt-6">
          <p>
            Rankings are derived from aggregated critic reviews.
            Tony eligibility based on opening dates within the {season.label} season.
            Category classifications (new vs. revival) are subject to official Tony Awards Administration Committee rulings.
          </p>
          <p className="mt-3 text-xs text-gray-600">
            Score model updated 2026-05-16. Awards Score now uses tier-weighted precursor nominations
            (Drama League, OCC, Drama Desk). Backtest accuracy: {blendedHits} of {accuracyStats.categorySeasonCount} contests ({accuracyStats.blendedRank1WinPct}%) across {accuracyStats.seasonCount} years of Tony history.
          </p>
          <div className="flex flex-wrap gap-4 mt-3">
            <Link href="/tony-awards/predictions" className="text-brand hover:text-brand-hover transition-colors">
              All seasons &rarr;
            </Link>
            <Link href="/tony-awards/people" className="text-brand hover:text-brand-hover transition-colors">
              All-time leaderboard &rarr;
            </Link>
            <Link href="/methodology" className="text-brand hover:text-brand-hover transition-colors">
              Scoring methodology &rarr;
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
