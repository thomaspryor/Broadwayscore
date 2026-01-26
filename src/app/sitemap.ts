import { MetadataRoute } from 'next';
import {
  getAllShowSlugs,
  getShowBySlug,
  getAllBestOfCategories,
  getAllDirectorSlugs,
  getAllTheaterSlugs,
  getAllBrowseSlugs,
} from '@/lib/data';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscorecard.com';

export default function sitemap(): MetadataRoute.Sitemap {
  const showSlugs = getAllShowSlugs();
  const bestOfCategories = getAllBestOfCategories();
  const directorSlugs = getAllDirectorSlugs();
  const theaterSlugs = getAllTheaterSlugs();
  const browseSlugs = getAllBrowseSlugs();

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
  const browsePages = browseSlugs.map((slug) => ({
    url: `${BASE_URL}/browse/${slug}`,
    lastModified: new Date(),
    changeFrequency: 'weekly' as const,
    priority: 0.85,
  }));

  // Director pages - medium priority
  const directorPages = directorSlugs.map((slug) => ({
    url: `${BASE_URL}/director/${slug}`,
    lastModified: new Date(),
    changeFrequency: 'monthly' as const,
    priority: 0.7,
  }));

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
    // Browse pages - high priority SEO landing pages
    ...browsePages,
    // Best-of lists - high priority discovery pages
    ...bestOfPages,
    // Broadway theaters map
    {
      url: `${BASE_URL}/broadway-theaters-map`,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    // Index pages - good for SEO crawling
    {
      url: `${BASE_URL}/director`,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    {
      url: `${BASE_URL}/theater`,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    // Show pages - core content
    ...showPages,
    // Director pages
    ...directorPages,
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
  ];
}
