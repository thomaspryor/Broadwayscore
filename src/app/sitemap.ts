import { MetadataRoute } from 'next';
import { getAllShowSlugs, getShowBySlug, getAllTheaters, getAllDirectors } from '@/lib/data';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwaymetascore.com';

export default function sitemap(): MetadataRoute.Sitemap {
  const showSlugs = getAllShowSlugs();
  const theaters = getAllTheaters();
  const directors = getAllDirectors();

  // Show pages - prioritize open shows
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

  // Best category pages
  const categoryPages = ['musicals', 'plays', 'all'].map((category) => ({
    url: `${BASE_URL}/best/${category}`,
    lastModified: new Date(),
    changeFrequency: 'weekly' as const,
    priority: 0.8,
  }));

  // Theater pages
  const theaterPages = theaters.map((theater) => ({
    url: `${BASE_URL}/theater/${theater.slug}`,
    lastModified: new Date(),
    changeFrequency: 'weekly' as const,
    priority: 0.7,
  }));

  // Director pages
  const directorPages = directors.map((director) => ({
    url: `${BASE_URL}/director/${director.slug}`,
    lastModified: new Date(),
    changeFrequency: 'monthly' as const,
    priority: 0.6,
  }));

  return [
    {
      url: BASE_URL,
      lastModified: new Date(),
      changeFrequency: 'daily',
      priority: 1,
    },
    {
      url: `${BASE_URL}/methodology`,
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.5,
    },
    ...categoryPages,
    ...showPages,
    ...theaterPages,
    ...directorPages,
  ];
}
