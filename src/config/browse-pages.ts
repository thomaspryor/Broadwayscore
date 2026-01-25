// Browse Pages Configuration
// Defines all 17+ browse/landing pages for SEO

import { ComputedShow } from '@/lib/engine';

export interface BrowsePageConfig {
  slug: string;
  title: string;
  h1: string;
  metaTitle: string; // Under 60 chars
  metaDescription: string; // 150-160 chars
  intro: string; // 100-200 words intro paragraph
  filter: (show: ComputedShow) => boolean;
  sort?: 'score' | 'opening-date' | 'closing-date' | 'title';
  limit?: number;
  relatedPages: string[]; // Slugs of related browse pages
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

export const BROWSE_PAGES: Record<string, BrowsePageConfig> = {
  'broadway-shows-for-kids': {
    slug: 'broadway-shows-for-kids',
    title: 'Best Broadway Shows for Kids',
    h1: 'Best Broadway Shows for Kids',
    metaTitle: 'Best Broadway Shows for Kids (2026)',
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
    metaTitle: 'Best Broadway Shows for Date Night (2026)',
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
    metaTitle: 'Must-See Broadway Shows for Tourists (2026)',
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
    metaTitle: 'Best Broadway Shows for First-Timers (2026)',
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
    metaTitle: 'Broadway Shows Closing Soon (2026)',
    metaDescription: 'Don\'t miss these Broadway shows before they close! Limited engagement shows and productions ending their runs in the next 60 days.',
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
    relatedPages: ['best-broadway-show-right-now', 'broadway-shows-closing-soon', 'tony-nominated-2025'],
  },

  'best-broadway-revivals': {
    slug: 'best-broadway-revivals',
    title: 'Best Broadway Revivals',
    h1: 'Best Broadway Revivals',
    metaTitle: 'Best Broadway Revivals (2026)',
    metaDescription: 'The best Broadway revival productions currently playing. Classic shows reimagined for today\'s audiences with fresh perspectives and new stars.',
    intro: 'Broadway revivals bring beloved classics back to life with fresh perspectives, new stars, and reimagined staging. These productions honor the original material while offering something new - whether it\'s an innovative concept, a diverse cast, or simply the chance to experience a legendary show in person. From Tony-winning productions to intimate reimaginings, these revivals prove that great theater is timeless.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      const tags = show.tags?.map(t => t.toLowerCase()) || [];
      return tags.includes('revival') || show.type === 'revival';
    },
    sort: 'score',
    relatedPages: ['tony-winners-on-broadway', 'best-broadway-musicals', 'best-broadway-dramas'],
  },

  'best-broadway-comedies': {
    slug: 'best-broadway-comedies',
    title: 'Best Broadway Comedies',
    h1: 'Best Broadway Comedies',
    metaTitle: 'Best Broadway Comedies (2026)',
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
    metaTitle: 'Best Broadway Dramas (2026)',
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
    metaTitle: 'Jukebox Musicals on Broadway (2026)',
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
    metaTitle: 'Broadway Lottery Shows - Win Cheap Tickets (2026)',
    metaDescription: 'Broadway shows offering digital lotteries for discounted tickets. Enter daily for your chance to see top shows at a fraction of the price.',
    intro: 'Broadway lotteries offer an incredible opportunity to see top shows at deeply discounted prices - often $30-40 for orchestra seats that normally cost hundreds. Most lotteries are digital and can be entered via apps like TodayTix or the show\'s official website. Enter early in the day for evening performances, and don\'t be discouraged if you don\'t win right away - persistence pays off! These shows all currently offer lottery programs.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      const tags = show.tags?.map(t => t.toLowerCase()) || [];
      return tags.includes('lottery');
    },
    sort: 'score',
    relatedPages: ['broadway-rush-tickets', 'broadway-shows-for-tourists', 'first-time-broadway'],
  },

  'broadway-rush-tickets': {
    slug: 'broadway-rush-tickets',
    title: 'Broadway Rush Ticket Shows',
    h1: 'Broadway Rush Ticket Shows',
    metaTitle: 'Broadway Rush Tickets - Same-Day Deals (2026)',
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
    metaTitle: 'Short Broadway Shows Under 90 Minutes (2026)',
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
    metaTitle: 'Broadway Shows with No Intermission (2026)',
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
    title: 'Tony Winners Now on Broadway',
    h1: 'Tony Winners Now on Broadway',
    metaTitle: 'Tony Award Winners on Broadway (2026)',
    metaDescription: 'See Tony Award-winning shows currently playing on Broadway. The best of the best, as recognized by the theater industry\'s highest honors.',
    intro: 'The Tony Awards represent the highest honors in American theater, and these shows have earned Broadway\'s most prestigious accolades. Whether they won Best Musical, Best Play, or collected multiple awards for their creative teams, these productions represent the pinnacle of theatrical achievement. Seeing a Tony winner is a chance to experience shows that have been recognized as the very best Broadway has to offer.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      const tags = show.tags?.map(t => t.toLowerCase()) || [];
      return tags.includes('tony-winner');
    },
    sort: 'score',
    relatedPages: ['best-broadway-revivals', 'broadway-shows-for-tourists', 'best-broadway-show-right-now'],
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
    metaTitle: 'The #1 Best Broadway Show Right Now (2026)',
    metaDescription: 'What\'s the single best show on Broadway today? Based on our aggregated critic scores, here\'s our top pick for the best show to see right now.',
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
    metaTitle: 'Best Broadway Musicals (2026)',
    metaDescription: 'The highest-rated musicals currently playing on Broadway. From new hits to long-running classics, find your next must-see musical.',
    intro: 'Broadway musicals represent the pinnacle of theatrical entertainment, combining compelling stories with unforgettable songs, spectacular staging, and incredible performances. These are the highest-rated musicals currently playing on Broadway, as determined by aggregated critic reviews. Whether you\'re looking for a classic, a new hit, or something in between, these productions deliver the very best of what musical theater has to offer.',
    filter: (show) => {
      if (show.status !== 'open') return false;
      return show.type === 'musical' || show.type === 'revival';
    },
    sort: 'score',
    relatedPages: ['jukebox-musicals-on-broadway', 'best-broadway-revivals', 'tony-winners-on-broadway'],
  },
};

// Get all browse page slugs for static generation
export function getAllBrowseSlugs(): string[] {
  return Object.keys(BROWSE_PAGES);
}

// Get a specific browse page config
export function getBrowsePageConfig(slug: string): BrowsePageConfig | undefined {
  return BROWSE_PAGES[slug];
}
