import { MetadataRoute } from 'next';
import {
  getAllShowSlugs,
  getShowBySlug,
  getAllBestOfCategories,
  // getAllDirectorSlugs,  // excluded from sitemap for now
  getAllTheaterSlugs,
  getAllBrowseSlugs,
} from '@/lib/data-core';
import { getAllGuideSlugs, parseGuideSlug } from '@/config/guide-pages';
import { getAllComparisonSlugs } from '@/config/comparisons';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscorecard.com';

export default function sitemap(): MetadataRoute.Sitemap {
  const showSlugs = getAllShowSlugs();
  const bestOfCategories = getAllBestOfCategories();
  // const directorSlugs = getAllDirectorSlugs();  // excluded for now
  const theaterSlugs = getAllTheaterSlugs();
  const browseSlugs = getAllBrowseSlugs();
  const guideSlugs = getAllGuideSlugs();
  const currentYear = new Date().getFullYear();

  // Show pages - prioritize open shows higher than closed shows
  const showPages = showSlugs.map((slug) => {
    const show = getShowBySlug(slug);
    const isOpen = show?.status === 'open';

    return {
      url: `${BASE_URL}/show/${slug}`,
      lastModified: new Date(),
      changeFrequency: isOpen ? 'weekly' as const : 'monthly' as const,
      priority: isOpen ? 0.9 : 0.6,
    };
  });

  // Best-of list pages - high priority, updated frequently
  const bestOfPages = bestOfCategories.map((category) => ({
    url: `${BASE_URL}/best/${category}`,
    lastModified: new Date(),
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
      lastModified: new Date(),
      changeFrequency: 'weekly' as const,
      priority: 0.85,
    }));

  // Director pages - excluded from sitemap (noindex for now)
  // const directorPages = directorSlugs.map((slug) => ({
  //   url: `${BASE_URL}/director/${slug}`,
  //   lastModified: new Date(),
  //   changeFrequency: 'monthly' as const,
  //   priority: 0.7,
  // }));

  // Theater pages - medium priority
  const theaterPages = theaterSlugs.map((slug) => ({
    url: `${BASE_URL}/theater/${slug}`,
    lastModified: new Date(),
    changeFrequency: 'monthly' as const,
    priority: 0.7,
  }));

  return [
    // Homepage - highest priority
    {
      url: BASE_URL,
      lastModified: new Date(),
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
        lastModified: new Date(),
        changeFrequency: year ? 'monthly' as const : 'weekly' as const,
        priority: year ? 0.7 : 0.85,
      };
    }).filter((p): p is NonNullable<typeof p> => p !== null),
    // Guides index page
    {
      url: `${BASE_URL}/guides`,
      lastModified: new Date(),
      changeFrequency: 'weekly' as const,
      priority: 0.8,
    },
    // Browse pages - high priority SEO landing pages
    ...browsePages,
    // Best-of lists - high priority discovery pages
    ...bestOfPages,
    // Rankings hub page
    {
      url: `${BASE_URL}/rankings`,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.9,
    },
    // Broadway theaters map
    {
      url: `${BASE_URL}/broadway-theaters-map`,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    // Index pages - good for SEO crawling
    // Director index - excluded (noindex for now)
    {
      url: `${BASE_URL}/theater`,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    // Show pages - core content
    ...showPages,
    // Director pages - excluded (noindex for now)
    // Theater pages
    ...theaterPages,
    // Static pages
    {
      url: `${BASE_URL}/methodology`,
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.5,
    },
    // Data pages - high value for AI citations
    {
      url: `${BASE_URL}/box-office`,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    {
      url: `${BASE_URL}/biz-buzz`,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    // Lottery and Rush pages - high value for discount ticket seekers
    {
      url: `${BASE_URL}/lotteries`,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.85,
    },
    {
      url: `${BASE_URL}/rush`,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.85,
    },
    {
      url: `${BASE_URL}/standing-room`,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    {
      url: `${BASE_URL}/best-value`,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.85,
    },
    // Audience data pages
    {
      url: `${BASE_URL}/audience-buzz`,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    // Compare pages - programmatic SEO goldmine
    {
      url: `${BASE_URL}/compare`,
      lastModified: new Date(),
      changeFrequency: 'weekly' as const,
      priority: 0.8,
    },
    ...getAllComparisonSlugs().map((slug) => ({
      url: `${BASE_URL}/compare/${slug}`,
      lastModified: new Date(),
      changeFrequency: 'monthly' as const,
      priority: 0.7,
    })),
  ];
}
