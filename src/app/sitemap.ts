import { MetadataRoute } from 'next';
import {
  getAllShowSlugs,
  getShowBySlug,
  getAllBestOfCategories,
  getAllTheaterSlugs,
  getAllLondonTheaterSlugs,
  getAllBrowseSlugs,
  getDataFreshness,
} from '@/lib/data-core';
import { getAllCriticSlugs, getAllOutletSlugs } from '@/lib/data-reviews';
import { getAllActorSlugs } from '@/lib/data-actors';
import { getCreativeSlugs, getUnifiedCreativeSlugs, ALL_CREATIVE_CATEGORIES, CREATIVE_CATEGORY_CONFIG } from '@/lib/data-creative';
import { getAllGuideSlugs, parseGuideSlug } from '@/config/guide-pages';
import { getAllComparisonSlugs } from '@/config/comparisons';
import { GOLD_LIST_CONFIGS } from '@/config/gold-lists';
import { getSeasonsForList } from '@/lib/data-gold-list-badges';
import { featureFlags } from '@/config/feature-flags';
import { getAllPredictionSeasons, getTonySeasonWindow } from '@/lib/data-tony-predictions';
import { getAllBlogReviews } from '@/lib/data-reviews-blog';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscorecard.com';

export default function sitemap(): MetadataRoute.Sitemap {
  const showSlugs = getAllShowSlugs();
  const bestOfCategories = getAllBestOfCategories();
  const theaterSlugs = getAllTheaterSlugs();
  const londonTheaterSlugs = getAllLondonTheaterSlugs();
  const browseSlugs = getAllBrowseSlugs();
  const guideSlugs = getAllGuideSlugs();
  const currentYear = new Date().getFullYear();

  // Use actual data freshness dates instead of build-time new Date()
  const freshness = getDataFreshness();
  const showsDate = new Date(freshness.showsLastUpdated);
  const reviewsDate = new Date(freshness.reviewsLastUpdated);
  // Use the most recent data update for hub pages
  const latestDate = new Date(Math.max(showsDate.getTime(), reviewsDate.getTime()));

  // Show pages - prioritize open shows higher than closed shows
  const showPages = showSlugs.map((slug) => {
    const show = getShowBySlug(slug);
    const isOpen = show?.status === 'open';

    return {
      url: `${BASE_URL}/show/${slug}`,
      lastModified: isOpen ? latestDate : showsDate,
      changeFrequency: isOpen ? 'weekly' as const : 'monthly' as const,
      priority: isOpen ? 0.9 : 0.6,
    };
  });

  // Best-of list pages - high priority, updated frequently
  const bestOfPages = bestOfCategories.map((category) => ({
    url: `${BASE_URL}/best/${category}`,
    lastModified: latestDate,
    changeFrequency: 'weekly' as const,
    priority: 0.85,
  }));

  // Browse pages - high priority SEO landing pages
  // Exclude browse slugs that redirect to guide pages (301 in vercel.json)
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
      lastModified: latestDate,
      changeFrequency: 'weekly' as const,
      priority: 0.85,
    }));

  // Theater pages - medium priority
  const theaterPages = theaterSlugs.map((slug) => ({
    url: `${BASE_URL}/theater/${slug}`,
    lastModified: showsDate,
    changeFrequency: 'monthly' as const,
    priority: 0.7,
  }));

  // London theater pages (West End + Off-West End) - medium priority
  const londonTheaterPages = londonTheaterSlugs.map((slug) => ({
    url: `${BASE_URL}/west-end/theater/${slug}`,
    lastModified: showsDate,
    changeFrequency: 'monthly' as const,
    priority: 0.7,
  }));

  return [
    // Homepage - highest priority
    {
      url: BASE_URL,
      lastModified: latestDate,
      changeFrequency: 'daily',
      priority: 1,
    },
    // Guide pages - editorial SEO landing pages
    ...guideSlugs.map(slug => {
      const { year } = parseGuideSlug(slug);
      const isOldYear = year !== undefined && year < currentYear - 2;
      // Skip old year pages from sitemap (they're noindexed anyway)
      if (isOldYear) return null;
      return {
        url: `${BASE_URL}/guides/${slug}`,
        lastModified: latestDate,
        changeFrequency: year ? 'monthly' as const : 'weekly' as const,
        priority: year ? 0.7 : 0.85,
      };
    }).filter((p): p is NonNullable<typeof p> => p !== null),
    // Guides index page
    {
      url: `${BASE_URL}/guides`,
      lastModified: latestDate,
      changeFrequency: 'weekly' as const,
      priority: 0.8,
    },
    // Browse pages - high priority SEO landing pages
    ...browsePages,
    // Best-of lists - high priority discovery pages
    ...bestOfPages,
    // Tony Awards hub
    {
      url: `${BASE_URL}/tony-awards`,
      lastModified: latestDate,
      changeFrequency: 'weekly',
      priority: 0.9,
    },
    // Tony Awards predictions overview + per-season pages
    ...(featureFlags.tonyPredictions ? [
      {
        url: `${BASE_URL}/tony-awards/predictions`,
        lastModified: latestDate,
        changeFrequency: 'weekly' as const,
        priority: 0.85,
      },
      ...getAllPredictionSeasons().map(s => {
        const isCurrent = s.label === getTonySeasonWindow().label;
        return {
          url: `${BASE_URL}/tony-awards/predictions/${s.label}`,
          lastModified: isCurrent ? latestDate : showsDate,
          changeFrequency: isCurrent ? 'weekly' as const : 'monthly' as const,
          priority: isCurrent ? 0.85 : 0.7,
        };
      }),
    ] : []),
    // Tony Awards leaderboard (only when feature flag is on, otherwise 404)
    ...(featureFlags.tonyPeople ? [{
      url: `${BASE_URL}/tony-awards/people`,
      lastModified: latestDate,
      changeFrequency: 'monthly' as const,
      priority: 0.8,
    }] : []),
    // West End page
    {
      url: `${BASE_URL}/west-end`,
      lastModified: showsDate,
      changeFrequency: 'weekly',
      priority: 0.85,
    },
    // Off-Broadway page
    {
      url: `${BASE_URL}/off-broadway`,
      lastModified: showsDate,
      changeFrequency: 'weekly',
      priority: 0.85,
    },
    // Off-West End page
    {
      url: `${BASE_URL}/off-west-end`,
      lastModified: showsDate,
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    // Rankings hub page
    {
      url: `${BASE_URL}/rankings`,
      lastModified: latestDate,
      changeFrequency: 'weekly',
      priority: 0.9,
    },
    // Broadway theaters map
    {
      url: `${BASE_URL}/broadway-theaters-map`,
      lastModified: showsDate,
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    // Index pages - good for SEO crawling
    {
      url: `${BASE_URL}/theater`,
      lastModified: showsDate,
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    // Show pages - core content
    ...showPages,
    // Theater pages
    ...theaterPages,
    {
      url: `${BASE_URL}/west-end/theater`,
      lastModified: showsDate,
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    // London theater pages
    ...londonTheaterPages,
    // Static pages
    {
      url: `${BASE_URL}/methodology`,
      lastModified: showsDate,
      changeFrequency: 'monthly',
      priority: 0.5,
    },
    {
      url: `${BASE_URL}/west-end/methodology`,
      lastModified: showsDate,
      changeFrequency: 'monthly',
      priority: 0.5,
    },
    // Data pages - high value for AI citations
    {
      url: `${BASE_URL}/box-office`,
      lastModified: showsDate,
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    {
      url: `${BASE_URL}/biz`,
      lastModified: showsDate,
      changeFrequency: 'weekly',
      priority: 0.7,
    },
    // Lottery and Rush pages - high value for discount ticket seekers
    {
      url: `${BASE_URL}/discount-tickets`,
      lastModified: showsDate,
      changeFrequency: 'weekly',
      priority: 0.9,
    },
    {
      url: `${BASE_URL}/lotteries`,
      lastModified: showsDate,
      changeFrequency: 'weekly',
      priority: 0.85,
    },
    {
      url: `${BASE_URL}/rush`,
      lastModified: showsDate,
      changeFrequency: 'weekly',
      priority: 0.85,
    },
    {
      url: `${BASE_URL}/standing-room`,
      lastModified: showsDate,
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    {
      url: `${BASE_URL}/best-value`,
      lastModified: latestDate,
      changeFrequency: 'weekly',
      priority: 0.85,
    },
    // West End discount ticket pages — new for WE launch 2026-04-13
    {
      url: `${BASE_URL}/west-end/discount-tickets`,
      lastModified: showsDate,
      changeFrequency: 'weekly',
      priority: 0.9,
    },
    {
      url: `${BASE_URL}/west-end/lotteries`,
      lastModified: showsDate,
      changeFrequency: 'weekly',
      priority: 0.85,
    },
    {
      url: `${BASE_URL}/west-end/rush`,
      lastModified: showsDate,
      changeFrequency: 'weekly',
      priority: 0.85,
    },
    {
      url: `${BASE_URL}/west-end/standing-room`,
      lastModified: showsDate,
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    {
      url: `${BASE_URL}/west-end/best-value`,
      lastModified: latestDate,
      changeFrequency: 'weekly',
      priority: 0.85,
    },
    // Audience data pages
    {
      url: `${BASE_URL}/audience-buzz`,
      lastModified: showsDate,
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    {
      url: `${BASE_URL}/west-end/audience-buzz`,
      lastModified: showsDate,
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    // Critic & Outlet pages - high value for authority and AI citations
    {
      url: `${BASE_URL}/critics`,
      lastModified: reviewsDate,
      changeFrequency: 'weekly',
      priority: 0.85,
    },
    {
      url: `${BASE_URL}/critics/outlets`,
      lastModified: reviewsDate,
      changeFrequency: 'weekly',
      priority: 0.85,
    },
    ...getAllCriticSlugs().map((slug) => ({
      url: `${BASE_URL}/critics/${slug}`,
      lastModified: reviewsDate,
      changeFrequency: 'monthly' as const,
      priority: 0.7,
    })),
    ...getAllOutletSlugs().map((slug) => ({
      url: `${BASE_URL}/critics/outlets/${slug}`,
      lastModified: reviewsDate,
      changeFrequency: 'monthly' as const,
      priority: 0.7,
    })),
    // Creative team index pages (directors, playwrights, composers, lyricists)
    ...ALL_CREATIVE_CATEGORIES.map(cat => ({
      url: `${BASE_URL}/${CREATIVE_CATEGORY_CONFIG[cat].routePath}`,
      lastModified: showsDate,
      changeFrequency: 'weekly' as const,
      priority: 0.85,
    })),
    // Unified creative person pages (/creative/[slug])
    ...getUnifiedCreativeSlugs().map(slug => ({
      url: `${BASE_URL}/creative/${slug}`,
      lastModified: showsDate,
      changeFrequency: 'monthly' as const,
      priority: 0.7,
    })),
    // Gold List pages - curated ranking lists
    {
      url: `${BASE_URL}/lists`,
      lastModified: latestDate,
      changeFrequency: 'weekly' as const,
      priority: 0.85,
    },
    ...GOLD_LIST_CONFIGS.flatMap(config => {
      const seasons = getSeasonsForList(config.type);
      return [
        {
          url: `${BASE_URL}/lists/${config.type}/all-time`,
          lastModified: latestDate,
          changeFrequency: 'weekly' as const,
          priority: 0.8,
        },
        ...seasons.map(season => ({
          url: `${BASE_URL}/lists/${config.type}/${season}`,
          lastModified: latestDate,
          changeFrequency: 'monthly' as const,
          priority: 0.7,
        })),
      ];
    }),
    // Cast/Actor pages - individual performer profiles
    ...(featureFlags.castPages ? [
      {
        url: `${BASE_URL}/cast`,
        lastModified: showsDate,
        changeFrequency: 'weekly' as const,
        priority: 0.8,
      },
      ...getAllActorSlugs().map(slug => ({
        url: `${BASE_URL}/cast/${slug}`,
        lastModified: showsDate,
        changeFrequency: 'monthly' as const,
        priority: 0.65,
      })),
    ] : []),
    // Reviews index + individual blog reviews
    {
      url: `${BASE_URL}/reviews`,
      lastModified: reviewsDate,
      changeFrequency: 'weekly' as const,
      priority: 0.75,
    },
    ...getAllBlogReviews().map((review) => ({
      url: `${BASE_URL}/reviews/${review.slug}`,
      lastModified: review.publishDate,
      changeFrequency: 'monthly' as const,
      priority: 0.6,
    })),
    // Cast changes page
    {
      url: `${BASE_URL}/cast-changes`,
      lastModified: showsDate,
      changeFrequency: 'weekly' as const,
      priority: 0.7,
    },
    // About page
    {
      url: `${BASE_URL}/about`,
      lastModified: showsDate,
      changeFrequency: 'monthly' as const,
      priority: 0.4,
    },
    // Compare pages - programmatic SEO goldmine
    {
      url: `${BASE_URL}/compare`,
      lastModified: latestDate,
      changeFrequency: 'weekly' as const,
      priority: 0.8,
    },
    ...getAllComparisonSlugs().map((slug) => ({
      url: `${BASE_URL}/compare/${slug}`,
      lastModified: latestDate,
      changeFrequency: 'monthly' as const,
      priority: 0.7,
    })),
  ];
}
