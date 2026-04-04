// Browse Pages Configuration
// Defines all 17+ browse/landing pages for SEO

import { ComputedShow } from '@/lib/engine';
import type { AudienceBuzzData, ShowCommercial, ShowAwards, ShowGrosses } from '@/lib/data-types';

// Context object passed to dataFilter/customSort — avoids importing heavy data modules here
export interface BrowseFilterContext {
  // getAudienceBuzz(showId) / getShowAwards(showId) — take show ID
  // getShowCommercial(slug) / getShowGrosses(slug) — take show slug
  getAudienceBuzz: (showId: string) => AudienceBuzzData | undefined;
  getShowCommercial: (slug: string) => ShowCommercial | undefined;
  getShowAwards: (showId: string) => ShowAwards | undefined;
  getShowGrosses: (slug: string) => ShowGrosses | undefined;
}

export interface BrowsePageConfig {
  slug: string;
  title: string;
  h1: string;
  metaTitle: string; // Under 60 chars
  metaDescription: string; // 150-160 chars
  intro: string; // 100-200 words intro paragraph
  filter?: (show: ComputedShow) => boolean; // Simple filter (no data deps)
  dataFilter?: (show: ComputedShow, ctx: BrowseFilterContext) => boolean; // Data-dependent filter (used instead of filter when defined)
  customSort?: (shows: ComputedShow[], ctx: BrowseFilterContext) => ComputedShow[]; // Mutually exclusive with sort
  sort?: 'score' | 'opening-date' | 'opening-date-asc' | 'closing-date' | 'title' | 'performances';
  limit?: number;
  relatedPages: string[]; // Slugs of related browse pages
  source?: 'broadway' | 'west-end' | 'off-broadway' | 'off-west-end'; // Data source (default: broadway)
}

// Helper to parse runtime string to minutes
function parseRuntime(runtime?: string): number {
  if (!runtime) return 0;
  const match = runtime.match(/(\d+)h\s*(\d+)?m?/);
  if (!match) return 0;
  const hours = parseInt(match[1] || '0');
  const minutes = parseInt(match[2] || '0');
  return hours * 60 + minutes;
}

// Current year for meta titles — evaluated at build time (static export).
// Deploys happen multiple times per week, so this stays current.
const CURRENT_YEAR = new Date().getFullYear();

// Helper to check if show is closing within days
function isClosingWithinDays(show: ComputedShow, days: number): boolean {
  if (!show.closingDate) return false;
  const closing = new Date(show.closingDate);
  const now = new Date();
  const diffDays = Math.ceil((closing.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  return diffDays > 0 && diffDays <= days;
}

// Helper to check if show opened in year
function openedInYear(show: ComputedShow, year: number): boolean {
  const openDate = new Date(show.openingDate);
  return openDate.getFullYear() === year;
}

// Compute Broadway season (Jul-Jun) from opening date.
// Keep in sync with getSeason() in data-commercial.ts:95
function getShowSeason(show: ComputedShow): string | null {
  if (!show.openingDate) return null;
  const date = new Date(show.openingDate);
  if (isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  const month = date.getMonth();
  return month >= 6 ? `${year}-${year + 1}` : `${year - 1}-${year}`;
}

// Generate browse page configs for decades (skip 2010s/2020s — covered by guide pages)
function generateDecadeBrowsePages(): Record<string, BrowsePageConfig> {
  const decades = [
    { start: 1990, end: 1999, label: '1990s' },
    { start: 2000, end: 2009, label: '2000s' },
  ];

  const pages: Record<string, BrowsePageConfig> = {};
  for (const { start, end, label } of decades) {
    const slug = `best-broadway-shows-${label.toLowerCase()}`;
    pages[slug] = {
      slug,
      title: `Best Broadway Shows of the ${label}`,
      h1: `Best Broadway Shows of the ${label}`,
      metaTitle: `Best Broadway Shows of the ${label} — Ranked by Critics`,
      metaDescription: `Every Broadway show from the ${label} ranked by aggregated CriticScore. The best musicals, plays, and revivals from ${start} to ${end}.`,
      intro: `Every Broadway show that opened during the ${label} (${start}–${end}), ranked by aggregated CriticScore ratings from dozens of professional critics. This decade saw some of Broadway's most celebrated productions — from groundbreaking musicals to powerful dramas and revivals that redefined what theater could be. Whether you lived through this era or are discovering it for the first time, these rankings reveal which shows stood the test of critical scrutiny.`,
      filter: (show) => {
        if (!show.openingDate) return false;
        const year = new Date(show.openingDate).getFullYear();
        return year >= start && year <= end && (show.criticScore?.score ?? 0) > 0;
      },
      sort: 'score',
      relatedPages: decades
        .filter(d => d.label !== label)
        .map(d => `best-broadway-shows-${d.label.toLowerCase()}`)
        .concat(['best-broadway-musicals', 'best-broadway-plays']),
    };
  }
  return pages;
}

// Generate browse page configs for all Broadway seasons from 2006-2007 to present
// (2005-2006 excluded — too patchy in review coverage)
function generateSeasonBrowsePages(): Record<string, BrowsePageConfig> {
  const pages: Record<string, BrowsePageConfig> = {};
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();
  const endYear = currentMonth >= 6 ? currentYear + 1 : currentYear;

  for (let secondYear = 2007; secondYear <= endYear; secondYear++) {
    const firstYear = secondYear - 1;
    const season = `${firstYear}-${secondYear}`;
    const slug = `${season}-broadway-season`;

    // Build related pages: prev/next season + category pages
    const related: string[] = [];
    if (firstYear > 2005) {
      related.push(`${firstYear - 1}-${secondYear - 1}-broadway-season`);
    }
    if (secondYear < endYear) {
      related.push(`${firstYear + 1}-${secondYear + 1}-broadway-season`);
    }
    related.push('best-broadway-musicals', 'best-broadway-plays');

    pages[slug] = {
      slug,
      title: `${season} Broadway Season`,
      h1: `${season} Broadway Season`,
      metaTitle: `${season} Broadway Season \u2014 All Shows Ranked by Critics`,
      metaDescription: `Every show from the ${season} Broadway season ranked by CriticScore. ${firstYear}\u2013${secondYear} musicals, plays, and revivals compared side by side.`,
      intro: `Every show that opened on Broadway during the ${season} season (July ${firstYear} through June ${secondYear}), ranked by aggregated CriticScore ratings from dozens of outlets. This includes musicals, plays, and revivals \u2014 whether still running or closed.`,
      filter: (show) => getShowSeason(show) === season,
      sort: 'score',
      relatedPages: related,
    };
  }

  return pages;
}

export const BROWSE_PAGES: Record<string, BrowsePageConfig> = {
  'broadway-shows-for-kids': {
    slug: 'broadway-shows-for-kids',
    title: 'Best Broadway Shows for Kids',
    h1: 'Best Broadway Shows for Kids',
    metaTitle: `Best Broadway Shows for Kids (${CURRENT_YEAR})`,
    metaDescription: 'Find the best family-friendly Broadway shows for children. Our guide to kid-appropriate musicals and plays perfect for young theatergoers.',
    intro: 'Looking for the perfect Broadway show to take your kids to? We\'ve curated a list of the best family-friendly productions currently playing on Broadway. These shows feature age-appropriate content, engaging stories, and spectacle that will captivate young audiences. From Disney classics to new favorites, these productions offer the perfect introduction to the magic of live theater. Most of these shows also offer family-friendly pricing and matinee performances.',
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
    relatedPages: ['first-time-broadway', 'broadway-shows-for-tourists', 'short-broadway-shows'],
  },

  'broadway-shows-for-date-night': {
    slug: 'broadway-shows-for-date-night',
    title: 'Best Broadway Date Night Shows',
    h1: 'Best Broadway Date Night Shows',
    metaTitle: `Best Broadway Shows for Date Night (${CURRENT_YEAR})`,
    metaDescription: 'Romantic Broadway shows perfect for date night. From sweeping love stories to sophisticated dramas, find the ideal show for a memorable evening.',
    intro: 'Planning a romantic evening in New York? Broadway offers some of the most memorable date night experiences in the city. Whether you\'re looking for a sweeping romance, a sophisticated drama, or a spectacular musical, these shows deliver the perfect atmosphere for couples. We\'ve selected productions that combine quality storytelling with that special something that makes for an unforgettable night out together.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      const tags = show.tags?.map(t => t.toLowerCase()) || [];
      const ageRec = show.ageRecommendation?.toLowerCase() || '';
      return (tags.includes('romantic') || tags.includes('drama')) &&
             !ageRec.includes('ages 6') &&
             !ageRec.includes('ages 8');
    },
    sort: 'score',
    relatedPages: ['best-broadway-dramas', 'broadway-shows-for-tourists', 'broadway-shows-closing-soon'],
  },

  'broadway-shows-for-tourists': {
    slug: 'broadway-shows-for-tourists',
    title: 'Must-See Broadway Shows for Tourists',
    h1: 'Must-See Broadway Shows for Tourists',
    metaTitle: `Must-See Broadway Shows for Tourists (${CURRENT_YEAR})`,
    metaDescription: 'The essential Broadway shows every visitor to NYC should see. Iconic productions that define the Broadway experience for first-time visitors.',
    intro: 'Visiting New York City and want to experience the best of Broadway? These iconic shows represent the pinnacle of what Broadway has to offer. From long-running legends to critically acclaimed newer productions, these are the shows that define the Broadway experience. Whether it\'s your first time on Broadway or you\'re returning for another visit, these productions deliver unforgettable theatrical experiences that showcase why New York remains the theater capital of the world.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      const tags = show.tags?.map(t => t.toLowerCase()) || [];
      return tags.includes('iconic') || tags.includes('tony-winner');
    },
    sort: 'score',
    relatedPages: ['first-time-broadway', 'broadway-lottery-shows', 'broadway-shows-for-kids'],
  },

  'first-time-broadway': {
    slug: 'first-time-broadway',
    title: 'Best Broadway Shows for First-Timers',
    h1: 'Best Broadway Shows for First-Timers',
    metaTitle: `Best Broadway Shows for First-Timers (${CURRENT_YEAR})`,
    metaDescription: 'New to Broadway? These accessible, crowd-pleasing shows are perfect for your first theatrical experience. Start your Broadway journey here.',
    intro: 'Never been to a Broadway show before? Welcome! These productions are perfect for first-time theatergoers. We\'ve selected shows that are accessible, entertaining, and representative of what makes Broadway special. These aren\'t just "beginner" shows - they\'re critically acclaimed productions that happen to be particularly welcoming to newcomers. With engaging stories, spectacular staging, and universal themes, these shows will leave you excited to come back for more.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      const tags = show.tags?.map(t => t.toLowerCase()) || [];
      const hasGoodScore = (show.criticScore?.score || 0) >= 70;
      return (tags.includes('accessible') || tags.includes('family') ||
              (tags.includes('musical') && hasGoodScore));
    },
    sort: 'score',
    relatedPages: ['broadway-shows-for-tourists', 'broadway-shows-for-kids', 'broadway-lottery-shows'],
  },

  'broadway-shows-closing-soon': {
    slug: 'broadway-shows-closing-soon',
    title: 'Broadway Shows Closing Soon',
    h1: 'Broadway Shows Closing Soon',
    metaTitle: `Broadway Shows Closing Soon — Last Chance (${CURRENT_YEAR})`,
    metaDescription: 'These Broadway shows are closing soon — see exact closing dates and grab tickets before they\'re gone. Updated weekly with the latest announcements.',
    intro: 'Time is running out to see these Broadway productions! Whether they\'re limited engagements or shows that have announced their closing dates, these productions will be gone soon. If any of these have been on your must-see list, now is the time to act. Once a show closes on Broadway, there\'s no guarantee it will return. Don\'t let these slip away - book your tickets before it\'s too late.',
    filter: (show) => {
      return show.status === 'open' && isClosingWithinDays(show, 60);
    },
    sort: 'closing-date',
    relatedPages: ['new-broadway-shows-2025', 'broadway-shows-for-tourists', 'best-broadway-show-right-now'],
  },

  'new-broadway-shows-2025': {
    slug: 'new-broadway-shows-2025',
    title: 'New Broadway Shows in 2025',
    h1: 'New Broadway Shows in 2025',
    metaTitle: 'New Broadway Shows in 2025',
    metaDescription: 'All the new Broadway shows that opened in 2025. Fresh productions, world premieres, and exciting new musicals and plays on the Great White Way.',
    intro: 'Discover all the exciting new productions that opened on Broadway in 2025. From world premieres to highly anticipated transfers, these fresh shows are bringing new stories, new music, and new experiences to the Great White Way. Whether you\'re looking for the next big musical or an acclaimed new play, this is where you\'ll find Broadway\'s newest offerings. Many of these shows are still building buzz, making now the perfect time to see them before they become the next must-see hits.',
    filter: (show) => {
      return show.status === 'open' && openedInYear(show, 2025);
    },
    sort: 'opening-date',
    relatedPages: ['2024-2025-broadway-season', 'best-broadway-show-right-now', 'broadway-shows-closing-soon', 'tony-nominated-2025'],
  },

  'best-broadway-revivals': {
    slug: 'best-broadway-revivals',
    title: 'Best Broadway Revivals',
    h1: 'Best Broadway Revivals',
    metaTitle: `Best Broadway Revivals (${CURRENT_YEAR})`,
    metaDescription: 'The best Broadway revival productions currently playing. Classic shows reimagined for today\'s audiences with fresh perspectives and new stars.',
    intro: 'Broadway revivals bring beloved classics back to life with fresh perspectives, new stars, and reimagined staging. These productions honor the original material while offering something new - whether it\'s an innovative concept, a diverse cast, or simply the chance to experience a legendary show in person. From Tony-winning productions to intimate reimaginings, these revivals prove that great theater is timeless.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      if ((show.criticScore?.reviewCount ?? 0) < 3) return false;
      const tags = show.tags?.map(t => t.toLowerCase()) || [];
      return tags.includes('revival') || show.isRevival === true;
    },
    sort: 'score',
    relatedPages: ['tony-winners-on-broadway', 'best-broadway-musicals', 'best-broadway-dramas'],
  },

  'best-broadway-comedies': {
    slug: 'best-broadway-comedies',
    title: 'Best Broadway Comedies',
    h1: 'Best Broadway Comedies',
    metaTitle: `Best Broadway Comedies (${CURRENT_YEAR})`,
    metaDescription: 'The funniest shows on Broadway right now. Hilarious musicals and laugh-out-loud plays guaranteed to brighten your evening.',
    intro: 'Looking for a good laugh? Broadway\'s comedy offerings range from witty satire to outrageous farce, from musical comedy to sharp-tongued plays. These productions deliver genuine laughs while showcasing incredible talent. Whether you prefer subtle humor or broad comedy, clever wordplay or physical gags, there\'s a funny show waiting for you on Broadway. Laughter is the best medicine, and these shows are ready to provide it.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      const tags = show.tags?.map(t => t.toLowerCase()) || [];
      return tags.includes('comedy');
    },
    sort: 'score',
    relatedPages: ['best-broadway-musicals', 'broadway-shows-for-kids', 'short-broadway-shows'],
  },

  'best-broadway-dramas': {
    slug: 'best-broadway-dramas',
    title: 'Best Broadway Dramas',
    h1: 'Best Broadway Dramas',
    metaTitle: `Best Broadway Dramas (${CURRENT_YEAR})`,
    metaDescription: 'Powerful dramatic productions on Broadway. From intense plays to emotional musicals, these shows deliver unforgettable storytelling.',
    intro: 'Broadway drama offers some of the most powerful theatrical experiences available. These productions tackle complex themes, feature exceptional performances, and stay with you long after the curtain falls. From intimate character studies to sweeping epics, from classic revivals to world premieres, these shows represent the best of serious theater. If you\'re looking for a meaningful, thought-provoking evening at the theater, start here.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      const tags = show.tags?.map(t => t.toLowerCase()) || [];
      return tags.includes('drama');
    },
    sort: 'score',
    relatedPages: ['best-broadway-revivals', 'broadway-shows-for-date-night', 'tony-winners-on-broadway'],
  },

  'jukebox-musicals-on-broadway': {
    slug: 'jukebox-musicals-on-broadway',
    title: 'Jukebox Musicals on Broadway',
    h1: 'Jukebox Musicals on Broadway',
    metaTitle: `Jukebox Musicals on Broadway (${CURRENT_YEAR})`,
    metaDescription: 'Broadway musicals featuring hit songs you already know and love. From ABBA to Michael Jackson, sing along to your favorite music on stage.',
    intro: 'Jukebox musicals take songs you already know and love and weave them into compelling theatrical experiences. Whether built around the catalog of a legendary artist or assembling hits from an era, these shows offer the unique joy of hearing familiar music performed live on Broadway. From the dance-worthy hits to the power ballads, these productions let you experience beloved songs in an entirely new way while telling stories that give those songs new meaning.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      const tags = show.tags?.map(t => t.toLowerCase()) || [];
      return tags.includes('jukebox');
    },
    sort: 'score',
    relatedPages: ['best-broadway-comedies', 'broadway-shows-for-tourists', 'first-time-broadway'],
  },

  'broadway-lottery-shows': {
    slug: 'broadway-lottery-shows',
    title: 'Broadway Shows with Lotteries',
    h1: 'Broadway Shows with Lotteries',
    metaTitle: `Broadway Lottery Shows — Win $30 Tickets (${CURRENT_YEAR})`,
    metaDescription: 'Broadway shows offering digital lotteries for discounted tickets. Enter daily for your chance to see top shows at a fraction of the price.',
    intro: 'Broadway lotteries offer an incredible opportunity to see top shows at deeply discounted prices - often $30-40 for orchestra seats that normally cost hundreds. Most lotteries are digital and can be entered via apps like TodayTix or the show\'s official website. Enter early in the day for evening performances, and don\'t be discouraged if you don\'t win right away - persistence pays off! These shows all currently offer lottery programs.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      const tags = show.tags?.map(t => t.toLowerCase()) || [];
      return tags.includes('lottery');
    },
    sort: 'score',
    relatedPages: ['broadway-ticket-prices', 'broadway-rush-tickets', 'broadway-shows-for-tourists'],
  },

  'broadway-rush-tickets': {
    slug: 'broadway-rush-tickets',
    title: 'Broadway Rush Ticket Shows',
    h1: 'Broadway Rush Ticket Shows',
    metaTitle: `Broadway Rush Tickets — Same-Day Deals for Every Show (${CURRENT_YEAR})`,
    metaDescription: 'Broadway shows offering same-day rush tickets. Get discounted seats by arriving early at the box office or checking online portals.',
    intro: 'Rush tickets are same-day discounted tickets sold at the box office, typically when doors open or a few hours before showtime. Unlike lotteries, rush tickets are first-come, first-served, rewarding those willing to arrive early. Some shows also offer digital rush through apps. Prices typically range from $30-50, making Broadway accessible to those on a budget. Here are the shows currently offering rush ticket programs.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      const tags = show.tags?.map(t => t.toLowerCase()) || [];
      return tags.includes('rush');
    },
    sort: 'score',
    relatedPages: ['broadway-lottery-shows', 'broadway-shows-for-tourists', 'short-broadway-shows'],
  },

  'short-broadway-shows': {
    slug: 'short-broadway-shows',
    title: 'Short Broadway Shows',
    h1: 'Short Broadway Shows (Under 90 Minutes)',
    metaTitle: `Short Broadway Shows Under 90 Minutes (${CURRENT_YEAR})`,
    metaDescription: 'Broadway shows with runtimes under 90 minutes. Perfect for busy schedules or those who prefer a tight, focused theatrical experience.',
    intro: 'Not every Broadway show needs to be a three-hour epic. These shorter productions pack powerful experiences into 90 minutes or less, often with no intermission. They\'re perfect for those with busy schedules, families with younger children, or anyone who appreciates tight, focused storytelling. Don\'t let the shorter runtime fool you - these shows deliver complete, satisfying theatrical experiences.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      const runtime = parseRuntime(show.runtime);
      return runtime > 0 && runtime <= 90;
    },
    sort: 'score',
    relatedPages: ['broadway-shows-no-intermission', 'broadway-shows-for-kids', 'best-broadway-comedies'],
  },

  'broadway-shows-no-intermission': {
    slug: 'broadway-shows-no-intermission',
    title: 'Broadway Shows with No Intermission',
    h1: 'Broadway Shows with No Intermission',
    metaTitle: `Broadway Shows with No Intermission (${CURRENT_YEAR})`,
    metaDescription: 'Broadway productions that run straight through with no intermission. Immersive experiences that keep you engaged from start to finish.',
    intro: 'Some of Broadway\'s most immersive experiences come from shows that run straight through without an intermission. These productions create an unbroken theatrical journey, maintaining tension, emotion, or energy without a break. Whether it\'s a gripping drama, a high-energy musical, or an intimate play, these shows command your attention from the first moment to the last. Perfect for those who love to be fully absorbed in the story.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      return show.intermissions === 0;
    },
    sort: 'score',
    relatedPages: ['short-broadway-shows', 'best-broadway-dramas', 'best-broadway-comedies'],
  },

  'tony-winners-on-broadway': {
    slug: 'tony-winners-on-broadway',
    title: 'Tony Winning Shows Now on Broadway',
    h1: 'Tony Winning Shows Now on Broadway',
    metaTitle: `Tony Award Winners on Broadway (${CURRENT_YEAR})`,
    metaDescription: 'See Tony Award-winning shows currently playing on Broadway. The best of the best, as recognized by the theater industry\'s highest honors.',
    intro: 'The Tony Awards represent the highest honors in American theater, and these shows have earned Broadway\'s most prestigious accolades. Whether they won Best Musical, Best Play, or collected multiple awards for their creative teams, these productions represent the pinnacle of theatrical achievement. Seeing a Tony winner is a chance to experience shows that have been recognized as the very best Broadway has to offer.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      const tags = show.tags?.map(t => t.toLowerCase()) || [];
      return tags.includes('tony-winner');
    },
    sort: 'score',
    relatedPages: ['best-broadway-soundtracks', 'best-broadway-revivals', 'broadway-shows-for-tourists'],
  },

  'tony-nominated-2025': {
    slug: 'tony-nominated-2025',
    title: '2025 Tony Nominees Still Playing',
    h1: '2025 Tony Nominees Still Playing',
    metaTitle: '2025 Tony Award Nominees on Broadway',
    metaDescription: 'See the 2025 Tony Award nominated shows still running on Broadway. Catch these celebrated productions before they close.',
    intro: 'The 2025 Tony Award nominees represent the best of the recent Broadway season. While some nominees have since closed, these shows are still running, giving you the chance to see the productions that captured the attention of Tony voters. Whether they took home the top prizes or were recognized with nominations, these shows offer exceptional theatrical experiences that have been celebrated by industry insiders.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      const tags = show.tags?.map(t => t.toLowerCase()) || [];
      return tags.includes('tony-nominated-2025');
    },
    sort: 'score',
    relatedPages: ['tony-winners-on-broadway', 'new-broadway-shows-2025', 'best-broadway-show-right-now'],
  },

  'best-broadway-show-right-now': {
    slug: 'best-broadway-show-right-now',
    title: 'The Best Broadway Show Right Now',
    h1: 'The Best Broadway Show Right Now',
    metaTitle: `The #1 Best Broadway Show Right Now (${CURRENT_YEAR}) — Data Says...`,
    metaDescription: 'What\'s the single best show on Broadway today? Based on our aggregated CriticScore ratings, here\'s our top pick for the best show to see right now.',
    intro: 'If you could only see one Broadway show, which should it be? Based on our comprehensive analysis of critic reviews, we\'ve identified the single best show currently playing on Broadway. This isn\'t just about popularity or longevity - it\'s about quality as measured by the people who see the most theater: professional critics. Whether you\'re a first-timer or a seasoned theatergoer, this is the show that delivers the best experience right now.',
    filter: (show) => {
      return show.status === 'open' && (show.criticScore?.score ?? 0) > 0;
    },
    sort: 'score',
    limit: 1,
    relatedPages: ['broadway-shows-for-tourists', 'tony-winners-on-broadway', 'first-time-broadway'],
  },

  'best-broadway-musicals': {
    slug: 'best-broadway-musicals',
    title: 'Best Broadway Musicals',
    h1: 'Best Broadway Musicals',
    metaTitle: `Best Broadway Musicals (${CURRENT_YEAR}) — Ranked by Critics`,
    metaDescription: 'Every Broadway musical ranked by aggregated critic scores from NYT, Variety, Vulture & 400+ outlets. See which musicals are must-sees and which to skip.',
    intro: 'Broadway musicals represent the pinnacle of theatrical entertainment, combining compelling stories with unforgettable songs, spectacular staging, and incredible performances. These are the highest-rated musicals currently playing on Broadway, as determined by aggregated critic reviews. Whether you\'re looking for a classic, a new hit, or something in between, these productions deliver the very best of what musical theater has to offer.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      return show.type === 'musical' && (show.criticScore?.reviewCount ?? 0) >= 3;
    },
    sort: 'score',
    relatedPages: ['best-recent-musicals', 'jukebox-musicals-on-broadway', 'best-broadway-revivals'],
  },

  'best-recent-shows': {
    slug: 'best-recent-shows',
    title: 'Best Recent Broadway Shows',
    h1: 'Best Recent Broadway Shows',
    metaTitle: `Best Recent Broadway Shows (${CURRENT_YEAR}) — Musicals & Plays Ranked by Critics`,
    metaDescription: 'The highest-rated musicals and plays that opened on Broadway in the past year. See which new shows are must-sees right now.',
    intro: 'These are the best new shows that have opened on Broadway in the past 12 months — musicals and plays alike. From world premieres to acclaimed transfers, these recent arrivals represent the cutting edge of Broadway. See what\'s exciting audiences and earning critical acclaim right now.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      if (show.type !== 'musical' && show.type !== 'play') return false;
      if ((show.criticScore?.reviewCount ?? 0) < 3) return false;
      const twelveMonthsAgo = new Date();
      twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
      const openDate = new Date(show.openingDate);
      return openDate >= twelveMonthsAgo;
    },
    sort: 'score',
    relatedPages: ['best-broadway-musicals', 'best-recent-plays', 'new-broadway-shows-2025', 'tony-winners-on-broadway'],
  },

  'best-recent-musicals': {
    slug: 'best-recent-musicals',
    title: 'Best Recent Broadway Musicals',
    h1: 'Best Recent Broadway Musicals',
    metaTitle: `Best Recent Broadway Musicals (${CURRENT_YEAR})`,
    metaDescription: 'The highest-rated musicals that opened on Broadway in the past year. Fresh productions setting the new standard for musical theater.',
    intro: 'These are the best new musicals that have opened on Broadway in the past 12 months. Fresh off their opening nights, these productions represent the cutting edge of musical theater. From world premieres to acclaimed transfers, these recent arrivals are making their mark on the Great White Way. See what\'s exciting audiences and critics right now.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      if (show.type !== 'musical') return false;
      if ((show.criticScore?.reviewCount ?? 0) < 3) return false;
      const twelveMonthsAgo = new Date();
      twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
      const openDate = new Date(show.openingDate);
      return openDate >= twelveMonthsAgo;
    },
    sort: 'score',
    relatedPages: ['best-recent-shows', 'best-broadway-musicals', 'new-broadway-shows-2025', 'tony-winners-on-broadway'],
  },

  'best-recent-plays': {
    slug: 'best-recent-plays',
    title: 'Best Recent Broadway Plays',
    h1: 'Best Recent Broadway Plays',
    metaTitle: `Best Recent Broadway Plays (${CURRENT_YEAR})`,
    metaDescription: 'The highest-rated plays that opened on Broadway in the past year. Fresh productions pushing the boundaries of dramatic theater.',
    intro: 'These are the best new plays that have opened on Broadway in the past 12 months. From powerful dramas to sharp comedies, these recent productions showcase the best of contemporary playwriting and performance. See what\'s captivating audiences and earning critical acclaim right now.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      if (show.type !== 'play') return false;
      if ((show.criticScore?.reviewCount ?? 0) < 3) return false;
      const twelveMonthsAgo = new Date();
      twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
      const openDate = new Date(show.openingDate);
      return openDate >= twelveMonthsAgo;
    },
    sort: 'score',
    relatedPages: ['best-broadway-plays', 'best-broadway-dramas', 'best-broadway-comedies'],
  },

  'best-broadway-plays': {
    slug: 'best-broadway-plays',
    title: 'Best Broadway Plays',
    h1: 'Best Broadway Plays',
    metaTitle: `Best Broadway Plays (${CURRENT_YEAR})`,
    metaDescription: 'The highest-rated plays currently on Broadway. Powerful dramas, sharp comedies, and thought-provoking theater at its finest.',
    intro: 'Broadway plays offer some of the most powerful and intimate theatrical experiences available. Without the spectacle of big musical numbers, plays rely on exceptional writing, direction, and performances to captivate audiences. These are the highest-rated plays currently on Broadway, ranging from gripping dramas to sharp comedies. If you\'re looking for theater that challenges, moves, and stays with you, these productions deliver.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      return show.type === 'play' && (show.criticScore?.reviewCount ?? 0) >= 3;
    },
    sort: 'score',
    relatedPages: ['best-broadway-dramas', 'best-broadway-comedies', 'tony-winners-on-broadway'],
  },

  'longest-running-broadway-shows': {
    slug: 'longest-running-broadway-shows',
    title: 'Longest Running Broadway Shows',
    h1: 'Longest Running Broadway Shows',
    metaTitle: `Longest Running Broadway Shows (${CURRENT_YEAR})`,
    metaDescription: 'The longest running shows currently on Broadway by total performances. See the legendary productions that have stood the test of time.',
    intro: 'These shows have earned their place in Broadway history through thousands of performances and years of entertaining audiences. From beloved classics to modern phenomena, these productions represent the staying power of great theater. Their longevity is a testament to timeless storytelling, memorable music, and the countless talented performers who have graced their stages night after night.',
    filter: (show) => show.status === 'open',
    sort: 'performances',
    relatedPages: ['biggest-broadway-flops', 'tony-winners-on-broadway', 'broadway-shows-for-tourists'],
  },

  'upcoming-broadway-shows': {
    slug: 'upcoming-broadway-shows',
    title: 'Upcoming Broadway Shows',
    h1: 'Upcoming Broadway Shows',
    metaTitle: `Upcoming Broadway Shows (${CURRENT_YEAR})`,
    metaDescription: 'New Broadway shows coming soon. See what\'s opening next on the Great White Way, from world premieres to highly anticipated transfers.',
    intro: 'Get excited for Broadway\'s next wave of productions! These shows are currently in previews or have announced opening dates in the coming months. From world premieres to transfers from Off-Broadway and London, these productions represent the future of Broadway. Many are already selling tickets, so if you\'re planning ahead, here\'s your guide to what\'s coming to the Great White Way.',
    filter: (show) => show.status === 'previews' || show.status === 'upcoming',
    sort: 'opening-date-asc',
    relatedPages: ['new-broadway-shows-2025', 'broadway-shows-closing-soon', 'broadway-lottery-shows'],
  },

  'broadway-shows-for-teens': {
    slug: 'broadway-shows-for-teens',
    title: 'Best Broadway Shows for Teens',
    h1: 'Best Broadway Shows for Teens',
    metaTitle: `Best Broadway Shows for Teenagers (${CURRENT_YEAR})`,
    metaDescription: 'Broadway shows perfect for teenagers. Age-appropriate productions with themes and stories that resonate with teen audiences.',
    intro: 'Looking for Broadway shows that will actually engage your teenager? These productions feature themes, stories, and music that resonate with teen audiences while remaining age-appropriate. From coming-of-age stories to high-energy musicals, these shows offer the perfect introduction to Broadway for older kids who\'ve outgrown the purely family-friendly fare. Many of these productions deal with relatable topics like identity, belonging, and growing up.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      const ageRec = show.ageRecommendation?.toLowerCase() || '';
      // Ages 10+ through 14+ are teen-appropriate
      return ageRec.includes('ages 10') ||
             ageRec.includes('ages 12') ||
             ageRec.includes('ages 13') ||
             ageRec.includes('ages 14');
    },
    sort: 'score',
    relatedPages: ['broadway-shows-for-kids', 'first-time-broadway', 'best-broadway-musicals'],
  },

  'broadway-shows-under-2-hours': {
    slug: 'broadway-shows-under-2-hours',
    title: 'Broadway Shows Under 2 Hours',
    h1: 'Broadway Shows Under 2 Hours',
    metaTitle: `Broadway Shows Under 2 Hours (${CURRENT_YEAR})`,
    metaDescription: 'Broadway shows with runtimes under 2 hours including intermission. Perfect for busy schedules or evening plans after the show.',
    intro: 'Want to see a Broadway show but have dinner reservations or an early flight? These productions clock in at under two hours, giving you a complete theatrical experience without the lengthy time commitment. Whether you\'re short on time, have kids with limited attention spans, or just prefer a tighter show, these productions prove that great theater doesn\'t have to be an all-night affair. Most still include an intermission for a quick stretch.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      const runtime = parseRuntime(show.runtime);
      return runtime > 0 && runtime <= 120;
    },
    sort: 'score',
    relatedPages: ['short-broadway-shows', 'broadway-shows-no-intermission', 'broadway-shows-for-kids'],
  },

  'broadway-shows-based-on-movies': {
    slug: 'broadway-shows-based-on-movies',
    title: 'Broadway Shows Based on Movies',
    h1: 'Broadway Shows Based on Movies',
    metaTitle: `Broadway Musicals Based on Movies (${CURRENT_YEAR})`,
    metaDescription: 'Broadway shows adapted from popular films. See your favorite movies come to life on stage with spectacular music, dance, and staging.',
    intro: 'Love a movie? See it live on Broadway! These productions bring beloved films to the stage, often expanding the story with new songs, elaborate choreography, and the unique magic of live theater. From Disney classics to cult favorites, these adaptations offer a fresh take on stories you already know and love. Whether you\'re curious how they\'ll translate your favorite film or want to introduce someone to a story through live performance, these shows deliver familiar tales in spectacular new ways.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      const tags = show.tags?.map(t => t.toLowerCase()) || [];
      return tags.includes('film-adaptation');
    },
    sort: 'score',
    relatedPages: ['broadway-shows-based-on-books', 'broadway-shows-based-on-true-stories', 'jukebox-musicals-on-broadway'],
  },

  'new-broadway-shows-2026': {
    slug: 'new-broadway-shows-2026',
    title: 'New Broadway Shows in 2026',
    h1: 'New Broadway Shows in 2026',
    metaTitle: 'New Broadway Shows Opening in 2026',
    metaDescription: 'All the new Broadway shows opening in 2026. Fresh productions, world premieres, and anticipated transfers hitting the Great White Way this year.',
    intro: 'Discover all the exciting new productions opening on Broadway in 2026. From world premieres to highly anticipated transfers, these fresh shows are bringing new stories, new music, and new experiences to the Great White Way. Whether you\'re looking for the next big musical or an acclaimed new play, this is where you\'ll find Broadway\'s newest offerings.',
    filter: (show) => {
      return show.status === 'open' && openedInYear(show, 2026);
    },
    sort: 'opening-date',
    relatedPages: ['2025-2026-broadway-season', 'new-broadway-shows-2025', 'upcoming-broadway-shows', 'best-broadway-show-right-now'],
  },

  'new-broadway-shows-2024': {
    slug: 'new-broadway-shows-2024',
    title: 'New Broadway Shows from 2024',
    h1: 'New Broadway Shows from 2024',
    metaTitle: 'Broadway Shows That Opened in 2024',
    metaDescription: 'Broadway shows that opened in 2024 and are still running. See last year\'s openings that proved they have staying power.',
    intro: 'These Broadway shows opened in 2024 and are still going strong. Having survived their first year, these productions have proven they have the staying power audiences and producers hope for. From critical darlings to audience favorites, these 2024 openings represent some of the best recent additions to Broadway.',
    filter: (show) => {
      return show.status === 'open' && openedInYear(show, 2024);
    },
    sort: 'score',
    relatedPages: ['2023-2024-broadway-season', 'new-broadway-shows-2025', 'new-broadway-shows-2026', 'best-broadway-show-right-now'],
  },

  'long-broadway-shows': {
    slug: 'long-broadway-shows',
    title: 'Long Broadway Shows (2.5+ Hours)',
    h1: 'Long Broadway Shows (2.5+ Hours)',
    metaTitle: `Long Broadway Shows Over 2.5 Hours (${CURRENT_YEAR})`,
    metaDescription: 'Broadway\'s epic theatrical experiences running 2.5+ hours. Immersive productions that demand and reward your full evening.',
    intro: 'Some stories need more time to tell. These Broadway productions run two and a half hours or more, offering immersive theatrical experiences that transport you into fully realized worlds. From sweeping historical dramas to elaborate musical extravaganzas, these shows reward your time investment with unforgettable journeys. Plan for a full evening — these aren\'t shows to rush through.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      const runtime = parseRuntime(show.runtime);
      return runtime >= 150; // 2.5 hours
    },
    sort: 'score',
    relatedPages: ['short-broadway-shows', 'best-broadway-musicals', 'best-broadway-dramas'],
  },

  // West End browse pages
  'west-end-shows': {
    slug: 'west-end-shows',
    title: 'West End Shows',
    h1: 'West End Shows — London Theatre Ratings',
    metaTitle: 'West End Shows — London Theatre CriticScore Ratings',
    metaDescription: 'Complete ranked list of West End shows by CriticScore. Aggregated ratings from The Guardian, Telegraph, Time Out, WhatsOnStage, and more.',
    intro: 'Every currently running and recently closed West End show in London, ranked by aggregated CriticScore ratings. We collect reviews from the UK\'s top theatre critics — including The Guardian, The Telegraph, Time Out London, WhatsOnStage, and The Stage — and combine them into a single score. Whether you\'re a London local or planning a theatre trip, find out which West End shows are getting the best reviews right now.',
    filter: (show) => show.category === 'west-end',
    sort: 'score',
    source: 'west-end',
    relatedPages: ['best-west-end-musicals', 'best-west-end-plays', 'upcoming-west-end-shows', 'west-end-shows-for-kids'],
  },

  // === SEO Content Pages ===

  'best-broadway-shows-all-time': {
    slug: 'best-broadway-shows-all-time',
    title: 'Best Broadway Shows of All Time',
    h1: 'Best Broadway Shows of All Time',
    metaTitle: 'Best Broadway Shows of All Time — Ranked by Critics',
    metaDescription: 'Every scored Broadway show ranked by aggregated CriticScore. The definitive all-time ranking of Broadway musicals, plays, and revivals.',
    intro: 'Every Broadway show we\'ve scored, ranked by aggregated CriticScore ratings from dozens of professional critics and publications. This isn\'t a popularity contest or a list of personal favorites — it\'s a data-driven ranking based on the collective judgment of theater critics across The New York Times, Variety, Vulture, and dozens more. From recent hits to classic revivals, these rankings span decades of Broadway history. Whether you\'re settling a debate or discovering your next obsession, this is the most comprehensive critical ranking of Broadway shows available anywhere.',
    filter: (show) => (show.criticScore?.score ?? 0) > 0,
    sort: 'score',
    relatedPages: ['best-broadway-shows-1990s', 'best-broadway-shows-2000s', 'best-broadway-musicals', 'best-broadway-plays'],
  },

  'most-divisive-broadway-shows': {
    slug: 'most-divisive-broadway-shows',
    title: 'Most Divisive Broadway Shows',
    h1: 'Most Divisive Broadway Shows — Critics vs. Audiences',
    metaTitle: 'Most Divisive Broadway Shows — Critics vs. Audiences',
    metaDescription: 'Broadway shows where critics and audiences disagree most. The biggest gaps between CriticScore and audience ratings, ranked by controversy.',
    intro: 'These are the Broadway shows where critics and audiences see things very differently. We measure the gap between our aggregated CriticScore (from professional reviews) and audience ratings (from ShowScore, Mezzanine, and Reddit). A large gap means one group loved a show the other didn\'t — whether it\'s a crowd-pleaser critics panned or a critical darling audiences shrugged at. Sorted by the size of the disagreement, these shows spark the most heated debates about what makes great theater.',
    dataFilter: (show, ctx) => {
      if ((show.criticScore?.score ?? 0) === 0) return false;
      const buzz = ctx.getAudienceBuzz(show.id);
      if (!buzz?.combinedScore) return false;
      const gap = Math.abs(show.criticScore!.score - buzz.combinedScore);
      return gap >= 15;
    },
    customSort: (shows, ctx) => {
      return shows.sort((a, b) => {
        const aBuzz = ctx.getAudienceBuzz(a.id);
        const bBuzz = ctx.getAudienceBuzz(b.id);
        const aGap = Math.abs((a.criticScore?.score ?? 0) - (aBuzz?.combinedScore ?? 0));
        const bGap = Math.abs((b.criticScore?.score ?? 0) - (bBuzz?.combinedScore ?? 0));
        return bGap - aGap;
      });
    },
    relatedPages: ['best-broadway-shows-all-time', 'best-broadway-musicals', 'best-broadway-plays'],
  },

  'broadway-ticket-prices': {
    slug: 'broadway-ticket-prices',
    title: 'Broadway Ticket Prices',
    h1: 'Broadway Ticket Prices — Average Cost per Show',
    metaTitle: `Broadway Ticket Prices — Average Cost per Show (${CURRENT_YEAR})`,
    metaDescription: 'Current average ticket prices for every Broadway show. Compare costs across musicals and plays to find the best value for your budget.',
    intro: 'How much does a Broadway ticket actually cost? This page shows the current average ticket price (ATP) for every open Broadway show, pulled from weekly box office grosses data. ATP is calculated by dividing total gross revenue by tickets sold, giving you a real-world average that includes premium, regular, and discounted seats. Use this to compare costs and find shows that fit your budget — or discover which productions command the highest prices.',
    dataFilter: (show, ctx) => {
      if (show.status !== 'open') return false;
      const grosses = ctx.getShowGrosses(show.slug);
      return (grosses?.thisWeek?.atp ?? 0) > 0;
    },
    customSort: (shows, ctx) => {
      return shows.sort((a, b) => {
        const aAtp = ctx.getShowGrosses(a.slug)?.thisWeek?.atp ?? 0;
        const bAtp = ctx.getShowGrosses(b.slug)?.thisWeek?.atp ?? 0;
        return bAtp - aAtp;
      });
    },
    relatedPages: ['broadway-lottery-shows', 'broadway-rush-tickets', 'best-broadway-show-right-now'],
  },

  'broadway-shows-based-on-books': {
    slug: 'broadway-shows-based-on-books',
    title: 'Broadway Shows Based on Books',
    h1: 'Broadway Shows Based on Books',
    metaTitle: `Broadway Musicals & Plays Based on Books (${CURRENT_YEAR})`,
    metaDescription: 'Broadway shows adapted from novels and books. See beloved literary works brought to life on stage with music, drama, and spectacle.',
    intro: 'From beloved novels to unexpected page-to-stage adaptations, these Broadway shows bring literary works to life with the unique magic of live theater. Books have always been a rich source of Broadway material — their deep characters, complex plots, and built-in audiences make them ideal for theatrical adaptation. Whether you read the book first or discover the story through the show, these productions prove that great literature makes for great theater.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      const tags = show.tags?.map(t => t.toLowerCase()) || [];
      return tags.includes('based-on-book');
    },
    sort: 'score',
    relatedPages: ['broadway-shows-based-on-true-stories', 'broadway-shows-based-on-movies', 'best-broadway-musicals'],
  },

  'broadway-shows-based-on-true-stories': {
    slug: 'broadway-shows-based-on-true-stories',
    title: 'Broadway Shows Based on True Stories',
    h1: 'Broadway Shows Based on True Stories',
    metaTitle: `Broadway Shows Based on True Stories (${CURRENT_YEAR})`,
    metaDescription: 'Broadway musicals and plays inspired by real events and people. True stories brought to life on stage with unforgettable performances.',
    intro: 'The best stories are often true. These Broadway shows draw from real events, real people, and real history to create theatrical experiences that are both entertaining and enlightening. From biographical musicals about legendary figures to plays that dramatize pivotal moments in history, these productions prove that truth really can be stranger — and more compelling — than fiction. Each show takes creative liberties, but the emotional core comes from events that actually happened.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      const tags = show.tags?.map(t => t.toLowerCase()) || [];
      return tags.includes('based-on-true-story');
    },
    sort: 'score',
    relatedPages: ['broadway-shows-based-on-books', 'broadway-shows-based-on-movies', 'best-broadway-dramas'],
  },

  'biggest-broadway-flops': {
    slug: 'biggest-broadway-flops',
    title: 'Biggest Broadway Flops',
    h1: 'Biggest Broadway Flops',
    metaTitle: 'Biggest Broadway Flops — Commercial Failures Ranked',
    metaDescription: 'Broadway\'s biggest commercial failures. Shows designated as Flops and Fizzles based on capitalization, run length, and recoupment data.',
    intro: 'Not every Broadway show is a hit. These productions were designated as commercial failures — either "Flops" (significant financial losses) or "Fizzles" (underperformers that failed to recoup their investment). Our designations are based on capitalization costs, run length, box office performance, and whether the show recouped its investment. Some of these shows were critical darlings that couldn\'t find an audience; others were panned by critics and audiences alike. Together, they tell the story of Broadway\'s high-risk economics, where even the most ambitious productions can fall short.',
    dataFilter: (show, ctx) => {
      const commercial = ctx.getShowCommercial(show.slug);
      if (!commercial) return false;
      return commercial.designation === 'Flop' || commercial.designation === 'Fizzle';
    },
    sort: 'opening-date',
    relatedPages: ['best-broadway-shows-all-time', 'broadway-ticket-prices', 'longest-running-broadway-shows'],
  },

  'best-broadway-soundtracks': {
    slug: 'best-broadway-soundtracks',
    title: 'Best Broadway Soundtracks',
    h1: 'Best Broadway Soundtracks — Tony Score Nominees',
    metaTitle: 'Best Broadway Soundtracks — Tony Best Score Nominees',
    metaDescription: 'Broadway shows nominated for Tony Award for Best Original Score. The best original music written for the stage, ranked by CriticScore.',
    intro: 'The Tony Award for Best Original Score recognizes the finest original music written for Broadway. These shows were nominated for — or won — this prestigious award, meaning their music was deemed among the best of its season by Tony voters. From sweeping orchestral scores to contemporary pop-influenced soundtracks, these productions represent the gold standard of Broadway music. Ranked by our aggregated CriticScore, which reflects the overall quality of the production, not just its music.',
    dataFilter: (show, ctx) => {
      const awards = ctx.getShowAwards(show.id);
      if (!awards?.tony) return false;
      const all = [...(awards.tony.nominatedFor || []), ...(awards.tony.wins || [])];
      return all.some(c => c.includes('Best Original Score'));
    },
    sort: 'score',
    relatedPages: ['best-broadway-shows-all-time', 'tony-winners-on-broadway', 'best-broadway-musicals'],
  },

  // Decade browse pages (1990s, 2000s — 2010s/2020s covered by guide pages)
  ...generateDecadeBrowsePages(),

  // === West End Browse Pages ===

  'best-west-end-musicals': {
    slug: 'best-west-end-musicals',
    title: 'Best West End Musicals',
    h1: 'Best West End Musicals — London Theatre Rankings',
    metaTitle: `Best West End Musicals (${CURRENT_YEAR}) — Ranked by Critics`,
    metaDescription: 'The best West End musicals in London right now, ranked by aggregated critic reviews from The Guardian, Telegraph, Time Out, WhatsOnStage, and more.',
    intro: 'Every currently running West End musical in London, ranked by aggregated CriticScore ratings. We collect reviews from the UK\'s leading theatre critics — The Guardian, The Telegraph, Time Out London, WhatsOnStage, The Stage, and more — and combine them into a single weighted score. Whether you\'re a London local choosing your next night out or a tourist planning a theatre trip, this is the definitive ranked list of West End musicals playing right now.',
    filter: (show) => show.category === 'west-end' && show.status === 'open' && show.type === 'musical' && (show.criticScore?.reviewCount ?? 0) >= 3,
    sort: 'score',
    source: 'west-end',
    relatedPages: ['best-west-end-plays', 'west-end-shows', 'west-end-shows-for-kids', 'best-broadway-musicals'],
  },

  'best-west-end-plays': {
    slug: 'best-west-end-plays',
    title: 'Best West End Plays',
    h1: 'Best West End Plays — London Theatre Rankings',
    metaTitle: `Best West End Plays (${CURRENT_YEAR}) — Ranked by Critics`,
    metaDescription: 'The best West End plays in London right now, ranked by aggregated critic reviews from The Guardian, Telegraph, Time Out, WhatsOnStage, and more.',
    intro: 'Every currently running West End play in London, ranked by aggregated CriticScore ratings. From gripping dramas to sharp comedies, these plays represent the finest non-musical theatre London has to offer. Our scores aggregate reviews from the UK\'s top theatre critics — The Guardian, The Telegraph, Time Out London, WhatsOnStage, and The Stage — into a single weighted score that reflects the critical consensus.',
    filter: (show) => show.category === 'west-end' && show.status === 'open' && show.type === 'play' && (show.criticScore?.reviewCount ?? 0) >= 3,
    sort: 'score',
    source: 'west-end',
    relatedPages: ['best-west-end-musicals', 'west-end-shows', 'longest-running-west-end-shows', 'best-broadway-plays'],
  },

  'upcoming-west-end-shows': {
    slug: 'upcoming-west-end-shows',
    title: 'Upcoming West End Shows',
    h1: 'Upcoming West End Shows — What\'s Coming to London',
    metaTitle: `Upcoming West End Shows (${CURRENT_YEAR})`,
    metaDescription: 'All upcoming West End shows opening in London. New musicals, plays, and transfers coming to the West End, sorted by opening date.',
    intro: 'Every West End show announced for London\'s theatre district, sorted by opening date. From highly anticipated transfers to world premieres, these are the productions headed to the West End. Bookmark this page to stay up to date on what\'s coming to London theatre — we update it as new shows are announced and opening dates are confirmed.',
    filter: (show) => show.category === 'west-end' && (show.status === 'upcoming' || show.status === 'previews'),
    sort: 'opening-date-asc',
    source: 'west-end',
    relatedPages: ['new-west-end-shows-2026', 'west-end-shows', 'best-west-end-musicals', 'upcoming-broadway-shows'],
  },

  'west-end-shows-for-kids': {
    slug: 'west-end-shows-for-kids',
    title: 'West End Shows for Kids',
    h1: 'Best West End Shows for Kids — Family-Friendly London Theatre',
    metaTitle: `Best West End Shows for Kids (${CURRENT_YEAR})`,
    metaDescription: 'The best family-friendly West End shows in London for children. Age-appropriate musicals and plays perfect for young theatregoers.',
    intro: 'Planning a family theatre trip to London? These West End shows are recommended for children, with age recommendations ranging from 5 to 8 years old. From spectacular musicals to imaginative adaptations, these productions offer the perfect introduction to live theatre for young audiences. Each show has been vetted for age-appropriate content, and many offer family-friendly matinee performances and group pricing.',
    filter: (show) => {
      if (show.category !== 'west-end' || show.status !== 'open') return false;
      const ageRec = show.ageRecommendation?.toLowerCase() || '';
      return ageRec.includes('ages 5') ||
             ageRec.includes('ages 6') ||
             ageRec.includes('ages 7') ||
             ageRec.includes('ages 8') ||
             ageRec.includes('all ages');
    },
    sort: 'score',
    source: 'west-end',
    relatedPages: ['west-end-shows', 'best-west-end-musicals', 'broadway-shows-for-kids'],
  },

  'longest-running-west-end-shows': {
    slug: 'longest-running-west-end-shows',
    title: 'Longest-Running West End Shows',
    h1: 'Longest-Running West End Shows in London',
    metaTitle: `Longest-Running West End Shows (${CURRENT_YEAR})`,
    metaDescription: 'The longest-running West End shows currently playing in London, sorted by opening date. From The Mousetrap to modern classics.',
    intro: 'London\'s West End is home to some of the longest-running shows in theatrical history. This list shows all currently running West End productions sorted by how long they\'ve been open — from The Mousetrap (running since 1952) to the newest arrivals. Note: opening dates reflect the current production run, so shows that closed and reopened (like Les Misérables) show their most recent opening. For total historical performance counts, these numbers may understate a show\'s true longevity.',
    filter: (show) => show.category === 'west-end' && show.status === 'open',
    sort: 'opening-date-asc',
    source: 'west-end',
    relatedPages: ['west-end-shows', 'best-west-end-musicals', 'best-west-end-plays', 'longest-running-broadway-shows'],
  },

  'new-west-end-shows-2026': {
    slug: 'new-west-end-shows-2026',
    title: 'New West End Shows in 2026',
    h1: 'New West End Shows in 2026',
    metaTitle: 'New West End Shows Opening in 2026',
    metaDescription: 'All the new West End shows opening in London in 2026. Fresh productions, transfers, and world premieres hitting the West End this year.',
    intro: 'Discover all the new productions that have opened on the West End in 2026. From world premieres to highly anticipated transfers, these shows are bringing fresh stories and experiences to London\'s theatre district. Whether you\'re looking for the next big musical or an acclaimed new play, this is where you\'ll find the West End\'s newest offerings for the year.',
    filter: (show) => {
      return show.category === 'west-end' && show.status === 'open' && openedInYear(show, 2026);
    },
    sort: 'opening-date',
    source: 'west-end',
    relatedPages: ['upcoming-west-end-shows', 'west-end-shows', 'new-broadway-shows-2026'],
  },

  // === Off-West End Browse Pages ===

  'off-west-end-shows': {
    slug: 'off-west-end-shows',
    title: 'Off-West End Shows',
    h1: 'Off-West End Shows — London Theatre Beyond the West End',
    metaTitle: `Off-West End Shows Playing Now (${CURRENT_YEAR})`,
    metaDescription: 'Every Off-West End show currently playing in London, ranked by CriticScore. Aggregated reviews from top UK theatre critics.',
    intro: 'Every Off-West End show currently playing or in previews in London, ranked by aggregated CriticScore ratings. Off-West End is where London\'s most adventurous, innovative, and intimate theatre happens — from boundary-pushing new works at the Donmar Warehouse and Kiln Theatre to acclaimed revivals in fringe venues. We collect reviews from dozens of professional critics and combine them into a single weighted score. Whether you\'re a dedicated London theatregoer or looking beyond Shaftesbury Avenue, find your next show here.',
    filter: (show) => show.status === 'open' || show.status === 'previews',
    sort: 'score',
    source: 'off-west-end',
    relatedPages: ['best-off-west-end-shows', 'best-off-west-end-musicals', 'best-off-west-end-plays', 'upcoming-off-west-end-shows'],
  },

  'best-off-west-end-shows': {
    slug: 'best-off-west-end-shows',
    title: 'Best Off-West End Shows',
    h1: 'Best Off-West End Shows — Top-Rated in London',
    metaTitle: `Best Off-West End Shows (${CURRENT_YEAR}) — Ranked by Critics`,
    metaDescription: 'The best Off-West End shows in London right now, ranked by aggregated CriticScore from The Guardian, Telegraph, Time Out, and more.',
    intro: 'The highest-rated Off-West End shows currently playing in London, ranked by aggregated CriticScore. Only shows with at least three professional reviews qualify for this list, ensuring every ranking reflects a meaningful critical consensus. Off-West End consistently produces some of London\'s most acclaimed theatre — intimate venues, bold storytelling, and performances that rival anything in the West End. These are the Off-West End shows critics are raving about right now.',
    filter: (show) => {
      if (show.status !== 'open' && show.status !== 'previews') return false;
      return (show.criticScore?.reviewCount ?? 0) >= 3;
    },
    sort: 'score',
    source: 'off-west-end',
    relatedPages: ['off-west-end-shows', 'best-off-west-end-musicals', 'best-off-west-end-plays', 'best-west-end-musicals'],
  },

  'best-off-west-end-musicals': {
    slug: 'best-off-west-end-musicals',
    title: 'Best Off-West End Musicals',
    h1: 'Best Off-West End Musicals in London',
    metaTitle: `Best Off-West End Musicals (${CURRENT_YEAR}) — Ranked`,
    metaDescription: 'The best Off-West End musicals in London right now, ranked by CriticScore. Intimate, inventive musicals beyond the West End.',
    intro: 'Off-West End is where some of the most inventive, daring, and intimate musicals in London come to life. From breakout hits that go on to transfer to the West End to hidden gems that thrive in smaller venues, these productions showcase the incredible range of musical theatre beyond Shaftesbury Avenue. Ranked by aggregated CriticScore from professional critics, these are the Off-West End musicals worth seeing right now.',
    filter: (show) => (show.status === 'open' || show.status === 'previews') && show.type === 'musical' && (show.criticScore?.reviewCount ?? 0) >= 3,
    sort: 'score',
    source: 'off-west-end',
    relatedPages: ['best-off-west-end-plays', 'off-west-end-shows', 'best-off-west-end-shows', 'best-west-end-musicals'],
  },

  'best-off-west-end-plays': {
    slug: 'best-off-west-end-plays',
    title: 'Best Off-West End Plays',
    h1: 'Best Off-West End Plays in London',
    metaTitle: `Best Off-West End Plays (${CURRENT_YEAR}) — Ranked`,
    metaDescription: 'The best Off-West End plays in London right now, ranked by CriticScore. Dramas, comedies, and experimental works in intimate venues.',
    intro: 'Off-West End is the beating heart of London\'s dramatic theatre scene. These plays — from searing dramas to sharp comedies to genre-defying experimental works — represent the full spectrum of what Off-West End does best: intimate storytelling in venues where you\'re close enough to see every expression on an actor\'s face. Ranked by aggregated CriticScore from professional critics, these are the Off-West End plays getting the best reviews right now.',
    filter: (show) => (show.status === 'open' || show.status === 'previews') && show.type === 'play' && (show.criticScore?.reviewCount ?? 0) >= 3,
    sort: 'score',
    source: 'off-west-end',
    relatedPages: ['best-off-west-end-musicals', 'off-west-end-shows', 'best-off-west-end-shows', 'best-west-end-plays'],
  },

  'upcoming-off-west-end-shows': {
    slug: 'upcoming-off-west-end-shows',
    title: 'Upcoming Off-West End Shows',
    h1: 'Upcoming Off-West End Shows in London',
    metaTitle: `Upcoming Off-West End Shows (${CURRENT_YEAR})`,
    metaDescription: 'All upcoming Off-West End shows opening in London. New plays, musicals, and revivals coming to Off-West End venues, sorted by opening date.',
    intro: 'Every Off-West End show announced for London venues, sorted by opening date. Off-West End is where tomorrow\'s West End hits get their start and where the most exciting new voices in theatre debut their work. From world premieres at iconic venues like the Donmar Warehouse and Almeida to transfers from regional theatres, these are the Off-West End productions on the horizon.',
    filter: (show) => show.status === 'upcoming',
    sort: 'opening-date-asc',
    source: 'off-west-end',
    relatedPages: ['off-west-end-shows', 'best-off-west-end-shows', 'upcoming-west-end-shows'],
  },

  // === Off-Broadway Browse Pages ===

  'off-broadway-shows': {
    slug: 'off-broadway-shows',
    title: 'Off-Broadway Shows',
    h1: 'Off-Broadway Shows Playing Now — Ranked & Rated',
    metaTitle: `Off-Broadway Shows Playing Now (${CURRENT_YEAR})`,
    metaDescription: 'Every Off-Broadway show currently playing in NYC, ranked by CriticScore. Aggregated reviews from top critics for musicals, plays, and more.',
    intro: 'Every Off-Broadway show currently playing or in previews in New York City, ranked by aggregated CriticScore ratings. Off-Broadway is where NYC\'s most adventurous, innovative, and intimate theatre happens — from boundary-pushing new works to acclaimed revivals in smaller venues. We collect reviews from dozens of professional critics and combine them into a single weighted score. Whether you\'re a devoted Off-Broadway fan or looking beyond the bright lights of Times Square, find your next show here.',
    filter: (show) => show.status === 'open' || show.status === 'previews',
    sort: 'score',
    source: 'off-broadway',
    relatedPages: ['best-off-broadway-shows', 'best-off-broadway-musicals', 'best-off-broadway-plays', 'upcoming-off-broadway-shows'],
  },

  'best-off-broadway-shows': {
    slug: 'best-off-broadway-shows',
    title: 'Best Off-Broadway Shows',
    h1: 'Best Off-Broadway Shows — Top-Rated in NYC',
    metaTitle: `Best Off-Broadway Shows (${CURRENT_YEAR}) — Ranked by Critics`,
    metaDescription: 'The best Off-Broadway shows in NYC right now, ranked by aggregated CriticScore. Only shows with 3+ professional reviews qualify.',
    intro: 'The highest-rated Off-Broadway shows currently playing in New York City, ranked by aggregated CriticScore. Only shows with at least three professional reviews qualify for this list, ensuring every ranking reflects a meaningful critical consensus. Off-Broadway consistently produces some of NYC\'s most acclaimed theatre — intimate venues, bold storytelling, and performances that rival anything on the Great White Way. These are the Off-Broadway shows critics are raving about right now.',
    filter: (show) => {
      if (show.status !== 'open' && show.status !== 'previews') return false;
      return (show.criticScore?.reviewCount ?? 0) >= 3;
    },
    sort: 'score',
    source: 'off-broadway',
    relatedPages: ['off-broadway-shows', 'best-off-broadway-musicals', 'best-off-broadway-plays', 'best-broadway-shows'],
  },

  'best-off-broadway-musicals': {
    slug: 'best-off-broadway-musicals',
    title: 'Best Off-Broadway Musicals',
    h1: 'Best Off-Broadway Musicals in NYC',
    metaTitle: `Best Off-Broadway Musicals (${CURRENT_YEAR}) — Ranked`,
    metaDescription: 'The best Off-Broadway musicals in NYC right now, ranked by CriticScore. Intimate, inventive musicals beyond the Great White Way.',
    intro: 'Off-Broadway is where some of the most inventive, daring, and intimate musicals in New York City come to life. From breakout hits that go on to transfer to Broadway to hidden gems that thrive in smaller venues, these productions showcase the incredible range of musical theatre beyond Times Square. Ranked by aggregated CriticScore from professional critics, these are the Off-Broadway musicals worth seeing right now.',
    filter: (show) => (show.status === 'open' || show.status === 'previews') && show.type === 'musical' && (show.criticScore?.reviewCount ?? 0) >= 3,
    sort: 'score',
    source: 'off-broadway',
    relatedPages: ['best-off-broadway-plays', 'off-broadway-shows', 'best-off-broadway-shows', 'best-broadway-musicals'],
  },

  'best-off-broadway-plays': {
    slug: 'best-off-broadway-plays',
    title: 'Best Off-Broadway Plays',
    h1: 'Best Off-Broadway Plays in NYC',
    metaTitle: `Best Off-Broadway Plays (${CURRENT_YEAR}) — Ranked`,
    metaDescription: 'The best Off-Broadway plays in NYC right now, ranked by CriticScore. Dramas, comedies, and experimental works in intimate venues.',
    intro: 'Off-Broadway is the beating heart of New York\'s dramatic theatre scene. These plays — from searing dramas to sharp comedies to genre-defying experimental works — represent the full spectrum of what Off-Broadway does best: intimate storytelling in venues where you\'re close enough to see every expression on an actor\'s face. Ranked by aggregated CriticScore from professional critics, these are the Off-Broadway plays getting the best reviews right now.',
    filter: (show) => (show.status === 'open' || show.status === 'previews') && show.type === 'play' && (show.criticScore?.reviewCount ?? 0) >= 3,
    sort: 'score',
    source: 'off-broadway',
    relatedPages: ['best-off-broadway-musicals', 'off-broadway-shows', 'best-off-broadway-shows', 'best-broadway-plays'],
  },

  'upcoming-off-broadway-shows': {
    slug: 'upcoming-off-broadway-shows',
    title: 'Upcoming Off-Broadway Shows',
    h1: 'Upcoming Off-Broadway Shows in NYC',
    metaTitle: `Upcoming Off-Broadway Shows (${CURRENT_YEAR})`,
    metaDescription: 'All upcoming Off-Broadway shows opening in NYC. New plays, musicals, and revivals coming to Off-Broadway venues, sorted by opening date.',
    intro: 'Every Off-Broadway show announced for New York City venues, sorted by opening date. Off-Broadway is where tomorrow\'s Broadway hits get their start and where the most exciting new voices in theatre debut their work. From world premieres at iconic venues like Playwrights Horizons and MCC Theater to transfers from regional theatres, these are the Off-Broadway productions on the horizon. Shows currently in previews appear on the main Off-Broadway page.',
    filter: (show) => show.status === 'upcoming',
    sort: 'opening-date-asc',
    source: 'off-broadway',
    relatedPages: ['off-broadway-shows', 'best-off-broadway-shows', 'upcoming-broadway-shows'],
  },

  // === SEO KEYWORD GAP PAGES ===

  'broadway-show-runtimes': {
    slug: 'broadway-show-runtimes',
    title: 'Broadway Show Runtimes',
    h1: 'Broadway Show Runtimes — Complete Guide',
    metaTitle: `Broadway Show Runtimes — How Long Is Every Show? (${CURRENT_YEAR})`,
    metaDescription: 'How long is every Broadway show? Complete runtimes for all current productions, sorted shortest to longest. Plan your evening with exact show lengths.',
    intro: 'How long is every Broadway show currently playing? This page lists the runtime for every open production on Broadway, sorted from shortest to longest. Whether you\'re planning around dinner reservations, babysitter schedules, or just prefer a shorter show, this guide helps you find exactly the right fit. Runtimes include intermission where applicable. Shows marked with an intermission count give you a sense of pacing — a 2.5-hour show with one intermission feels very different from a straight-through production.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      return !!show.runtime && parseRuntime(show.runtime) > 0;
    },
    customSort: (shows) => {
      return shows.sort((a, b) => {
        return parseRuntime(a.runtime) - parseRuntime(b.runtime);
      });
    },
    relatedPages: ['short-broadway-shows', 'broadway-shows-under-2-hours', 'broadway-shows-no-intermission', 'long-broadway-shows'],
  },

  'broadway-age-guide': {
    slug: 'broadway-age-guide',
    title: 'Broadway Age Guide',
    h1: 'Broadway Age Guide — What\'s Appropriate for Your Kids?',
    metaTitle: `Broadway Age Guide — Age Recommendations for Every Show (${CURRENT_YEAR})`,
    metaDescription: 'Is this Broadway show appropriate for your child? Age recommendations for every current production, sorted by minimum age. Find the right show for your family.',
    intro: 'Wondering if a Broadway show is appropriate for your kids? This guide lists age recommendations for every current Broadway production, sorted from youngest-appropriate to most mature. These recommendations come from official show guidance and reflect content considerations including language, themes, violence, and sexual content. When in doubt, err on the side of the higher age recommendation — a child who\'s too young for a show won\'t enjoy it, and neither will you.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      return !!show.ageRecommendation;
    },
    customSort: (shows) => {
      return shows.sort((a, b) => {
        const aAge = parseInt(a.ageRecommendation?.match(/\d+/)?.[0] || '0');
        const bAge = parseInt(b.ageRecommendation?.match(/\d+/)?.[0] || '0');
        if (aAge !== bAge) return aAge - bAge;
        return (b.criticScore?.score ?? 0) - (a.criticScore?.score ?? 0);
      });
    },
    relatedPages: ['broadway-shows-for-kids', 'first-time-broadway', 'broadway-shows-for-teens', 'short-broadway-shows'],
  },

  // Season browse pages (generated programmatically)
  ...generateSeasonBrowsePages(),
};

// Get all browse page slugs for static generation
export function getAllBrowseSlugs(): string[] {
  return Object.keys(BROWSE_PAGES);
}

// Get a specific browse page config
export function getBrowsePageConfig(slug: string): BrowsePageConfig | undefined {
  return BROWSE_PAGES[slug];
}
