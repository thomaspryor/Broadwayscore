import { MetadataRoute } from 'next';
import { getAllShowSlugs } from '@/lib/data';

const BASE_URL = 'https://thomaspryor.github.io/Broadwayscore';

export default function sitemap(): MetadataRoute.Sitemap {
  const showSlugs = getAllShowSlugs();

  const showPages = showSlugs.map((slug) => ({
    url: `${BASE_URL}/show/${slug}`,
    lastModified: new Date(),
    changeFrequency: 'weekly' as const,
    priority: 0.8,
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
    {
      url: `${BASE_URL}/data`,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.3,
    },
    ...showPages,
  ];
}
