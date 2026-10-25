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
const CHANNELS = {
  instagram: '69adf7f67be9f8b171375290',
  facebook: '69adfb857be9f8b171375c63',
  twitter: '69adf9617be9f8b1713756d4',
  threads: '69adf8167be9f8b1713752f6',
  bluesky: '69adf8ac7be9f8b1713754bb',
};

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
  MARKETS, CHANNELS, SCORE_FLOORS, ELIGIBLE_CATEGORIES, SKIP_TYPES,
  SCORE_POST_LOCAL_HOUR, SCORE_POST_WINDOW, CREATE_LEAD_MINUTES,
  SCORE_LOOKBACK_DAYS, FIRST_RUN_FRESH_DAYS, STAGGER_MINUTES,
};
