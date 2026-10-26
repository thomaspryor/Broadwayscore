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
  // While this is empty, West End shows keep posting to the Broadway set
  // (routing.js), so switching routing on is just adding ids here.
  'west-end': {
    // instagram: '', facebook: '', twitter: '', threads: '', bluesky: '',
  },
};
const CHANNELS = CHANNEL_SETS.broadway; // the original set; kept for callers that predate per-market routing

// Which channel set is a show's home. Broadway and Off-Broadway post to the Broadway
// accounts, West End and Off-West End to the West End accounts.
const MARKET_CHANNEL_SET = { broadway: 'broadway', 'off-broadway': 'broadway', 'west-end': 'west-end', 'off-west-end': 'west-end' };

// "High profile" rule for cross-posting to the OTHER market's accounts (BRO-6378;
// proposal, the owner approves the numbers). Also the rule for the video lane (BRO-6250):
// import isHighProfile from routing.js there. A show is high profile when it has a
// transfer link to the other market (a Broadway show that came from / is going to
// London, or the reverse), or its own run has this many tier-1 reviews.
const HIGH_PROFILE = { t1Reviews: 8, transfer: true };

// Score-post floors layered on the shared gate, which carries only the opening-night
// email's Broadway and London floors. Off-Broadway: 3 tier-1 outlets marks a major
// show. Off-West End: London's national critics review most fringe openings, so it
// needs more (2025-26 season: 88 shows clear 8 total / 3 T1, 53 clear 10 / 5).
const SCORE_FLOORS = {
  'off-broadway': { total: 8, t1: 3, t2: 2, highConfidence: 6 },
  'off-west-end': { total: 10, t1: 5, t2: 2, highConfidence: 6 },
};

const ELIGIBLE_CATEGORIES = Object.keys(MARKETS);
const SKIP_TYPES = new Set(['opera', 'dance', 'concert']);

const SCORE_POST_LOCAL_HOUR = 10; // the morning after opening night
const SCORE_POST_WINDOW = { start: 9, end: 21 }; // a score that settles later posts in this window
const CREATE_LEAD_MINUTES = 70; // a post is created in Buffer at most this long before it goes out
const SCORE_LOOKBACK_DAYS = 10; // a score that settles later than this after opening is not posted
const FIRST_RUN_FRESH_DAYS = 3; // first live run only: older shows are skipped (select.js splitBacklog)
const STAGGER_MINUTES = 90; // gap between two posts

module.exports = {
  MARKETS, CHANNELS, CHANNEL_SETS, MARKET_CHANNEL_SET, HIGH_PROFILE, SCORE_FLOORS, ELIGIBLE_CATEGORIES, SKIP_TYPES,
  SCORE_POST_LOCAL_HOUR, SCORE_POST_WINDOW, CREATE_LEAD_MINUTES,
  SCORE_LOOKBACK_DAYS, FIRST_RUN_FRESH_DAYS, STAGGER_MINUTES,
};
