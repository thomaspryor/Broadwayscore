import { MetadataRoute } from 'next';
import { notFound } from 'next/navigation';
import {
  getAllShowSlugs,
  getShowBySlug,
  getBroadwayShows,
  getAllBestOfCategories,
  getAllTheaterSlugs,
  getAllLondonTheaterSlugs,
  getAllWestEndComplexSlugs,
  getAllOffBroadwayTheaterSlugs,
  getAllOffBroadwayComplexSlugs,
  getAllBrowseSlugs,
  getDataFreshness,
  getOperaShows,
  getOperaTitleSlug,
  getShowSitemapLastmod,
} from '@/lib/data-core';
import { getAllCriticSlugs, getAllOutletSlugs, getCriticBySlug } from '@/lib/data-reviews';
import { getAllVideoCreatorSlugs } from '@/lib/data-video-critics';
import { getAllActorProfiles } from '@/lib/data-actors';
import { isThinActor } from '@/lib/actor-indexability';
import { isShowIndexable, isThinCriticPage } from '@/lib/seo-indexability';
import { displaysCriticScore } from '@/lib/critic-score-display';
import { isThinCreative } from '@/lib/creative-indexability';
import { getAllUnifiedCreativeProfiles, ALL_CREATIVE_CATEGORIES, CREATIVE_CATEGORY_CONFIG } from '@/lib/data-creative';
import { getAllGuideSlugs, parseGuideSlug } from '@/config/guide-pages';
import { getAllComparisonSlugs } from '@/config/comparisons';
import { GOLD_LIST_CONFIGS } from '@/config/gold-lists';
import { getSeasonsForList } from '@/lib/data-gold-list-badges';
import { featureFlags } from '@/config/feature-flags';
import { isFantasyListed } from '@/config/fantasy-listing';
import { getAllPredictionSeasons, getTonySeasonWindow, hasNominationsBeenAnnounced } from '@/lib/data-tony-predictions';
import { getAllBlogReviews } from '@/lib/data-reviews-blog';
import { computeSiteAwardScore } from '@/lib/awards-site-score';
import { seasonSlug } from '@/lib/tony-seasons';
import { SITEMAP_SHARDS, getActorBucket, type ShardName } from '@/config/sitemap-shards';
import { isCategoryEnabled } from '@/lib/markets';
import { getTourCities } from '@/lib/data-tour-cities';
import { HUB_CITIES } from '@/lib/city-hub';
import { getSeasonsWithCommercialData, isIndexedCommercialSeason } from '@/lib/data-commercial';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscorecard.com';

// Preserve established markets' indexability policy and thin-page cohort.
// New categories must meet the shared review minimum before sitemap inclusion.
const ESTABLISHED_SHOW_CATEGORIES = new Set([
  'broadway', 'off-broadway', 'west-end', 'off-west-end', 'regional', 'tour',
]);

export function generateSitemaps() {
  return SITEMAP_SHARDS.map((_, i) => ({ id: i }));
}

// Profitability Scorecard topic pages under src/app/biz (stunt-casting is listed on its own).
const BIZ_TOPIC_PATHS = ['musicals-since-reopening', 'reviews-and-money', 'fastest-recoups', 'biggest-flops', 'tony-winners', 'developments'];

type DateContext = { showsDate: Date; reviewsDate: Date; latestDate: Date; currentYear: number };

function getDateContext(): DateContext {
  const freshness = getDataFreshness();
  const showsDate = new Date(freshness.showsLastUpdated);
  const reviewsDate = new Date(freshness.reviewsLastUpdated);
  const latestDate = new Date(Math.max(showsDate.getTime(), reviewsDate.getTime()));
  const currentYear = new Date().getFullYear();
  return { showsDate, reviewsDate, latestDate, currentYear };
}

// Newest per-show lastmod across a profile's shows (actor, creative). Memoised: an
// actor page asks for the same shows hundreds of times per sitemap build.
const showLastmodCache = new Map<string, number>();
function latestShowLastmod(showIds: ReadonlyArray<string>, fallback?: Date): Date | undefined {
  let best = 0;
  for (const id of showIds) {
    let t = showLastmodCache.get(id);
    if (t === undefined) {
      t = getShowSitemapLastmod(id)?.getTime() ?? 0;
      showLastmodCache.set(id, t);
    }
    if (t > best) best = t;
  }
  return best ? new Date(best) : fallback;
}

function buildShowsShard(ctx: DateContext): MetadataRoute.Sitemap {
  const operaSlugs = new Set(getOperaShows().map(s => s.slug));
  return getAllShowSlugs()
    .filter(slug => !operaSlugs.has(slug))
    .filter(slug => {
      const s = getShowBySlug(slug);
      return !s || ((ESTABLISHED_SHOW_CATEGORIES.has(s.category ?? '') || displaysCriticScore(s)) && isShowIndexable(s, slug));
    })
    .map((slug) => {
      const show = getShowBySlug(slug);
      const isOpen = show?.status === 'open';
      return {
        url: `${BASE_URL}/show/${slug}`,
        // Per show, not the global shows.json mtime that churns every CI commit (BRO-5970).
        lastModified: show ? getShowSitemapLastmod(show.id) : undefined,
        changeFrequency: isOpen ? 'weekly' as const : 'monthly' as const,
        priority: isOpen ? 0.9 : 0.6,
      };
    });
}

function buildOperaShard(ctx: DateContext): MetadataRoute.Sitemap {
  const operaShows = getOperaShows();
  const showPages = operaShows
    .filter(s => s.status !== 'upcoming' && (ESTABLISHED_SHOW_CATEGORIES.has(s.category ?? '') || displaysCriticScore(s)))
    .map((show) => {
      const isOpen = show.status === 'open';
      return {
        url: `${BASE_URL}/opera/${getOperaTitleSlug(show.slug)}`,
        lastModified: getShowSitemapLastmod(show.id),
        changeFrequency: isOpen ? 'weekly' as const : 'monthly' as const,
        priority: isOpen ? 0.8 : 0.6,
      };
    });
  return [
    {
      url: `${BASE_URL}/opera`,
      lastModified: ctx.latestDate,
      changeFrequency: 'weekly' as const,
      priority: 0.9,
    },
    ...showPages,
  ];
}

function buildTheatersShard(ctx: DateContext): MetadataRoute.Sitemap {
  const theaterPages = getAllTheaterSlugs().map((slug) => ({
    url: `${BASE_URL}/theater/${slug}`,
    lastModified: ctx.showsDate,
    changeFrequency: 'monthly' as const,
    priority: 0.7,
  }));
  const londonTheaterSlugs = new Set([
    ...getAllLondonTheaterSlugs(),
    ...getAllWestEndComplexSlugs(),
  ]);
  const londonTheaterPages = Array.from(londonTheaterSlugs).map((slug) => ({
    url: `${BASE_URL}/west-end/theater/${slug}`,
    lastModified: ctx.showsDate,
    changeFrequency: 'monthly' as const,
    priority: 0.7,
  }));
  const offBroadwayTheaterSlugs = new Set([
    ...getAllOffBroadwayTheaterSlugs(),
    ...getAllOffBroadwayComplexSlugs(),
  ]);
  const offBroadwayTheaterPages = Array.from(offBroadwayTheaterSlugs).map((slug) => ({
    url: `${BASE_URL}/off-broadway/theater/${slug}`,
    lastModified: ctx.showsDate,
    changeFrequency: 'monthly' as const,
    priority: 0.7,
  }));
  return [
    {
      url: `${BASE_URL}/theater`,
      lastModified: ctx.showsDate,
      changeFrequency: 'weekly' as const,
      priority: 0.8,
    },
    ...theaterPages,
    {
      url: `${BASE_URL}/west-end/theater`,
      lastModified: ctx.showsDate,
      changeFrequency: 'weekly' as const,
      priority: 0.8,
    },
    ...londonTheaterPages,
    {
      url: `${BASE_URL}/off-broadway/theater`,
      lastModified: ctx.showsDate,
      changeFrequency: 'weekly' as const,
      priority: 0.8,
    },
    ...offBroadwayTheaterPages,
    {
      url: `${BASE_URL}/broadway-theaters-map`,
      lastModified: ctx.showsDate,
      changeFrequency: 'weekly' as const,
      priority: 0.8,
    },
  ];
}

function buildCriticsShard(ctx: DateContext): MetadataRoute.Sitemap {
  return [
    {
      url: `${BASE_URL}/critics`,
      lastModified: ctx.reviewsDate,
      changeFrequency: 'weekly' as const,
      priority: 0.85,
    },
    {
      url: `${BASE_URL}/critics/outlets`,
      lastModified: ctx.reviewsDate,
      changeFrequency: 'weekly' as const,
      priority: 0.85,
    },
    ...getAllCriticSlugs().filter((slug) => { const c = getCriticBySlug(slug); return !c || !isThinCriticPage(c, slug); }).map((slug) => ({
      url: `${BASE_URL}/critics/${slug}`,
      lastModified: criticLastmod(slug, ctx),
      changeFrequency: 'monthly' as const,
      priority: 0.7,
    })),
    ...getAllOutletSlugs().map((slug) => ({
      url: `${BASE_URL}/critics/outlets/${slug}`,
      lastModified: ctx.reviewsDate,
      changeFrequency: 'monthly' as const,
      priority: 0.7,
    })),
    ...(featureFlags.videoReviews
      ? [
          {
            url: `${BASE_URL}/video-critics`,
            lastModified: ctx.reviewsDate,
            changeFrequency: 'weekly' as const,
            priority: 0.8,
          },
          ...getAllVideoCreatorSlugs().map((slug) => ({
            url: `${BASE_URL}/video-critics/${slug}`,
            lastModified: ctx.reviewsDate,
            changeFrequency: 'monthly' as const,
            priority: 0.6,
          })),
        ]
      : []),
  ];
}

// A critic page changes when the critic's newest review lands, not on every reviews.json rebuild.
function criticLastmod(slug: string, ctx: DateContext): Date {
  const critic = getCriticBySlug(slug);
  let best = 0;
  for (const r of critic?.reviews ?? []) {
    if (r.parsedDate && r.parsedDate > best && r.parsedDate <= ctx.reviewsDate.getTime()) best = r.parsedDate;
  }
  return best ? new Date(best) : ctx.reviewsDate;
}

function buildCreativesShard(ctx: DateContext): MetadataRoute.Sitemap {
  return [
    ...ALL_CREATIVE_CATEGORIES.map(cat => ({
      url: `${BASE_URL}/${CREATIVE_CATEGORY_CONFIG[cat].routePath}`,
      lastModified: ctx.showsDate,
      changeFrequency: 'weekly' as const,
      priority: 0.85,
    })),
    ...getAllUnifiedCreativeProfiles().filter(p => !isThinCreative(p)).map(p => ({
      url: `${BASE_URL}/creative/${p.slug}`,
      lastModified: latestShowLastmod(p.shows.map(s => s.showId), ctx.showsDate),
      changeFrequency: 'monthly' as const,
      priority: 0.7,
    })),
  ];
}

function buildActorsShard(ctx: DateContext, bucket: 'actors-ah' | 'actors-iq' | 'actors-rz'): MetadataRoute.Sitemap {
  if (!featureFlags.castPages) return [];
  // Thin single-credit pages are noindex (BRO-5399): never submit them
  const slugs = getAllActorProfiles()
    .filter(profile => getActorBucket(profile.slug) === bucket)
    .filter(profile => !isThinActor(profile))
    .map(profile => ({ slug: profile.slug, showIds: profile.shows.map(s => s.showId) }));
  const pages: MetadataRoute.Sitemap = slugs.map(({ slug, showIds }) => ({
    url: `${BASE_URL}/cast/${slug}`,
    lastModified: latestShowLastmod(showIds, ctx.showsDate),
    changeFrequency: 'monthly' as const,
    priority: 0.65,
  }));
  // Include the /cast index in the first actor shard so it's listed exactly once.
  if (bucket === 'actors-ah') {
    pages.unshift({
      url: `${BASE_URL}/cast`,
      lastModified: ctx.showsDate,
      changeFrequency: 'weekly' as const,
      priority: 0.8,
    });
  }
  return pages;
}

async function buildCoreShard(ctx: DateContext): Promise<MetadataRoute.Sitemap> {
  const reviews = await getAllBlogReviews();
  const bestOfCategories = getAllBestOfCategories();
  const browseSlugs = getAllBrowseSlugs();
  const guideSlugs = getAllGuideSlugs();

  const redirectedBrowseSlugs = new Set([
    'best-broadway-musicals',
    'best-broadway-plays',
    'broadway-shows-closing-soon',
    'broadway-shows-for-kids',
  ]);
  const browsePages = browseSlugs
    .filter(slug => !redirectedBrowseSlugs.has(slug))
    .map((slug) => ({
      url: `${BASE_URL}/browse/${slug}`,
      lastModified: ctx.latestDate,
      changeFrequency: 'weekly' as const,
      priority: 0.85,
    }));

  // National-tour city pages (BRO-4601): only the indexed ones; the rest are
  // noindex. No lastModified: the schedules behind them change daily.
  const tourCityPages = isCategoryEnabled('tour')
    ? Array.from(new Set([
        ...Array.from(getTourCities().values()).filter(c => c.indexed).map(c => c.slug),
        ...Object.keys(HUB_CITIES), // hubs are always indexable (BRO-6517)
      ])).map(slug => ({
        url: `${BASE_URL}/tours/${slug}`,
        changeFrequency: 'weekly' as const,
        priority: 0.7,
      }))
    : [];

  const bestOfPages = bestOfCategories.map((category) => ({
    url: `${BASE_URL}/best/${category}`,
    lastModified: ctx.latestDate,
    changeFrequency: 'weekly' as const,
    priority: 0.85,
  }));

  return [
    {
      url: BASE_URL,
      lastModified: ctx.latestDate,
      changeFrequency: 'daily' as const,
      priority: 1,
    },
    ...guideSlugs.map(slug => {
      const { year } = parseGuideSlug(slug);
      const isOldYear = year !== undefined && year < ctx.currentYear - 2;
      if (isOldYear) return null;
      return {
        url: `${BASE_URL}/guides/${slug}`,
        lastModified: ctx.latestDate,
        changeFrequency: year ? 'monthly' as const : 'weekly' as const,
        priority: year ? 0.7 : 0.85,
      };
    }).filter((p): p is NonNullable<typeof p> => p !== null),
    {
      url: `${BASE_URL}/guides`,
      lastModified: ctx.latestDate,
      changeFrequency: 'weekly' as const,
      priority: 0.8,
    },
    {
      url: `${BASE_URL}/research`,
      lastModified: ctx.latestDate,
      changeFrequency: 'monthly' as const,
      priority: 0.8,
    },
    {
      url: `${BASE_URL}/research/critic-audience-divergence-2026`,
      lastModified: ctx.latestDate,
      changeFrequency: 'monthly' as const,
      priority: 0.85,
    },
    ...browsePages,
    ...tourCityPages,
    ...bestOfPages,
    {
      url: `${BASE_URL}/tony-awards`,
      lastModified: ctx.latestDate,
      changeFrequency: 'weekly' as const,
      priority: 0.9,
    },
    ...(hasNominationsBeenAnnounced(getTonySeasonWindow()) ? [{
      url: `${BASE_URL}/tony-awards/nominees`,
      lastModified: ctx.latestDate,
      changeFrequency: 'weekly' as const,
      priority: 0.88,
    }] : []),
    // Fantasy League: only once it is listed (fantasy-season.json listedFrom);
    // before that its pages are noindex, and a noindex URL in the sitemap is a
    // Search Console error (BRO-5483).
    ...(isFantasyListed() ? ['/fantasy', '/fantasy/guide', '/fantasy/leaderboard'].map((p, i) => ({
      url: `${BASE_URL}${p}`,
      lastModified: ctx.latestDate,
      changeFrequency: 'weekly' as const,
      priority: i === 0 ? 0.8 : 0.6,
    })) : []),
    ...(featureFlags.tonyPredictions ? [
      {
        url: `${BASE_URL}/tony-awards/predictions`,
        lastModified: ctx.latestDate,
        changeFrequency: 'weekly' as const,
        priority: 0.85,
      },
      // Skip the current season before nominations: that page sets robots noindex
      // (it has no predictions yet), and submitting a noindex URL in the sitemap
      // produces a "Submitted URL marked noindex" error in Search Console and slows
      // the de-indexing we actually want. It re-enters the sitemap automatically the
      // moment nominations land. See tony-nominees-premature, 2026-08-11.
      ...getAllPredictionSeasons()
        .filter(s => {
          const isCurrent = s.label === getTonySeasonWindow().label;
          return !isCurrent || hasNominationsBeenAnnounced(s);
        })
        .map(s => {
          const isCurrent = s.label === getTonySeasonWindow().label;
          return {
            url: `${BASE_URL}/tony-awards/predictions/${s.label}`,
            lastModified: isCurrent ? ctx.latestDate : ctx.showsDate,
            changeFrequency: isCurrent ? 'weekly' as const : 'monthly' as const,
            priority: isCurrent ? 0.85 : 0.7,
          };
        }),
    ] : []),
    ...(featureFlags.tonyPeople ? [{
      url: `${BASE_URL}/tony-awards/people`,
      lastModified: ctx.latestDate,
      changeFrequency: 'monthly' as const,
      priority: 0.8,
    }] : []),
    {
      url: `${BASE_URL}/west-end`,
      lastModified: ctx.showsDate,
      changeFrequency: 'weekly' as const,
      priority: 0.85,
    },
    {
      url: `${BASE_URL}/off-broadway`,
      lastModified: ctx.showsDate,
      changeFrequency: 'weekly' as const,
      priority: 0.85,
    },
    {
      url: `${BASE_URL}/off-west-end`,
      lastModified: ctx.showsDate,
      changeFrequency: 'weekly' as const,
      priority: 0.8,
    },
    {
      url: `${BASE_URL}/rankings`,
      lastModified: ctx.latestDate,
      changeFrequency: 'weekly' as const,
      priority: 0.9,
    },
    {
      url: `${BASE_URL}/methodology`,
      lastModified: ctx.showsDate,
      changeFrequency: 'monthly' as const,
      priority: 0.5,
    },
    {
      url: `${BASE_URL}/west-end/methodology`,
      lastModified: ctx.showsDate,
      changeFrequency: 'monthly' as const,
      priority: 0.5,
    },
    {
      url: `${BASE_URL}/olivier-awards`,
      lastModified: ctx.showsDate,
      changeFrequency: 'monthly' as const,
      priority: 0.75,
    },
    {
      url: `${BASE_URL}/box-office`,
      lastModified: ctx.showsDate,
      changeFrequency: 'weekly' as const,
      priority: 0.8,
    },
    // Profitability Scorecard (released 2026-10-26, BRO-6192): the hub, its topic
    // pages and one page per season with enough tracked shows to index.
    ...(featureFlags.commercial ? [
      {
        url: `${BASE_URL}/biz`,
        lastModified: ctx.showsDate,
        changeFrequency: 'weekly' as const,
        priority: 0.7,
      },
      ...BIZ_TOPIC_PATHS.map((p) => ({
        url: `${BASE_URL}/biz/${p}`,
        lastModified: ctx.showsDate,
        changeFrequency: 'weekly' as const,
        priority: 0.6,
      })),
      ...getSeasonsWithCommercialData().filter(isIndexedCommercialSeason).map((season) => ({
        url: `${BASE_URL}/biz/season/${season}`,
        lastModified: ctx.showsDate,
        changeFrequency: 'monthly' as const,
        priority: 0.5,
      })),
    ] : []),
    // Public research page (owner released it ahead of /biz, 2026-10-21).
    {
      url: `${BASE_URL}/biz/stunt-casting`,
      lastModified: ctx.showsDate,
      changeFrequency: 'monthly' as const,
      priority: 0.6,
    },
    // /season-report is a 404 until the owner releases it (BRO-5777).
    ...(featureFlags.seasonReport ? [{
      url: `${BASE_URL}/season-report`,
      lastModified: ctx.showsDate,
      changeFrequency: 'weekly' as const,
      priority: 0.7,
    }] : []),
    ...(featureFlags.pathToBroadway ? [{
      url: `${BASE_URL}/path-to-broadway`,
      lastModified: ctx.showsDate,
      changeFrequency: 'monthly' as const,
      priority: 0.6,
    }] : []),
    {
      url: `${BASE_URL}/discount-tickets`,
      lastModified: ctx.showsDate,
      changeFrequency: 'weekly' as const,
      priority: 0.9,
    },
    {
      url: `${BASE_URL}/lotteries`,
      lastModified: ctx.showsDate,
      changeFrequency: 'weekly' as const,
      priority: 0.85,
    },
    {
      url: `${BASE_URL}/rush`,
      lastModified: ctx.showsDate,
      changeFrequency: 'weekly' as const,
      priority: 0.85,
    },
    {
      url: `${BASE_URL}/standing-room`,
      lastModified: ctx.showsDate,
      changeFrequency: 'weekly' as const,
      priority: 0.8,
    },
    {
      url: `${BASE_URL}/best-value`,
      lastModified: ctx.latestDate,
      changeFrequency: 'weekly' as const,
      priority: 0.85,
    },
    {
      url: `${BASE_URL}/west-end/discount-tickets`,
      lastModified: ctx.showsDate,
      changeFrequency: 'weekly' as const,
      priority: 0.9,
    },
    {
      url: `${BASE_URL}/west-end/lotteries`,
      lastModified: ctx.showsDate,
      changeFrequency: 'weekly' as const,
      priority: 0.85,
    },
    {
      url: `${BASE_URL}/west-end/rush`,
      lastModified: ctx.showsDate,
      changeFrequency: 'weekly' as const,
      priority: 0.85,
    },
    {
      url: `${BASE_URL}/west-end/standing-room`,
      lastModified: ctx.showsDate,
      changeFrequency: 'weekly' as const,
      priority: 0.8,
    },
    {
      url: `${BASE_URL}/west-end/best-value`,
      lastModified: ctx.latestDate,
      changeFrequency: 'weekly' as const,
      priority: 0.85,
    },
    {
      url: `${BASE_URL}/audience-buzz`,
      lastModified: ctx.showsDate,
      changeFrequency: 'weekly' as const,
      priority: 0.8,
    },
    ...(featureFlags.awardScoreV2 ? (() => {
      const awardSeasons = new Set<string>();
      for (const show of getBroadwayShows()) {
        try {
          const s = computeSiteAwardScore(show.id);
          if (s.tonySeason) awardSeasons.add(s.tonySeason);
        } catch {}
      }
      return [
        { url: `${BASE_URL}/award-score`, lastModified: ctx.showsDate, changeFrequency: 'weekly' as const, priority: 0.8 },
        ...Array.from(awardSeasons).map(season => ({
          url: `${BASE_URL}/award-score/${seasonSlug(season)}`,
          lastModified: ctx.showsDate,
          changeFrequency: 'monthly' as const,
          priority: 0.6,
        })),
      ];
    })() : []),
    {
      url: `${BASE_URL}/west-end/audience-buzz`,
      lastModified: ctx.showsDate,
      changeFrequency: 'weekly' as const,
      priority: 0.8,
    },
    {
      url: `${BASE_URL}/lists`,
      lastModified: ctx.latestDate,
      changeFrequency: 'weekly' as const,
      priority: 0.85,
    },
    ...GOLD_LIST_CONFIGS.flatMap(config => {
      const seasons = getSeasonsForList(config.type);
      return [
        {
          url: `${BASE_URL}/lists/${config.type}/all-time`,
          lastModified: ctx.latestDate,
          changeFrequency: 'weekly' as const,
          priority: 0.8,
        },
        ...seasons.map(season => ({
          url: `${BASE_URL}/lists/${config.type}/${season}`,
          lastModified: ctx.latestDate,
          changeFrequency: 'monthly' as const,
          priority: 0.7,
        })),
      ];
    }),
    {
      url: `${BASE_URL}/reviews`,
      lastModified: ctx.reviewsDate,
      changeFrequency: 'weekly' as const,
      priority: 0.75,
    },
    ...reviews.map((review) => ({
      url: `${BASE_URL}/reviews/${review.slug}`,
      lastModified: review.publishDate,
      changeFrequency: 'monthly' as const,
      priority: 0.6,
    })),
    {
      url: `${BASE_URL}/cast-changes`,
      lastModified: ctx.showsDate,
      changeFrequency: 'weekly' as const,
      priority: 0.7,
    },
    {
      url: `${BASE_URL}/about`,
      lastModified: ctx.showsDate,
      changeFrequency: 'monthly' as const,
      priority: 0.4,
    },
    // Citation/attribution pages — these teach journalists, bloggers, and Wikipedia
    // editors how to cite our score and embed the auto-updating badge/iframe. They
    // were missing from the sitemap (while /about, /methodology, /rankings were
    // present), so Google couldn't surface the one path that drives the backlinks +
    // "cited as the score" authority loop. The feature was built but undiscoverable.
    {
      url: `${BASE_URL}/partners`,
      lastModified: ctx.showsDate,
      changeFrequency: 'monthly' as const,
      priority: 0.5,
    },
    {
      url: `${BASE_URL}/brand`,
      lastModified: ctx.showsDate,
      changeFrequency: 'monthly' as const,
      priority: 0.4,
    },
    {
      url: `${BASE_URL}/compare`,
      lastModified: ctx.latestDate,
      changeFrequency: 'weekly' as const,
      priority: 0.8,
    },
    ...getAllComparisonSlugs().map((slug) => ({
      url: `${BASE_URL}/compare/${slug}`,
      lastModified: ctx.latestDate,
      changeFrequency: 'monthly' as const,
      priority: 0.7,
    })),
  ];
}

// Next 16 passes the shard id as a Promise<string> (Next 15 passed a plain string). Indexing
// SITEMAP_SHARDS with the raw promise hit notFound() and 404'd every /sitemap/N.xml (BRO-6458).
export default async function sitemap(props: { id: Promise<string> | string | number }): Promise<MetadataRoute.Sitemap> {
  const id = Number(await props.id);
  const ctx = getDateContext();
  const shard = Number.isInteger(id) ? SITEMAP_SHARDS[id] : undefined;
  // Unknown shard id: 404 rather than serving an empty urlset (BRO-5970).
  if (!shard) notFound();
  const name: ShardName = shard.name;
  switch (name) {
    case 'core': return await buildCoreShard(ctx);
    case 'shows': return buildShowsShard(ctx);
    case 'theaters': return buildTheatersShard(ctx);
    case 'critics': return buildCriticsShard(ctx);
    case 'creatives': return buildCreativesShard(ctx);
    case 'actors-ah': return buildActorsShard(ctx, 'actors-ah');
    case 'actors-iq': return buildActorsShard(ctx, 'actors-iq');
    case 'actors-rz': return buildActorsShard(ctx, 'actors-rz');
    case 'opera': return buildOperaShard(ctx);
  }
}
