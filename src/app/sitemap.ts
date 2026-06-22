import { MetadataRoute } from 'next';
import {
  getAllShowSlugs,
  getShowBySlug,
  getBroadwayShows,
  getAllBestOfCategories,
  getAllTheaterSlugs,
  getAllLondonTheaterSlugs,
  getAllBrowseSlugs,
  getDataFreshness,
  getOperaShows,
  getOperaTitleSlug,
} from '@/lib/data-core';
import { getAllCriticSlugs, getAllOutletSlugs } from '@/lib/data-reviews';
import { getAllActorSlugs } from '@/lib/data-actors';
import { getUnifiedCreativeSlugs, ALL_CREATIVE_CATEGORIES, CREATIVE_CATEGORY_CONFIG } from '@/lib/data-creative';
import { getAllGuideSlugs, parseGuideSlug } from '@/config/guide-pages';
import { getAllComparisonSlugs } from '@/config/comparisons';
import { GOLD_LIST_CONFIGS } from '@/config/gold-lists';
import { getSeasonsForList } from '@/lib/data-gold-list-badges';
import { featureFlags } from '@/config/feature-flags';
import { getAllPredictionSeasons, getTonySeasonWindow, hasNominationsBeenAnnounced } from '@/lib/data-tony-predictions';
import { getAllBlogReviews } from '@/lib/data-reviews-blog';
import { computeSiteAwardScore } from '@/lib/awards-scoring';
import { seasonSlug } from '@/lib/tony-seasons';
import { SITEMAP_SHARDS, getActorBucket, type ShardName } from '@/config/sitemap-shards';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscorecard.com';

export function generateSitemaps() {
  return SITEMAP_SHARDS.map((_, i) => ({ id: i }));
}

type DateContext = { showsDate: Date; reviewsDate: Date; latestDate: Date; currentYear: number };

function getDateContext(): DateContext {
  const freshness = getDataFreshness();
  const showsDate = new Date(freshness.showsLastUpdated);
  const reviewsDate = new Date(freshness.reviewsLastUpdated);
  const latestDate = new Date(Math.max(showsDate.getTime(), reviewsDate.getTime()));
  const currentYear = new Date().getFullYear();
  return { showsDate, reviewsDate, latestDate, currentYear };
}

function buildShowsShard(ctx: DateContext): MetadataRoute.Sitemap {
  const operaSlugs = new Set(getOperaShows().map(s => s.slug));
  return getAllShowSlugs()
    .filter(slug => !operaSlugs.has(slug))
    .map((slug) => {
      const show = getShowBySlug(slug);
      const isOpen = show?.status === 'open';
      return {
        url: `${BASE_URL}/show/${slug}`,
        lastModified: isOpen ? ctx.latestDate : ctx.showsDate,
        changeFrequency: isOpen ? 'weekly' as const : 'monthly' as const,
        priority: isOpen ? 0.9 : 0.6,
      };
    });
}

function buildOperaShard(ctx: DateContext): MetadataRoute.Sitemap {
  const operaShows = getOperaShows();
  const showPages = operaShows
    .filter(s => s.status !== 'upcoming')
    .map((show) => {
      const isOpen = show.status === 'open';
      return {
        url: `${BASE_URL}/opera/${getOperaTitleSlug(show.slug)}`,
        lastModified: isOpen ? ctx.latestDate : ctx.showsDate,
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
  const londonTheaterPages = getAllLondonTheaterSlugs().map((slug) => ({
    url: `${BASE_URL}/west-end/theater/${slug}`,
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
    ...getAllCriticSlugs().map((slug) => ({
      url: `${BASE_URL}/critics/${slug}`,
      lastModified: ctx.reviewsDate,
      changeFrequency: 'monthly' as const,
      priority: 0.7,
    })),
    ...getAllOutletSlugs().map((slug) => ({
      url: `${BASE_URL}/critics/outlets/${slug}`,
      lastModified: ctx.reviewsDate,
      changeFrequency: 'monthly' as const,
      priority: 0.7,
    })),
  ];
}

function buildCreativesShard(ctx: DateContext): MetadataRoute.Sitemap {
  return [
    ...ALL_CREATIVE_CATEGORIES.map(cat => ({
      url: `${BASE_URL}/${CREATIVE_CATEGORY_CONFIG[cat].routePath}`,
      lastModified: ctx.showsDate,
      changeFrequency: 'weekly' as const,
      priority: 0.85,
    })),
    ...getUnifiedCreativeSlugs().map(slug => ({
      url: `${BASE_URL}/creative/${slug}`,
      lastModified: ctx.showsDate,
      changeFrequency: 'monthly' as const,
      priority: 0.7,
    })),
  ];
}

function buildActorsShard(ctx: DateContext, bucket: 'actors-ah' | 'actors-iq' | 'actors-rz'): MetadataRoute.Sitemap {
  if (!featureFlags.castPages) return [];
  const slugs = getAllActorSlugs().filter(slug => getActorBucket(slug) === bucket);
  const pages: MetadataRoute.Sitemap = slugs.map(slug => ({
    url: `${BASE_URL}/cast/${slug}`,
    lastModified: ctx.showsDate,
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
    ...browsePages,
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
    ...(featureFlags.tonyPredictions ? [
      {
        url: `${BASE_URL}/tony-awards/predictions`,
        lastModified: ctx.latestDate,
        changeFrequency: 'weekly' as const,
        priority: 0.85,
      },
      ...getAllPredictionSeasons().map(s => {
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
    {
      url: `${BASE_URL}/biz`,
      lastModified: ctx.showsDate,
      changeFrequency: 'weekly' as const,
      priority: 0.7,
    },
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
      url: `${BASE_URL}/trending`,
      lastModified: ctx.latestDate,
      changeFrequency: 'weekly' as const,
      priority: 0.9,
    },
    {
      url: `${BASE_URL}/west-end/trending`,
      lastModified: ctx.latestDate,
      changeFrequency: 'weekly' as const,
      priority: 0.9,
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

export default async function sitemap({ id }: { id: number }): Promise<MetadataRoute.Sitemap> {
  const ctx = getDateContext();
  const shard = SITEMAP_SHARDS[id];
  if (!shard) return [];
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
