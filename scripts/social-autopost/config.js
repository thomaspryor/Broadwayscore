/**
 * Social autopost configuration (BRO-6242).
 *
 * One post per show: the morning after opening night, at SCORE_POST_LOCAL_HOUR
 * local time, once the Critic Score clears the confidence gate
 * (scripts/lib/score-confidence-gate.js). Every score is posted, low ones too
 * (owner decision 2026-10-25). Posts go out automatically to the Buffer
 * channels in CHANNELS.
 */

const MARKETS = {
  broadway: { label: 'Broadway', tz: 'America/New_York', domain: 'broadwayscorecard.com', brand: '#d4a574', logo: 'broadway-wordmark-transparent.png', hashtags: ['Broadway', 'BroadwayReviews'] },
  'off-broadway': { label: 'Off-Broadway', tz: 'America/New_York', domain: 'broadwayscorecard.com', brand: '#d4a574', logo: 'broadway-wordmark-transparent.png', hashtags: ['OffBroadway', 'NYCTheatre'] },
  'west-end': { label: 'West End', tz: 'Europe/London', domain: 'westendscorecard.com', brand: '#f472b6', logo: 'west-end-wordmark-transparent.png', hashtags: ['WestEnd', 'LondonTheatre'] },
  // Opera Scorecard (BRO-6770): a show's market is 'opera' when its type is opera (marketOf), whatever its category.
  // Opera shows live under /opera/<title slug> on broadwayscorecard.com (operascorecard.com redirects there).
  opera: { label: 'Opera', tz: 'America/New_York', domain: 'broadwayscorecard.com', brand: '#e0485f', logo: 'opera-wordmark-transparent.png', hashtags: ['Opera'] },
  'off-west-end': { label: 'Off-West End', tz: 'Europe/London', domain: 'westendscorecard.com', brand: '#f472b6', logo: 'west-end-wordmark-transparent.png', hashtags: ['OffWestEnd', 'LondonTheatre'] },
};

// The only Buffer channels this system posts to, by Buffer channel id (checked
// 2026-10-25: all connected, Instagram is a Professional account). Anything else
// the Buffer account can see, TikTok included, is left alone.
const CHANNEL_SETS = {
  broadway: {
    instagram: '69adf7f67be9f8b171375290',
    facebook: '69adfb857be9f8b171375c63',
    twitter: '69adf9617be9f8b1713756d4',
    threads: '69adf8167be9f8b1713752f6',
    bluesky: '69adf8ac7be9f8b1713754bb',
  },
  // West End Scorecard accounts (BRO-6378). Fill in the Buffer channel ids from
  // `node scripts/social-autopost/run.js --list-channels` once the owner has
  // connected them (guide: claude-outputs/west-end-social-accounts-guide.md).
  // While this is empty, main-stage West End shows keep posting to the Broadway set
  // (BROADWAY_FALLBACK_CATEGORIES, routing.js) and Off-West End shows post nothing,
  // so switching routing on is just adding ids here.
  'west-end': {
    // instagram: '', facebook: '', twitter: '', threads: '', bluesky: '',
  },
};
// Opera Scorecard accounts (BRO-6770). Fill in the Buffer channel ids from
// `node scripts/social-autopost/run.js --list-channels` once the owner has connected them.
// Opera posts ONLY here: while this is empty opera posts nothing (no fallback to the
// Broadway or West End accounts, unlike West End), and nothing else ever posts here.
CHANNEL_SETS.opera = {
  // instagram: '', facebook: '', twitter: '', threads: '', bluesky: '',
};
const CHANNELS = CHANNEL_SETS.broadway; // the original set; kept for callers that predate per-market routing

// Which channel set is a show's home. Broadway and Off-Broadway post to the Broadway
// accounts, West End and Off-West End to the West End accounts.
const MARKET_CHANNEL_SET = { broadway: 'broadway', 'off-broadway': 'broadway', 'west-end': 'west-end', 'off-west-end': 'west-end' };
// Categories whose shows post to the Broadway accounts while their own set is not
// configured. Off-West End is not one (owner, BRO-6932: fringe London shows do not
// belong on the Broadway accounts); it waits for the West End accounts.
const BROADWAY_FALLBACK_CATEGORIES = ['west-end'];

// "High profile" rule for cross-posting to the OTHER market's accounts (BRO-6378;
// proposal, the owner approves it). Also the rule for the video lane (BRO-6250):
// import isHighProfile from routing.js there. A show is high profile in the other
// market when that market's own critics came to it (otherMarketPress, keyed by the
// set it would cross-post TO), or the same show ran there on the main stage within
// sameTitleYears, or it has a transfer link to a show in the other market.
// Each market's own tier-1 count is no test: London's nationals review nearly every
// West End opening (59 of 103 shows in the 16 months to 2026-10 had 8+ tier-1
// reviews). Over the same months (shows with reviews) this rule picks 17 of 100 West
// End, 2 of 208 Off-West End, 11 of 36 Broadway and 7 of 287 Off-Broadway shows
// (mostly Met operas the UK papers covered, which SKIP_TYPES never posts), about 2 a
// month. The UK lists include papers' New York critics: UK coverage is the signal.
const HIGH_PROFILE = {
  transfer: true,
  otherMarketPress: {
    broadway: ['nytimes', 'variety'],
    'west-end': ['telegraph', 'times-uk', 'sunday-times', 'financialtimes', 'independent', 'thestage'],
  },
  sameTitleYears: 3,
};

// Score-post floors layered on the shared gate, which carries only the opening-night
// email's Broadway and London floors. The floors ask only "is the score settled",
// never "is this a major show" (owner, BRO-6920: the old 3 tier-1 Off-Broadway / 5
// tier-1 Off-West End floors posted 33 of 278 Off-Broadway and 47 of 179 Off-West End
// shows in the year to 2026-10, and skipped I Became We, King of the Yees, Copperfield).
// Off-Broadway rarely draws 3 tier-1 critics, so it needs no tier-1 review, only 8 scored
// reviews (108 of 278 clear it within 10 days of opening). Off-West End has no entry,
// so it uses the shared gate's London floors (London's nationals review most fringe
// openings, so 3 tier-1 is common there).
const SCORE_FLOORS = {
  'off-broadway': { total: 8, t1: 0, t2: 2, highConfidence: 6 },
};
// "All its reviews are in" floors (BRO-6932): a show under its SCORE_FLOORS still posts
// when the review-coverage census says no known review is missing (slim cov.state
// 'complete', scripts/lib/public-coverage-verdict.js) at least minDays after opening
// (80% of Off-Broadway reviews land within 7 days), with a tier-1 critic among them so
// the show is big enough to post (In the Heights, Two Girls). 6 Off-Broadway shows of
// 2026 to date clear this and not the 8-review floor.
const COMPLETE_COVERAGE_FLOORS = {
  'off-broadway': { total: 5, t1: 1, t2: 0, highConfidence: 4, minDays: 7 },
};

const ELIGIBLE_CATEGORIES = Object.keys(MARKETS).filter(k => k !== 'opera'); // categories; opera is a market by type (marketOf)
// House tag added to an opera post by the show's category (Met = off-broadway, Royal Opera House = off-west-end).
const OPERA_HOUSE_TAGS = { 'off-broadway': 'MetOpera', 'off-west-end': 'RoyalOpera' };
const OPERA_VENUE_TAGS = [[/war memorial opera house|san francisco opera/i, 'SFOpera'], [/london coliseum|english national opera/i, 'ENO']];
/** House hashtag for an opera: by venue for SFO/ENO, else by category (Met / Royal Opera House). */
const operaHouseTag = show => {
  const hit = OPERA_VENUE_TAGS.find(([re]) => re.test(String(show && show.venue || '')));
  return hit ? hit[1] : OPERA_HOUSE_TAGS[show && show.category];
};

/** A show's market key: 'opera' for an opera (any category), else its category. */
const marketOf = show => (String(show && show.type || '').toLowerCase() === 'opera' ? 'opera' : show.category);

// Opera is skipped for the Broadway and West End sets; select.js lets it through the score lane only
// once the opera channel set is fully configured.
const SKIP_TYPES = new Set(['opera', 'dance', 'concert']);

const SCORE_POST_LOCAL_HOUR = 10; // the morning after opening night
const SCORE_POST_WINDOW = { start: 9, end: 21 }; // a score that settles later posts in this window
const CREATE_LEAD_MINUTES = 70; // a post is created in Buffer at most this long before it goes out
const SCORE_LOOKBACK_DAYS = 10; // a score that settles later than this after opening is not posted
const FIRST_RUN_FRESH_DAYS = 3; // first live run only: older shows are skipped (select.js splitBacklog)
const STAGGER_MINUTES = 90; // gap between two posts
const LONDON_COMPARE_LOOKBACK_DAYS = 5; // a London comparison later than this after its morning-after slot is dropped (BRO-6373)

// Weekly roundup (BRO-6413): one post per channel set listing the week's openings with
// their Critic Scores. weekday is the single knob (0 = Sunday ... 5 = Friday); the post goes out
// at SCORE_POST_LOCAL_HOUR on that day in the set's home time zone. The window is the
// WINDOW_DAYS days that end LAG_DAYS before the post day: a show that opened the evening before
// has its own score post that morning (one post per show per network per day, score posts win),
// so it waits for next week's roundup. ON since the owner approved the sample (2026-10-27); set false to stop.
const WEEKLY_ROUNDUP = {
  enabled: true,
  weekday: 5,
  minShows: 2, // fewer shows with a score and a poster: the week is skipped
  maxRows: 6, // rows on the card
  windowDays: 7,
  lagDays: 2,
  lookbackDays: 2, // a roundup missed by more than this is dropped
};

// Closing soon (BRO-6413): a top-rated show in its last weeks, posted once ever per show.
// ON since the owner approved the sample (2026-10-27); set false to stop.
const CLOSING_SOON = {
  enabled: true,
  minDays: 14, // closing date at least this many local days away...
  maxDays: 28, // ...and at most this many
  minScore: 80, maxPerDay: 2, // rounded Critic Score
};

// Quiet-day backfill (BRO-6932): a show whose score settled after its SCORE_LOOKBACK_DAYS
// window still gets its score post on a day with nothing else going out (owner, 2026-11-03:
// "it doesn't have to always be so timely"). Judged on the New York day, because every
// network posts from the Broadway channel set today. Set enabled false to stop.
const BACKFILL = {
  enabled: true,
  fromHour: 14, // New York local hour from which a day with no post counts as quiet
  maxPerDay: 2, // backfill posts on one quiet day (90 minutes apart, STAGGER_MINUTES)
  lookbackDays: 45, // opened at most this many days ago
  minDaysLeft: 2, // a show closing sooner than this is not worth a post
};

// AI-written score posts (BRO-6959): Claude writes, code and GPT-5.5 check, the template stands in
// on any failure (ai-captions.js). ON since 2026-11-04 after three dispatched dry runs (input ai_captions) drafted good posts;
// the repo variable SOCIAL_AI_CAPTIONS_DISABLED=true stops it without a commit.
const AI_CAPTIONS = {
  enabled: true,
  runBudgetMs: 8 * 60e3, // all drafts in one run; after this every show gets the template
};

module.exports = {
  WEEKLY_ROUNDUP, CLOSING_SOON, BACKFILL, AI_CAPTIONS,
  MARKETS, marketOf, OPERA_HOUSE_TAGS, operaHouseTag, CHANNELS, CHANNEL_SETS, MARKET_CHANNEL_SET, BROADWAY_FALLBACK_CATEGORIES, HIGH_PROFILE, SCORE_FLOORS, COMPLETE_COVERAGE_FLOORS, ELIGIBLE_CATEGORIES, SKIP_TYPES,
  SCORE_POST_LOCAL_HOUR, SCORE_POST_WINDOW, CREATE_LEAD_MINUTES,
  SCORE_LOOKBACK_DAYS, FIRST_RUN_FRESH_DAYS, STAGGER_MINUTES, LONDON_COMPARE_LOOKBACK_DAYS,
};
