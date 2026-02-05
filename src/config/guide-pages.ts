// Guide Pages Configuration
// Defines editorial landing pages targeting high-volume SEO queries
// These are richer than browse pages: LLM editorial intros, critic consensus, ticket CTAs

import { ComputedShow } from '@/lib/engine';

export interface GuidePageConfig {
  slug: string;
  title: string;
  h1Template: string;
  metaTitleTemplate: string;
  metaDescriptionTemplate: string;
  introFallback: string;
  filter: (show: ComputedShow) => boolean;
  sort: 'score' | 'opening-date' | 'closing-date';
  limit?: number;
  relatedGuides: string[];
  relatedBrowse: string[];
  yearPages?: number[]; // Explicit year list for year-variant pages
}

// Template variable interpolation — strips unmatched {variables}
export function interpolateTemplate(
  template: string,
  vars: Record<string, string | number>
): string {
  return template
    .replace(/\{(\w+)\}/g, (match, key) => {
      const val = vars[key];
      return val !== undefined ? String(val) : '';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

// Parse a guide slug to extract base slug and optional year
export function parseGuideSlug(slug: string): { baseSlug: string; year?: number } {
  const yearMatch = slug.match(/-(\d{4})$/);
  if (yearMatch) {
    const year = parseInt(yearMatch[1], 10);
    if (year >= 2000 && year <= 2100) {
      return { baseSlug: slug.replace(/-\d{4}$/, ''), year };
    }
  }
  return { baseSlug: slug };
}

export const GUIDE_PAGES: Record<string, GuidePageConfig> = {
  'best-broadway-shows': {
    slug: 'best-broadway-shows',
    title: 'Best Broadway Shows',
    h1Template: 'Best Broadway Shows Right Now ({monthYear})',
    metaTitleTemplate: 'Best Broadway Shows {monthYear} | Broadway Scorecard',
    metaDescriptionTemplate: 'Discover the {count} best Broadway shows playing right now in {monthYear}. Expert critic scores, reviews, and ticket info for the top shows on Broadway.',
    introFallback: 'Broadway is currently home to {count} productions spanning musicals, plays, revivals, and world premieres. Our rankings combine scores from top critics including The New York Times, Vulture, and Variety to identify the very best shows playing right now.',
    filter: (show) => show.status === 'open' && (show.criticScore?.score ?? 0) > 0 && (show.criticScore?.reviewCount ?? 0) >= 5,
    sort: 'score',
    relatedGuides: ['best-broadway-musicals', 'best-broadway-plays', 'best-new-broadway-shows'],
    relatedBrowse: ['tony-winners-on-broadway', 'broadway-shows-for-tourists'],
    yearPages: [2020, 2021, 2022, 2023, 2024, 2025, 2026],
  },

  'best-broadway-musicals': {
    slug: 'best-broadway-musicals',
    title: 'Best Broadway Musicals',
    h1Template: 'Best Broadway Musicals ({monthYear})',
    metaTitleTemplate: 'Best Broadway Musicals {monthYear} | Top-Rated Shows',
    metaDescriptionTemplate: 'The {count} highest-rated Broadway musicals playing now in {monthYear}. See which musicals critics love most, with scores and ticket info.',
    introFallback: 'Broadway musicals represent the pinnacle of theatrical entertainment. These {count} productions are the highest-rated musicals currently playing, ranked by aggregated critic reviews from major outlets.',
    filter: (show) => show.status === 'open' && show.type === 'musical',
    sort: 'score',
    relatedGuides: ['best-broadway-shows', 'best-broadway-plays', 'cheap-broadway-tickets'],
    relatedBrowse: ['jukebox-musicals-on-broadway', 'best-broadway-revivals'],
    yearPages: [2020, 2021, 2022, 2023, 2024, 2025, 2026],
  },

  'best-broadway-plays': {
    slug: 'best-broadway-plays',
    title: 'Best Broadway Plays',
    h1Template: 'Best Broadway Plays to See ({monthYear})',
    metaTitleTemplate: 'Best Broadway Plays {monthYear} | Top Dramatic Theater',
    metaDescriptionTemplate: 'The {count} best Broadway plays to see in {monthYear}. Top-rated dramas and comedies ranked by professional critic reviews.',
    introFallback: 'Broadway plays offer powerful dramatic experiences. These {count} productions are the highest-rated plays currently running, from gripping dramas to sharp comedies.',
    filter: (show) => show.status === 'open' && show.type === 'play',
    sort: 'score',
    relatedGuides: ['best-broadway-shows', 'best-broadway-musicals', 'broadway-shows-closing-soon'],
    relatedBrowse: ['best-broadway-dramas', 'best-broadway-comedies'],
    yearPages: [2020, 2021, 2022, 2023, 2024, 2025, 2026],
  },

  'best-broadway-shows-for-kids': {
    slug: 'best-broadway-shows-for-kids',
    title: 'Best Broadway Shows for Kids',
    h1Template: 'Best Broadway Shows for Kids & Families ({year})',
    metaTitleTemplate: 'Best Broadway Shows for Kids {year} | Family-Friendly Theater',
    metaDescriptionTemplate: 'Find the {count} best family-friendly Broadway shows for kids in {year}. Age-appropriate productions perfect for young theatergoers.',
    introFallback: 'Looking for the perfect Broadway show for your family? These {count} productions are age-appropriate, engaging, and perfect for introducing children to live theater.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      const tags = show.tags?.map(t => t.toLowerCase()) || [];
      const ageRec = show.ageRecommendation?.toLowerCase() || '';
      return tags.includes('family') ||
             tags.includes('accessible') ||
             ageRec.includes('ages 6') ||
             ageRec.includes('ages 8') ||
             ageRec.includes('all ages');
    },
    sort: 'score',
    relatedGuides: ['best-broadway-shows', 'best-broadway-musicals', 'cheap-broadway-tickets'],
    relatedBrowse: ['broadway-shows-for-kids', 'first-time-broadway', 'short-broadway-shows'],
  },

  'best-new-broadway-shows': {
    slug: 'best-new-broadway-shows',
    title: 'Best New Broadway Shows',
    h1Template: 'Best New Broadway Shows ({season} Season)',
    metaTitleTemplate: 'Best New Broadway Shows {season} | Latest Productions',
    metaDescriptionTemplate: 'The {count} best new Broadway shows from the {season} season. Fresh productions ranked by critic scores.',
    introFallback: 'The {season} Broadway season has brought {count} new productions to the Great White Way. These are the highest-rated new shows, from world premieres to acclaimed transfers.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      const openDate = new Date(show.openingDate);
      const now = new Date();
      // Season starts September 1
      const seasonStartYear = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
      const seasonStart = new Date(`${seasonStartYear}-09-01`);
      return openDate >= seasonStart;
    },
    sort: 'score',
    relatedGuides: ['best-broadway-shows', 'broadway-shows-closing-soon'],
    relatedBrowse: ['new-broadway-shows-2025', 'upcoming-broadway-shows'],
  },

  'cheap-broadway-tickets': {
    slug: 'cheap-broadway-tickets',
    title: 'How to Get Cheap Broadway Tickets',
    h1Template: 'How to Get Cheap Broadway Tickets ({year})',
    metaTitleTemplate: 'Cheap Broadway Tickets {year} | Lotteries, Rush & Discounts',
    metaDescriptionTemplate: 'Complete guide to finding cheap Broadway tickets in {year}. {count} shows offer lotteries, rush tickets, and discount programs.',
    introFallback: 'Broadway tickets don\'t have to break the bank. This guide covers every strategy for finding affordable tickets, from digital lotteries to rush tickets. Currently, {count} shows offer discount programs.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      const tags = show.tags?.map(t => t.toLowerCase()) || [];
      return tags.includes('lottery') || tags.includes('rush');
    },
    sort: 'score',
    relatedGuides: ['best-broadway-shows', 'best-broadway-musicals'],
    relatedBrowse: ['broadway-lottery-shows', 'broadway-rush-tickets'],
  },

  'broadway-shows-closing-soon': {
    slug: 'broadway-shows-closing-soon',
    title: 'Broadway Shows Closing Soon',
    h1Template: 'Broadway Shows Closing Soon ({monthYear})',
    metaTitleTemplate: 'Broadway Shows Closing Soon {monthYear} | Last Chance',
    metaDescriptionTemplate: 'Don\'t miss these {count} Broadway shows before they close! Productions ending their runs in the next 60 days as of {monthYear}.',
    introFallback: 'Time is running out to see these Broadway shows. {count} productions are closing within the next 60 days. Don\'t let these slip away — book your tickets now.',
    filter: (show) => {
      if (show.status !== 'open' || !show.closingDate) return false;
      const closing = new Date(show.closingDate);
      const now = new Date();
      const diffDays = Math.ceil((closing.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      return diffDays > 0 && diffDays <= 60;
    },
    sort: 'closing-date',
    relatedGuides: ['best-broadway-shows', 'best-new-broadway-shows'],
    relatedBrowse: ['broadway-shows-closing-soon', 'new-broadway-shows-2025'],
  },

  'highest-rated-broadway-shows': {
    slug: 'highest-rated-broadway-shows',
    title: 'Highest Rated Broadway Shows of All Time',
    h1Template: 'Highest Rated Broadway Shows of All Time',
    metaTitleTemplate: 'Highest Rated Broadway Shows | All-Time Best Scores',
    metaDescriptionTemplate: 'The {count} highest rated Broadway shows ever, ranked by aggregated critic scores. Legendary productions from 2005 to present.',
    introFallback: 'Since 2005, these {count} shows have achieved the highest critic scores in Broadway Scorecard history. From groundbreaking musicals to acclaimed plays, these are the absolute best.',
    filter: (show) => (show.criticScore?.score ?? 0) >= 70,
    sort: 'score',
    limit: 50,
    relatedGuides: ['best-broadway-shows', 'best-broadway-musicals'],
    relatedBrowse: ['tony-winners-on-broadway', 'best-broadway-revivals'],
  },
};

// Slugs that have custom static pages (not generated by dynamic route)
export const CUSTOM_GUIDE_PAGES = new Set([
  'cheap-broadway-tickets',
]);

// Get all guide slugs including year variants for generateStaticParams()
// Excludes slugs that have custom static pages
export function getAllGuideSlugs(): string[] {
  const slugs: string[] = [];

  for (const config of Object.values(GUIDE_PAGES)) {
    // Skip if this slug has a custom page
    if (CUSTOM_GUIDE_PAGES.has(config.slug)) continue;

    slugs.push(config.slug);

    if (config.yearPages) {
      for (const year of config.yearPages) {
        slugs.push(`${config.slug}-${year}`);
      }
    }
  }

  return slugs;
}

// Get guide config, handling year-variant slugs
export function getGuideConfig(slug: string): GuidePageConfig | null {
  // Direct match first
  if (GUIDE_PAGES[slug]) return GUIDE_PAGES[slug];

  // Check for year variant
  const { baseSlug, year } = parseGuideSlug(slug);
  const baseConfig = GUIDE_PAGES[baseSlug];

  if (!baseConfig || !year) return null;

  // Verify this year is in the explicit yearPages list
  if (!baseConfig.yearPages?.includes(year)) return null;

  // Return config with year-scoped filter
  const originalFilter = baseConfig.filter;
  return {
    ...baseConfig,
    filter: (show: ComputedShow) => {
      // For year pages: show opened in that year, regardless of current status
      const openDate = new Date(show.openingDate);
      if (openDate.getFullYear() !== year) return false;
      // For base guides that filter on status='open', year pages show all statuses
      return (show.criticScore?.score ?? 0) > 0;
    },
  };
}
