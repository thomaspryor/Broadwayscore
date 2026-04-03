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
    metaDescriptionTemplate: 'Discover the {count} best Broadway shows playing right now in {monthYear}. Expert CriticScore ratings, reviews, and ticket info for the top shows on Broadway.',
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
    filter: (show) => show.status === 'open' && show.type === 'musical' && (show.criticScore?.score ?? 0) > 0 && (show.criticScore?.reviewCount ?? 0) >= 5,
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
    filter: (show) => show.status === 'open' && show.type === 'play' && (show.criticScore?.score ?? 0) > 0 && (show.criticScore?.reviewCount ?? 0) >= 5,
    sort: 'score',
    relatedGuides: ['best-broadway-shows', 'best-broadway-musicals', 'broadway-shows-closing-soon'],
    relatedBrowse: ['best-broadway-dramas', 'best-broadway-comedies'],
    yearPages: [2020, 2021, 2022, 2023, 2024, 2025, 2026],
  },

  'best-broadway-shows-for-kids': {
    slug: 'best-broadway-shows-for-kids',
    title: 'Best Broadway Shows for Kids',
    h1Template: 'Best Broadway Shows for Kids & Families ({year})',
    metaTitleTemplate: 'Best Broadway Shows for Kids in NYC ({year})',
    metaDescriptionTemplate: 'Find the {count} best family-friendly Broadway shows for kids in {year}. Age-appropriate productions perfect for young theatergoers.',
    introFallback: 'Looking for the perfect Broadway show for your family? These {count} productions are age-appropriate, engaging, and perfect for introducing children to live theater.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      if ((show.criticScore?.score ?? 0) <= 0 || (show.criticScore?.reviewCount ?? 0) < 3) return false;
      const tags = show.tags?.map(t => t.toLowerCase()) || [];
      const ageRec = show.ageRecommendation?.toLowerCase() || '';
      return tags.includes('family') ||
             tags.includes('accessible') ||
             ageRec.includes('ages 6') ||
             ageRec.includes('ages 8') ||
             ageRec.includes('all ages');
    },
    sort: 'score',
    relatedGuides: ['best-broadway-shows', 'best-broadway-musicals', 'broadway-shows-for-parents'],
    relatedBrowse: ['broadway-shows-for-kids', 'first-time-broadway', 'short-broadway-shows'],
  },

  'best-new-broadway-shows': {
    slug: 'best-new-broadway-shows',
    title: 'Best New Broadway Shows',
    h1Template: 'Best New Broadway Shows ({season} Season)',
    metaTitleTemplate: 'Best New Broadway Shows {season} | Latest Productions',
    metaDescriptionTemplate: 'The {count} best new Broadway shows from the {season} season. Fresh productions ranked by CriticScore.',
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
    metaDescriptionTemplate: 'The {count} highest rated Broadway shows ever, ranked by aggregated CriticScore ratings. Legendary productions from 2005 to present.',
    introFallback: 'Since 2005, these {count} shows have achieved the highest CriticScore ratings in Broadway Scorecard history. From groundbreaking musicals to acclaimed plays, these are the absolute best.',
    filter: (show) => (show.criticScore?.score ?? 0) >= 70,
    sort: 'score',
    limit: 50,
    relatedGuides: ['best-broadway-shows', 'best-broadway-musicals'],
    relatedBrowse: ['tony-winners-on-broadway', 'best-broadway-revivals'],
  },

  // === AWARD WINNERS ===
  'tony-award-winners': {
    slug: 'tony-award-winners',
    title: 'Tony Award Winners on Broadway',
    h1Template: 'Tony Award Winners You Can See on Broadway ({year})',
    metaTitleTemplate: 'Tony Award Winners on Broadway {year} | See Award-Winning Shows',
    metaDescriptionTemplate: 'See {count} Tony Award-winning shows currently playing on Broadway in {year}. Best Musical, Best Play, and other award winners.',
    introFallback: 'Experience Broadway excellence with these {count} Tony Award-winning productions. From Best Musical to Best Play winners, these shows represent the pinnacle of theatrical achievement.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      const tags = show.tags?.map(t => t.toLowerCase()) || [];
      return tags.includes('tony winner') || tags.includes('tony-winner') || tags.includes('award-winner');
    },
    sort: 'score',
    relatedGuides: ['best-broadway-shows', 'highest-rated-broadway-shows'],
    relatedBrowse: ['tony-winners-on-broadway', 'pulitzer-prize-plays'],
  },

  // === DECADE RETROSPECTIVES ===
  'best-broadway-shows-2010s': {
    slug: 'best-broadway-shows-2010s',
    title: 'Best Broadway Shows of the 2010s',
    h1Template: 'Best Broadway Shows of the 2010s (2010-2019)',
    metaTitleTemplate: 'Best Broadway Shows of the 2010s | Top Shows 2010-2019',
    metaDescriptionTemplate: 'The {count} best Broadway shows from the 2010s decade. Hamilton, Dear Evan Hansen, and more legendary productions from 2010-2019.',
    introFallback: 'The 2010s were a transformative decade for Broadway, bringing groundbreaking productions like Hamilton, Dear Evan Hansen, and Book of Mormon. These {count} shows defined an era of theatrical innovation.',
    filter: (show) => {
      const openDate = new Date(show.openingDate);
      const year = openDate.getFullYear();
      return year >= 2010 && year <= 2019 && (show.criticScore?.score ?? 0) >= 60;
    },
    sort: 'score',
    limit: 30,
    relatedGuides: ['best-broadway-shows-2020s', 'highest-rated-broadway-shows'],
    relatedBrowse: ['best-broadway-revivals'],
  },

  'best-broadway-shows-2020s': {
    slug: 'best-broadway-shows-2020s',
    title: 'Best Broadway Shows of the 2020s',
    h1Template: 'Best Broadway Shows of the 2020s (So Far)',
    metaTitleTemplate: 'Best Broadway Shows of the 2020s — Ranked by Critics',
    metaDescriptionTemplate: 'The {count} highest-rated Broadway shows since 2020, ranked by aggregated critic scores from 400+ outlets. From Stereophonic to Sunset Blvd.',
    introFallback: "The 2020s have seen Broadway's remarkable comeback. From the pandemic shutdown to triumphant reopening, these {count} shows represent the best of the current decade.",
    filter: (show) => {
      const openDate = new Date(show.openingDate);
      return openDate.getFullYear() >= 2020 && (show.criticScore?.score ?? 0) >= 60;
    },
    sort: 'score',
    limit: 30,
    relatedGuides: ['best-broadway-shows-2010s', 'best-new-broadway-shows'],
    relatedBrowse: ['new-broadway-shows-2025'],
  },

  // === SEASONAL CONTENT ===
  'broadway-shows-for-christmas': {
    slug: 'broadway-shows-for-christmas',
    title: 'Best Broadway Shows for Christmas',
    h1Template: 'Best Broadway Shows for the Holidays ({year})',
    metaTitleTemplate: 'Best Broadway Shows for Christmas {year} | Holiday Theater',
    metaDescriptionTemplate: 'Find the perfect Broadway show for the holidays in {year}. {count} family-friendly and festive shows for your Christmas visit to NYC.',
    introFallback: 'Celebrate the holidays with a Broadway show! These {count} productions are perfect for a festive night out, from family classics to spectacular musicals that capture the magic of the season.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      const tags = show.tags?.map(t => t.toLowerCase()) || [];
      // Family-friendly or festive shows work best for holidays
      return tags.includes('family') ||
             tags.includes('accessible') ||
             tags.includes('spectacular') ||
             show.type === 'musical';
    },
    sort: 'score',
    limit: 15,
    relatedGuides: ['best-broadway-shows-for-kids', 'best-broadway-musicals'],
    relatedBrowse: ['broadway-shows-for-kids', 'broadway-shows-for-tourists'],
  },

  'broadway-shows-for-date-night': {
    slug: 'broadway-shows-for-date-night',
    title: 'Best Broadway Shows for Date Night',
    h1Template: 'Best Broadway Shows for Date Night ({year})',
    metaTitleTemplate: 'Best Broadway Shows for Date Night {year} | Romantic Theater',
    metaDescriptionTemplate: 'Plan the perfect date night with these {count} Broadway shows. Romantic musicals and captivating plays perfect for couples.',
    introFallback: 'Looking for the perfect Broadway show for date night? These {count} productions offer the ideal blend of romance, spectacle, and emotion for an unforgettable evening with your partner.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      const tags = show.tags?.map(t => t.toLowerCase()) || [];
      // Date night: sophisticated, romantic, or emotionally engaging
      return tags.includes('romantic') ||
             tags.includes('sophisticated') ||
             tags.includes('date-night') ||
             (show.criticScore?.score ?? 0) >= 75;
    },
    sort: 'score',
    limit: 15,
    relatedGuides: ['best-broadway-shows', 'best-broadway-musicals'],
    relatedBrowse: ['broadway-shows-for-date-night'],
  },

  'broadway-shows-for-parents': {
    slug: 'broadway-shows-for-parents',
    title: 'Best Broadway Shows to See with Your Parents',
    h1Template: 'Best Broadway Shows to See with Your Parents ({year})',
    metaTitleTemplate: 'Best Broadway Shows for Parents {year} | Crowd-Pleasing Picks',
    metaDescriptionTemplate: 'Taking your parents to Broadway? These {count} shows are perfect for older adults — revivals, classics, Tony winners, and crowd-pleasing musicals.',
    introFallback: 'Taking your parents to see a Broadway show is one of the best gifts you can give. These {count} productions are ideal picks — from beloved revivals and Tony winners to crowd-pleasing musicals that resonate across generations.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      const tags = show.tags?.map(t => t.toLowerCase()) || [];
      // Revivals, classics, Tony winners, jukebox musicals, iconic shows, or high-scoring musicals
      return tags.includes('revival') ||
             tags.includes('classic') ||
             tags.includes('iconic') ||
             tags.includes('tony-winner') ||
             tags.includes('jukebox') ||
             (show.type === 'musical' && (show.criticScore?.score ?? 0) >= 75);
    },
    sort: 'score',
    relatedGuides: ['best-broadway-shows', 'best-broadway-musicals', 'best-broadway-revivals'],
    relatedBrowse: ['tony-winners-on-broadway', 'broadway-shows-for-tourists'],
  },

  // === PRICE TIERS ===
  'broadway-shows-under-100': {
    slug: 'broadway-shows-under-100',
    title: 'Broadway Shows Under $100',
    h1Template: 'Broadway Shows Under $100 ({year})',
    metaTitleTemplate: 'Broadway Shows Under $100 {year} | Affordable Tickets',
    metaDescriptionTemplate: 'Find {count} Broadway shows with tickets under $100 in {year}. Quality theater at affordable prices.',
    introFallback: "Great Broadway doesn't have to mean expensive tickets. These {count} shows offer tickets under $100, proving you can experience world-class theater on a budget.",
    filter: (show) => {
      if (show.status !== 'open') return false;
      const minPrice = Math.min(...(show.ticketLinks?.filter(l => l.priceFrom).map(l => l.priceFrom!) || [Infinity]));
      return minPrice < 100;
    },
    sort: 'score',
    relatedGuides: ['cheap-broadway-tickets', 'best-broadway-shows'],
    relatedBrowse: ['broadway-lottery-shows', 'broadway-rush-tickets'],
  },

  // === GENRE DEEP-DIVES ===
  'best-jukebox-musicals': {
    slug: 'best-jukebox-musicals',
    title: 'Best Jukebox Musicals on Broadway',
    h1Template: 'Best Jukebox Musicals on Broadway ({year})',
    metaTitleTemplate: 'Best Jukebox Musicals {year} | Broadway Song Catalog Shows',
    metaDescriptionTemplate: 'The {count} best jukebox musicals on Broadway in {year}. Shows featuring hit songs from famous artists and bands.',
    introFallback: 'Jukebox musicals bring beloved songs to life on the Broadway stage. These {count} shows feature iconic music from legendary artists, creating unforgettable theatrical experiences.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      const tags = show.tags?.map(t => t.toLowerCase()) || [];
      return tags.includes('jukebox') || tags.includes('jukebox-musical');
    },
    sort: 'score',
    relatedGuides: ['best-broadway-musicals', 'best-broadway-shows'],
    relatedBrowse: ['jukebox-musicals-on-broadway'],
  },

  'best-broadway-revivals': {
    slug: 'best-broadway-revivals',
    title: 'Best Broadway Revivals',
    h1Template: 'Best Broadway Revivals ({year})',
    metaTitleTemplate: 'Best Broadway Revivals {year} | Classic Shows Reimagined',
    metaDescriptionTemplate: 'The {count} best Broadway revivals in {year}. Classic shows brought back to life with fresh productions.',
    introFallback: 'Broadway revivals offer a chance to experience beloved classics with fresh perspectives. These {count} productions reimagine iconic shows for contemporary audiences.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      const tags = show.tags?.map(t => t.toLowerCase()) || [];
      return tags.includes('revival');
    },
    sort: 'score',
    relatedGuides: ['best-broadway-shows', 'highest-rated-broadway-shows'],
    relatedBrowse: ['best-broadway-revivals'],
  },

  // === AUDIENCE SEGMENTS ===
  'best-broadway-shows-for-teens': {
    slug: 'best-broadway-shows-for-teens',
    title: 'Best Broadway Shows for Teens',
    h1Template: 'Best Broadway Shows for Teenagers ({year})',
    metaTitleTemplate: 'Best Broadway Shows for Teens {year} | Ages 13+',
    metaDescriptionTemplate: 'The {count} best Broadway shows for teenagers in {year}. Age-appropriate musicals and plays that teens actually want to see.',
    introFallback: 'Finding a Broadway show that appeals to teenagers can be tricky — too young and they\'ll roll their eyes, too mature and it\'s awkward. These {count} shows hit the sweet spot for teen audiences.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      if ((show.criticScore?.score ?? 0) <= 0 || (show.criticScore?.reviewCount ?? 0) < 3) return false;
      const tags = show.tags?.map(t => t.toLowerCase()) || [];
      const ageRec = show.ageRecommendation?.toLowerCase() || '';
      // Teen-appropriate: either tagged for teens, or high-scoring musicals that aren't strictly for young kids
      return ageRec.includes('ages 12') || ageRec.includes('ages 13') || ageRec.includes('ages 14') ||
             tags.includes('teen') ||
             (show.type === 'musical' && (show.criticScore?.score ?? 0) >= 70 && !ageRec.includes('ages 4') && !ageRec.includes('ages 5'));
    },
    sort: 'score',
    relatedGuides: ['best-broadway-shows-for-kids', 'best-broadway-musicals', 'best-broadway-shows'],
    relatedBrowse: ['broadway-shows-for-teens', 'broadway-shows-for-kids'],
  },

  'best-broadway-shows-for-first-timers': {
    slug: 'best-broadway-shows-for-first-timers',
    title: 'Best Broadway Shows for First-Timers',
    h1Template: 'Best Broadway Shows for First-Timers ({year})',
    metaTitleTemplate: 'Best Broadway Shows for First-Timers {year} | Where to Start',
    metaDescriptionTemplate: 'Never been to Broadway? These {count} shows are perfect for your first time. Top-rated, crowd-pleasing productions.',
    introFallback: 'Your first Broadway show should be unforgettable. These {count} productions are perfect for newcomers — critically acclaimed, visually stunning, and guaranteed to hook you on live theater.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      if ((show.criticScore?.score ?? 0) < 70) return false;
      const tags = show.tags?.map(t => t.toLowerCase()) || [];
      // First-timer friendly: iconic, classic, accessible, or highly-rated musicals
      return tags.includes('iconic') || tags.includes('classic') || tags.includes('accessible') ||
             tags.includes('disney') || tags.includes('tony-winner') ||
             (show.type === 'musical' && (show.criticScore?.score ?? 0) >= 80);
    },
    sort: 'score',
    limit: 15,
    relatedGuides: ['best-broadway-shows', 'best-broadway-musicals', 'cheap-broadway-tickets'],
    relatedBrowse: ['first-time-broadway', 'broadway-shows-for-tourists'],
  },

  // === ADAPTATION GENRES ===
  'broadway-shows-based-on-movies': {
    slug: 'broadway-shows-based-on-movies',
    title: 'Broadway Shows Based on Movies',
    h1Template: 'Broadway Shows Based on Movies ({year})',
    metaTitleTemplate: 'Broadway Shows Based on Movies {year} | Screen-to-Stage',
    metaDescriptionTemplate: '{count} Broadway shows adapted from movies playing in {year}. See your favorite films come to life on stage.',
    introFallback: 'From animated Disney classics to indie cult films, Hollywood has long inspired Broadway productions. These {count} shows bring beloved movies to the stage with spectacular results.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      const tags = show.tags?.map(t => t.toLowerCase()) || [];
      return tags.includes('film-adaptation');
    },
    sort: 'score',
    relatedGuides: ['best-broadway-musicals', 'best-broadway-shows'],
    relatedBrowse: ['broadway-shows-based-on-movies', 'broadway-shows-based-on-books'],
  },

  'broadway-shows-based-on-true-stories': {
    slug: 'broadway-shows-based-on-true-stories',
    title: 'Broadway Shows Based on True Stories',
    h1Template: 'Broadway Shows Based on True Stories ({year})',
    metaTitleTemplate: 'Broadway Shows Based on True Stories {year} | Real-Life Dramas',
    metaDescriptionTemplate: '{count} Broadway shows inspired by true events playing in {year}. Real stories brought to life on stage.',
    introFallback: 'The most powerful stories are often the ones that really happened. These {count} Broadway productions are based on true events, real people, and remarkable stories that shaped history.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      const tags = show.tags?.map(t => t.toLowerCase()) || [];
      return tags.includes('based-on-true-story') || tags.includes('biography') || tags.includes('historical');
    },
    sort: 'score',
    relatedGuides: ['best-broadway-plays', 'best-broadway-shows'],
    relatedBrowse: ['broadway-shows-based-on-true-stories', 'best-broadway-dramas'],
  },

  'upcoming-broadway-shows': {
    slug: 'upcoming-broadway-shows',
    title: 'Upcoming Broadway Shows',
    h1Template: 'Upcoming Broadway Shows ({season} Season)',
    metaTitleTemplate: 'Upcoming Broadway Shows {year} | New Shows Coming Soon',
    metaDescriptionTemplate: '{count} new Broadway shows coming soon in {year}. Preview dates, opening nights, and what to expect.',
    introFallback: 'Exciting new productions are headed to Broadway. These {count} shows are in previews or about to begin performances — get ahead of the crowd and book early.',
    filter: (show) => {
      if (show.status !== 'previews' && show.status !== 'upcoming') return false;
      return true;
    },
    sort: 'opening-date',
    relatedGuides: ['best-new-broadway-shows', 'best-broadway-shows', 'broadway-shows-closing-soon'],
    relatedBrowse: ['upcoming-broadway-shows', 'new-broadway-shows-2026'],
  },

  // === SHORT SHOWS ===
  'short-broadway-shows': {
    slug: 'short-broadway-shows',
    title: 'Short Broadway Shows (Under 2 Hours)',
    h1Template: 'Short Broadway Shows Under 2 Hours ({year})',
    metaTitleTemplate: 'Short Broadway Shows {year} | Under 2 Hours Runtime',
    metaDescriptionTemplate: 'Find {count} Broadway shows under 2 hours in {year}. Perfect for busy schedules or first-time theatergoers.',
    introFallback: 'Not everyone has time for a 3-hour epic. These {count} Broadway shows clock in at under 2 hours, perfect for weeknight outings or first-time theatergoers.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      if (!show.runtime) return false;
      // Runtime format: "2h 15m" or "1h 40m"
      const match = show.runtime.match(/(\d+)h\s*(\d+)?m?/i);
      if (!match) return false;
      const hours = parseInt(match[1], 10) || 0;
      const mins = parseInt(match[2], 10) || 0;
      const totalMins = hours * 60 + mins;
      return totalMins > 0 && totalMins <= 120;
    },
    sort: 'score',
    relatedGuides: ['best-broadway-shows', 'best-broadway-shows-for-kids'],
    relatedBrowse: ['short-broadway-shows', 'broadway-shows-for-tourists'],
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
