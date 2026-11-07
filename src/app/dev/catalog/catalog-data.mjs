// Single source of truth for the show-page catalog.
// Imported by:
//   - src/app/dev/catalog/page.tsx        (renders the index page)
//   - scripts/capture-show-page-catalog.mjs (Playwright screenshots)
//
// Plain .mjs (no TS) so the capture script can import it directly via Node
// without going through the TS pipeline.
//
// To add a state Claude Design is missing: append an entry to the right group
// (or add a new group). The screenshots regenerate when you re-run the
// capture script.

/** @typedef {{ slug: string, label: string, why: string, focus: string[] }} CatalogEntry */
/** @typedef {{ heading: string, entries: CatalogEntry[] }} CatalogGroup */

/** @type {CatalogGroup[]} */
export const CATALOG = [
  {
    heading: 'Open · Broadway · Mega-hit (long-running, established)',
    entries: [
      { slug: 'hamilton', label: 'Hamilton', why: 'Long-running must-see musical; lots of awards, audience data, social pulse', focus: ['CriticScore must-see crown', 'AwardScoreCard winners panel', 'BoxOfficeStats stable', 'AudienceBuzzCard full sources'] },
      { slug: 'wicked', label: 'Wicked', why: '20-year run; mega box office; established cast updates', focus: ['BizBuzzCard recouped + designation Hit', 'AllTime grosses', 'CastUpdatesCard timeline'] },
      { slug: 'the-lion-king', label: 'The Lion King', why: 'Longest-running open; reference for stable-state UI', focus: ['Showtimes weekly grid', 'Recouped commercial'] },
    ],
  },
  {
    heading: 'Open · Broadway · Recent opening (post-2026-04-15)',
    entries: [
      { slug: 'the-lost-boys', label: 'The Lost Boys', why: 'Opened 2026-04-26 (latest opening); shows fresh-review tier states', focus: ['CriticScore tier as it landed', 'ScoreBreakdownBar', 'Critic reviews list'] },
      { slug: 'joe-turners-come-and-gone', label: "Joe Turner's Come and Gone", why: 'Recent play; smaller-scale data shape', focus: ['Play (not musical) variant', 'Smaller cast section'] },
      { slug: 'oh-mary', label: 'Oh, Mary!', why: 'Award-winning comedy; high audience buzz', focus: ['AudienceBuzzCard A+', 'AwardScore high tier'] },
      { slug: 'maybe-happy-ending', label: 'Maybe Happy Ending', why: 'Tony winner musical; recent', focus: ['AwardScoreCard sweep/winner state', 'High award score badge'] },
    ],
  },
  {
    heading: 'Open · Broadway · Mixed / lower score tiers',
    entries: [
      { slug: 'death-becomes-her', label: 'Death Becomes Her', why: 'Mid-tier commercial musical; mixed critic reception', focus: ['Good/Tepid tier styling', 'Score breakdown asymmetry'] },
      { slug: 'the-great-gatsby', label: 'The Great Gatsby', why: 'Skippable tier; large commercial run nonetheless', focus: ['Skip/Tepid tier badge', 'Commercial card despite low critic score'] },
    ],
  },
  {
    heading: 'Open · West End',
    entries: [
      { slug: 'hamilton-west-end', label: 'Hamilton (West End)', why: 'London hit; £ currency in showtimes/tickets', focus: ['West End branding (header, breadcrumb)', '£ currency', 'Limited audience sources note'] },
      { slug: 'hadestown-west-end', label: 'Hadestown (West End)', why: 'Recent transfer; West End scoring', focus: ['West End market gates (no Box Office stats)', 'Limited Run badge if applicable'] },
      { slug: 'oh-mary-west-end', label: 'Oh, Mary! (West End)', why: 'Cross-Atlantic transfer; production lineage links', focus: ['Other productions cross-link', 'West End rank columns'] },
      { slug: 'the-lion-king-west-end', label: 'The Lion King (West End)', why: 'Stable long-running West End anchor', focus: ['West End footer/social pulse if any'] },
    ],
  },
  {
    heading: 'Open · Off-Broadway',
    entries: [
      { slug: 'the-receptionist-off-broadway', label: 'The Receptionist (OB)', why: 'Standard Off-Broadway play', focus: ['Off-Broadway market label', 'No commercial / no box office sections'] },
      { slug: 'kenrex-off-broadway', label: 'Kenrex (OB)', why: 'Smaller-scale OB', focus: ['Off-Broadway empty-state sections'] },
    ],
  },
  {
    heading: 'Open · Off-West End',
    entries: [
      { slug: 'magic-mike-live-west-end', label: 'Magic Mike Live', why: 'Off-West End edge case', focus: ['Off-West End market gate', 'Long-running off-West End ranks'] },
      { slug: 'into-the-woods-west-end-2025', label: 'Into the Woods (Off-WE 2025)', why: 'Limited-run Off-West End musical', focus: ['Closing/limited-run signaling'] },
    ],
  },
  {
    heading: 'Upcoming · Broadway (pre-previews)',
    entries: [
      { slug: 'inter-alia', label: 'Inter Alia', why: 'Upcoming — pre-previews state', focus: ['TBD score badge', 'No reviews list yet', 'Empty-state suppression across cards'] },
      { slug: 'school-girls-or-the-african-mean-girls-play', label: 'School Girls', why: 'Upcoming play; tests upcoming non-musical', focus: ['Status pill: Upcoming', 'Showtimes empty/coming-soon'] },
    ],
  },
  {
    heading: 'Closed · Broadway (recent)',
    entries: [
      { slug: 'bug', label: 'Bug', why: 'Recently closed; shows post-close state', focus: ['Status closed pill', 'No live ticket buttons', 'All-time grosses only', 'No active cast section'] },
      { slug: 'marjorie-prime', label: 'Marjorie Prime', why: 'Closed play; shorter run', focus: ['Run duration display', 'Final week grosses snapshot'] },
      { slug: 'queen-of-versailles', label: 'Queen of Versailles', why: 'Closed; tests closed-state collapse', focus: ['Cast updates timeline frozen', 'No upcoming showtimes'] },
    ],
  },
  {
    heading: 'Closed · Historical legend (decades-ago)',
    entries: [
      { slug: 'cats-1982', label: 'Cats (1982 original)', why: 'Historical mega-run; pre-2015 limited audience sources', focus: ['Limited audience sources note', 'Awards/legacy display', 'Historical run length (1982–2000)'] },
      { slug: 'cats-2016', label: 'Cats (2016 revival)', why: 'Limited-run revival; bridges historical and modern UI', focus: ['Revival lineage', 'Closed-state pills'] },
    ],
  },
];

export const TOTAL_ENTRIES = CATALOG.reduce((n, g) => n + g.entries.length, 0);
