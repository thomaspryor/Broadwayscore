import { MetadataRoute } from 'next';
import {
  getAllShowSlugs,
  getShowBySlug,
  getAllBestOfCategories,
  getAllDirectorSlugs,
  getAllTheaterSlugs,
} from '@/lib/data';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwaymetascore.com';

export default function sitemap(): MetadataRoute.Sitemap {
  const showSlugs = getAllShowSlugs();
  const bestOfCategories = getAllBestOfCategories();
  const directorSlugs = getAllDirectorSlugs();
  const theaterSlugs = getAllTheaterSlugs();

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
    // Best-of lists - high priority discovery pages
    ...bestOfPages,
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
  ];
}
