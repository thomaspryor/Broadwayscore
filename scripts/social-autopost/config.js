/**
 * Social autopost configuration (BRO-6242).
 *
 * Two events per show, each posted once to every connected Buffer channel:
 *   opening  On opening day, at OPENING_POST_LOCAL_HOUR local time.
 *   score    When the Critic Score clears the confidence gate
 *            (scripts/lib/score-confidence-gate.js), inside SCORE_LOOKBACK_DAYS
 *            of opening so a first deploy never backfills old shows.
 *
 * Broadway and West End post every opening. Off-Broadway and Off-West End post
 * an opening only at a major house (MAJOR_VENUES) and a score only when enough
 * top-tier critics covered it (SCORE_FLOORS).
 */

const MARKETS = {
  broadway: { label: 'Broadway', tz: 'America/New_York', site: 'Broadway Scorecard', domain: 'broadwayscorecard.com', brand: '#d4a574', hashtags: ['Broadway', 'BroadwayReviews'] },
  'off-broadway': { label: 'Off-Broadway', tz: 'America/New_York', site: 'Broadway Scorecard', domain: 'broadwayscorecard.com', brand: '#d4a574', hashtags: ['OffBroadway', 'NYCTheatre'] },
  'west-end': { label: 'West End', tz: 'Europe/London', site: 'West End Scorecard', domain: 'broadwayscorecard.com', brand: '#f472b6', hashtags: ['WestEnd', 'LondonTheatre'] },
  'off-west-end': { label: 'Off-West End', tz: 'Europe/London', site: 'West End Scorecard', domain: 'broadwayscorecard.com', brand: '#f472b6', hashtags: ['OffWestEnd', 'LondonTheatre'] },
};

// Off-* houses whose openings are news on their own. Matched case-insensitively
// against shows.json `venue`. Keep to institutions the trade press reviews as a rule.
const MAJOR_VENUES = {
  'off-broadway': [
    /public theater/i, /signature center/i, /lucille lortel/i, /st\.? ann'?s warehouse/i,
    /new york theatre workshop/i, /playwrights horizons/i, /park avenue armory/i,
    /daryl roth/i, /minetta lane/i, /classic stage company/i, /vineyard theatre/i,
    /\bthe shed\b|griffin theater/i, /atlantic theater/i, /laura pels/i, /\bmcc\b/i,
    /lincoln center theater|mitzi e\.? newhouse|claire tow/i, /new world stages/i,
    /second stage|tony kiser/i, /new york city center.*stage i\b|manhattan theatre club/i,
    /irish repertory/i, /\bbam\b|brooklyn academy/i, /perelman performing arts|pac nyc/i,
    /polonsky|theatre for a new audience/i, /\bwp theater\b/i, /orpheum theatre/i,
  ],
  'off-west-end': [
    /national theatre|olivier theatre|lyttelton|dorfman/i, /almeida/i, /donmar/i,
    /royal court/i, /young vic/i, /bridge theatre/i, /old vic/i,
    /hampstead theatre(?!.*downstairs)/i, /menier/i, /kiln theatre/i,
    /shakespeare'?s globe|sam wanamaker/i, /regent'?s park open air/i,
    /lyric hammersmith/i, /bush theatre/i, /barbican theatre/i, /orange tree/i,
  ],
};

// Score-post floors per category, layered on the shared broadcast gate. Off-West End
// is stricter than the gate: London's national critics review most fringe
// openings, so 3 tier-1 reviews there does not mean "major" (2025-26 season: 88
// Off-West End shows clear 8 total / 3 T1, 53 clear 10 / 5).
const SCORE_FLOORS = {
  'off-west-end': { total: 10, t1: 5 },
};

const ELIGIBLE_CATEGORIES = Object.keys(MARKETS);
const SKIP_TYPES = new Set(['opera', 'dance', 'concert']);

const OPENING_POST_LOCAL_HOUR = 12; // noon on opening day
const OPENING_LATEST_LOCAL_HOUR = 18; // after this, an unsent opening post is stale
const OPENING_SCHEDULE_AHEAD_HOURS = 36; // queue it in Buffer up to this far ahead
const SCORE_LOOKBACK_DAYS = 21;
const FIRST_RUN_FRESH_DAYS = 3; // first live run only: older score posts are skipped (select.js splitBacklog)
const SCORE_POST_WINDOW = { start: 9, end: 21 }; // local hours; outside it, wait for 9:00
const STAGGER_MINUTES = 90; // gap between two posts created in the same run

module.exports = {
  MARKETS, MAJOR_VENUES, SCORE_FLOORS, ELIGIBLE_CATEGORIES, SKIP_TYPES,
  OPENING_POST_LOCAL_HOUR, OPENING_LATEST_LOCAL_HOUR, OPENING_SCHEDULE_AHEAD_HOURS,
  SCORE_LOOKBACK_DAYS, FIRST_RUN_FRESH_DAYS, SCORE_POST_WINDOW, STAGGER_MINUTES,
};
