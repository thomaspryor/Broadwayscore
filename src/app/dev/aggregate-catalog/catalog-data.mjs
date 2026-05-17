// Single source of truth for the aggregate-page catalog.
// Imported by:
//   - src/app/dev/aggregate-catalog/page.tsx
//   - scripts/capture-aggregate-catalog.mjs
//
// Mirrors the structure of src/app/dev/catalog/catalog-data.mjs (show pages)
// but covers aggregate / list / table / market-landing routes. Each `path` is
// a relative URL (capture script prepends the base URL).

/** @typedef {{ path: string, label: string, why: string, focus: string[] }} CatalogEntry */
/** @typedef {{ heading: string, entries: CatalogEntry[] }} CatalogGroup */

/** @type {CatalogGroup[]} */
export const CATALOG = [
  {
    heading: 'Score-aggregate pages',
    entries: [
      { path: '/audience-buzz', label: 'Audience Buzz — Broadway', why: 'Broadway shows ranked by aggregated audience grade (A+ to F)', focus: ['Sortable table column treatment', 'Grade-band grouping cards below', 'Audience grade badge styling'] },
      { path: '/west-end/audience-buzz', label: 'Audience Buzz — West End', why: 'West End equivalent of /audience-buzz', focus: ['Market label and breadcrumb', 'Subset of audience sources for WE', 'Color/typography parity with Broadway version'] },
      { path: '/trending', label: 'Trending — Broadway (social)', why: 'Broadway shows ranked by social media buzz tier', focus: ['Tier badges (Buzzing/Rising/Steady/Troubled)', 'Per-platform breakdown row layout'] },
      { path: '/west-end/trending', label: 'Trending — West End', why: 'WE trending counterpart', focus: ['Market parity with Broadway trending'] },
      { path: '/box-office', label: 'Box Office Scorecard', why: 'Weekly grosses + all-time leaderboard tables', focus: ['Two-table layout (this week + all-time)', 'Currency formatting', 'Capacity % column treatment', 'WoW/YoY arrows'] },
    ],
  },
  {
    heading: 'Per-market landing pages',
    entries: [
      { path: '/', label: 'Homepage', why: 'Featured shelves across Broadway + Off-Broadway + West End + Opera', focus: ['Shelf/carousel composition', 'Hero featured row', 'Section spacing rhythm'] },
      { path: '/west-end', label: 'West End landing', why: 'All WE + Off-WE shows; sort/filter + bonus shelves', focus: ['Sort/filter chip row', 'Show row vs card pattern', 'Bonus shelf treatment'] },
      { path: '/off-broadway', label: 'Off-Broadway landing', why: 'OB market landing', focus: ['Sort/filter parity with WE landing', 'Off-Broadway brand accent'] },
      { path: '/off-west-end', label: 'Off-West End landing', why: 'OWE market landing', focus: ['Edge market treatment'] },
      { path: '/opera', label: 'Opera landing', why: 'Met Opera archive + flat-tier review methodology', focus: ['Long-tail archive list', 'Methodology note placement'] },
    ],
  },
  {
    heading: 'Browse / category list pages',
    entries: [
      { path: '/browse/best-broadway-musicals', label: 'Browse — Best Broadway Musicals', why: 'Canonical browse list — score-sorted musicals only', focus: ['BrowseListClient sort/filter UI', 'Score column + audience toggle', 'Row height + density'] },
      { path: '/browse/broadway-shows-closing-soon', label: 'Browse — Closing Soon', why: 'Closing-date sort variant', focus: ['Closing-date column treatment', '"Limited Run" pill', 'Date formatting'] },
      { path: '/browse/longest-running-broadway-shows', label: 'Browse — Longest Running', why: 'Performance-count sort + historical mix', focus: ['Performance count column', 'Mix of open + closed rows', 'Status pill treatment'] },
      { path: '/browse/upcoming-broadway-shows', label: 'Browse — Upcoming', why: 'No-score (TBD) variant', focus: ['How TBD score column renders', 'Empty-state hierarchy'] },
      { path: '/browse/tony-winners-on-broadway', label: 'Browse — Tony Winners', why: 'Awards-focused browse variant', focus: ['Award badge inline with row', 'Filtering for award-only rows'] },
      { path: '/best/musicals', label: 'Best of — Musicals', why: 'Editorial best-of variant', focus: ['Curator framing vs algorithmic list', 'Hero treatment for #1'] },
    ],
  },
  {
    heading: 'Discount ticket aggregate pages',
    entries: [
      { path: '/best-value', label: 'Best Value (all discount types)', why: 'All Broadway shows with any discount option', focus: ['Color-coded discount type pills (lottery/rush/digital-rush/student/SRO)', 'Card-grid below the table', 'Price sort column'] },
      { path: '/lotteries', label: 'Lotteries — Broadway', why: 'Lottery-only filter', focus: ['Lottery-specific column set', 'Entry window display'] },
      { path: '/rush', label: 'Rush — Broadway', why: 'Rush-only', focus: ['Rush type variations (in-person/digital/student)'] },
      { path: '/west-end/lotteries', label: 'Lotteries — West End', why: 'WE discount variant; £ currency', focus: ['Currency, time-of-day for UK', 'Parity with Broadway lotteries'] },
    ],
  },
  {
    heading: 'Creative / personnel index pages',
    entries: [
      { path: '/cast', label: 'Actors index', why: 'All Broadway actors; CreativeIndexClient', focus: ['Sort+min-shows filter chip row', 'Avatar/initials treatment', 'Two-column metric cards'] },
      { path: '/directors', label: 'Directors index', why: 'Same component, different category', focus: ['Parity with /cast', 'Director-specific metadata'] },
      { path: '/playwrights', label: 'Playwrights index', why: 'Plays-only flavor of CreativeIndexClient', focus: ['How play-only differs from musical-friendly categories'] },
    ],
  },
  {
    heading: 'Critic / outlet / video-critic index pages',
    entries: [
      { path: '/critics', label: 'Critics index', why: '400+ critic grid with avg score + review count', focus: ['Search bar placement', 'Tier badge treatment', 'Card grid density'] },
      { path: '/critics/outlets', label: 'Outlets index', why: 'Publications grouped by tier (T1/T2/T3)', focus: ['Tier section dividers', 'Outlet logo treatment'] },
      // /video-critics is feature-flag gated (featureFlags.videoReviews) and 404s
      // when off — excluded from the catalog. Re-add when the flag flips on.
    ],
  },
  {
    heading: 'Theater venue pages',
    entries: [
      { path: '/theater', label: 'Theaters — Broadway', why: 'Broadway venue grid with current show + capacity', focus: ['Venue card composition', 'Sort/filter for capacity', 'Current show inline preview'] },
      { path: '/west-end/theater', label: 'Theaters — West End', why: 'WE venue counterpart', focus: ['Market parity'] },
    ],
  },
  {
    heading: 'Gold lists (curated seasonal rankings)',
    entries: [
      { path: '/lists', label: 'Gold Lists — directory hub', why: 'Hub linking to all list types per market', focus: ['Section grid layout', 'GoldListBadge treatment', 'Quick links to latest season + all-time'] },
      { path: '/lists/critical-gold/2024-2025', label: 'Critical Gold — 2024-25', why: 'Per-season ranked list with badges + value indicators', focus: ['Rank badge', 'Per-row badge cluster (audience/value/etc.)', 'Season picker placement'] },
      { path: '/lists/critical-gold/all-time', label: 'Critical Gold — all-time', why: 'All-time variant', focus: ['Relative rank display vs absolute', 'How long-history rows differ'] },
    ],
  },
  {
    heading: 'Commercial / box-office leaderboards',
    entries: [
      { path: '/biz', label: 'Investment dashboard', why: 'Recoupment + at-risk + season stats; mixed cards + tables', focus: ['Dashboard composition (cards + tables)', 'RecoupmentTable vs AllShowsTable styling', 'Status pill color logic'] },
      { path: '/box-office', label: 'Box Office Scorecard (dup link)', why: 'Already in score-aggregate group — included again here for adjacency', focus: ['Same as above'] },
    ],
  },
  {
    heading: 'Awards leaderboards & hubs',
    entries: [
      { path: '/tony-awards', label: 'Tony Awards hub', why: 'Predictions hub with category teasers', focus: ['Category card treatment', 'Top-show teaser composition'] },
      { path: '/tony-awards/people', label: 'Tony Awards — all-time people', why: 'Sortable performer leaderboard', focus: ['Wins+noms columns', 'Sort affordance'] },
      { path: '/olivier-awards', label: 'Olivier Awards hub', why: 'WE awards counterpart', focus: ['Parity with Tony hub'] },
    ],
  },
  {
    heading: 'Rankings hub',
    entries: [
      { path: '/rankings', label: 'Rankings directory', why: 'Hub linking to all browse/discount/data pages', focus: ['Section grid', 'RankingCard composition', 'Navigation hierarchy'] },
    ],
  },
];

export const TOTAL_ENTRIES = CATALOG.reduce((n, g) => n + g.entries.length, 0);
