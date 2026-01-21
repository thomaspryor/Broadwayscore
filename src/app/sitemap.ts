import { MetadataRoute } from 'next';
import { getAllShowSlugs, getShowBySlug } from '@/lib/data';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwaymetascore.com';

export default function sitemap(): MetadataRoute.Sitemap {
  const showSlugs = getAllShowSlugs();

  // Prioritize open shows higher than closed shows
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
    ...showPages,
  ];
}
