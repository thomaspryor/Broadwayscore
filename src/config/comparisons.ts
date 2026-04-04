// Show Comparison Configuration
// Defines popular show comparisons for programmatic SEO pages
// Format: "show-a-slug--vs--show-b-slug"

// Categories for hub page display
export interface ComparisonCategory {
  label: string;
  description: string;
  pairs: [string, string][];
}

export const COMPARISON_CATEGORIES: ComparisonCategory[] = [
  {
    label: 'Most Popular Matchups',
    description: 'The comparisons Broadway fans search for most',
    pairs: [
      ['hamilton', 'wicked'],
      ['the-lion-king', 'aladdin'],
      ['the-lion-king', 'wicked'],
      ['hamilton', 'the-lion-king'],
      ['wicked', 'aladdin'],
      ['hamilton', 'moulin-rouge'],
    ],
  },
  {
    label: 'Current Hits',
    description: 'Compare the hottest shows playing now',
    pairs: [
      ['operation-mincemeat', 'six'],
      ['operation-mincemeat', 'hadestown'],
      ['buena-vista-social-club', 'moulin-rouge'],
      ['buena-vista-social-club', 'hadestown'],
      ['ragtime', 'hamilton'],
      ['chess', 'six'],
      ['schmigadoon', 'six'],
      ['schmigadoon', 'and-juliet'],
      ['titanique', 'six'],
      ['cats-the-jellicle-ball', 'the-lion-king'],
      ['death-becomes-her', 'chicago'],
      ['maybe-happy-ending', 'hadestown'],
      ['the-great-gatsby', 'moulin-rouge'],
      ['hells-kitchen', 'mj'],
      ['hells-kitchen', 'six'],
    ],
  },
  {
    label: 'Family Shows',
    description: 'Finding the right show for kids and families',
    pairs: [
      ['the-lion-king', 'harry-potter'],
      ['aladdin', 'harry-potter'],
      ['wicked', 'harry-potter'],
      ['aladdin', 'six'],
      ['the-lion-king', 'beetlejuice-2019'],
      ['aladdin', 'beetlejuice-2019'],
      ['the-lion-king', 'mj'],
      ['aladdin', 'mj'],
    ],
  },
  {
    label: 'Musicals Head-to-Head',
    description: 'The great musical debates',
    pairs: [
      ['hadestown', 'moulin-rouge'],
      ['hadestown', 'wicked'],
      ['hadestown', 'hamilton'],
      ['book-of-mormon', 'hamilton'],
      ['book-of-mormon', 'wicked'],
      ['six', 'hadestown'],
      ['mj', 'hadestown'],
      ['mj', 'moulin-rouge'],
      ['and-juliet', 'mj'],
      ['and-juliet', 'moulin-rouge'],
    ],
  },
];

// Flat list for static generation (includes all pairs from categories + uncategorized)
// Popular comparison pairs (manually curated for high search volume)
// These generate static pages at /compare/[showA]-vs-[showB]
export const COMPARISON_PAIRS: [string, string][] = [
  // === TOP TIER: Most-searched matchups ===
  ['hamilton', 'wicked'],
  ['the-lion-king', 'aladdin'],
  ['the-lion-king', 'wicked'],
  ['hamilton', 'the-lion-king'],
  ['wicked', 'aladdin'],
  ['hamilton', 'moulin-rouge'],

  // === LONG-RUNNING MUSICALS ===
  ['chicago', 'moulin-rouge'],
  ['chicago', 'wicked'],
  ['chicago', 'hamilton'],
  ['the-lion-king', 'moulin-rouge'],
  ['book-of-mormon', 'hamilton'],
  ['book-of-mormon', 'wicked'],
  ['hadestown', 'moulin-rouge'],
  ['hadestown', 'wicked'],
  ['hadestown', 'hamilton'],
  ['six', 'hadestown'],
  ['six', 'and-juliet'],
  ['mj', 'hadestown'],
  ['mj', 'moulin-rouge'],

  // === FAMILY SHOWS ===
  ['the-lion-king', 'harry-potter'],
  ['aladdin', 'harry-potter'],
  ['wicked', 'harry-potter'],
  ['the-lion-king', 'mj'],
  ['aladdin', 'mj'],

  // === CURRENT HITS (2024-2025) ===
  ['the-outsiders', 'water-for-elephants'],
  ['hells-kitchen', 'the-outsiders'],
  ['hells-kitchen', 'hadestown'],
  ['the-great-gatsby', 'moulin-rouge'],
  ['death-becomes-her', 'chicago'],
  ['oh-mary', 'cabaret-2024'],
  ['maybe-happy-ending', 'the-notebook'],
  ['stranger-things', 'beetlejuice-2019'],

  // === JUKEBOX MUSICALS ===
  ['mj', 'six'],
  ['and-juliet', 'mj'],
  ['and-juliet', 'moulin-rouge'],

  // === DRAMATIC PLAYS ===
  ['harry-potter', 'stranger-things'],
  ['stereophonic', 'appropriate'],
  ['death-of-a-salesman', 'oedipus'],

  // === REVIVALS & CLASSICS ===
  ['cabaret-2024', 'chicago'],
  ['sweeney-todd-2023', 'hadestown'],
  ['sunset-boulevard-2024', 'chicago'],
  ['sunset-boulevard-2024', 'cabaret-2024'],

  // === MUSICAL VS PLAY ===
  ['hamilton', 'harry-potter'],
  ['wicked', 'stranger-things'],

  // === HISTORICAL CLASSICS ===
  ['the-phantom-of-the-opera-1988', 'les-miserables-2014'],
  ['rent-1996', 'dear-evan-hansen-2016'],
  ['come-from-away-2017', 'dear-evan-hansen-2016'],
  ['jersey-boys-2005', 'mj'],
  ['mean-girls-2018', 'six'],
  ['frozen-2018', 'aladdin'],
  ['beetlejuice-2019', 'mean-girls-2018'],

  // === EXPANDED: 2025-2026 NEW SHOWS ===
  ['dog-day-afternoon', 'oh-mary'],
  ['dog-day-afternoon', 'the-outsiders'],
  ['beaches', 'death-becomes-her'],
  ['the-lost-boys', 'beetlejuice-2019'],
  ['the-lost-boys', 'stranger-things'],
  ['the-balusters', 'stereophonic'],
  ['hells-kitchen', 'mj'],
  ['hells-kitchen', 'six'],
  ['death-becomes-her', 'beetlejuice-2019'],
  ['maybe-happy-ending', 'hadestown'],
  ['the-great-gatsby', 'death-becomes-her'],
  ['sunset-boulevard-2024', 'the-great-gatsby'],
  ['oh-mary', 'stereophonic'],
  ['cabaret-2024', 'hadestown'],
  ['water-for-elephants', 'moulin-rouge'],

  // === EXPANDED: CROSS-GENRE POPULAR MATCHUPS ===
  ['wicked', 'moulin-rouge'],
  ['hamilton', 'six'],
  ['hamilton', 'cabaret-2024'],
  ['book-of-mormon', 'six'],
  ['book-of-mormon', 'moulin-rouge'],
  ['hadestown', 'the-outsiders'],
  ['six', 'wicked'],
  ['wicked', 'beetlejuice-2019'],
  ['mj', 'hamilton'],
  ['the-lion-king', 'six'],
  ['the-lion-king', 'hadestown'],

  // === EXPANDED: BEST-OF-ERA DEBATES ===
  ['dear-evan-hansen-2016', 'hadestown'],
  ['come-from-away-2017', 'hadestown'],
  ['come-from-away-2017', 'hamilton'],
  ['the-band-s-visit-2017', 'hadestown'],
  ['the-band-s-visit-2017', 'come-from-away-2017'],
  ['sweeney-todd-2023', 'cabaret-2024'],
  ['stereophonic', 'the-outsiders'],
  ['hells-kitchen', 'maybe-happy-ending'],
  ['the-notebook', 'water-for-elephants'],
  ['rent-1996', 'hamilton'],
  ['the-phantom-of-the-opera-1988', 'wicked'],
  ['les-miserables-2014', 'hamilton'],

  // === EXPANDED: SHOW TYPE COMPARISONS ===
  ['and-juliet', 'beetlejuice-2019'],
  ['beetlejuice-2019', 'hadestown'],
  ['mj', 'the-outsiders'],
  ['mean-girls-2018', 'and-juliet'],
  ['jersey-boys-2005', 'and-juliet'],
  ['jersey-boys-2005', 'six'],

  // === EXPANDED: FAMILY SHOW COMPARISONS ===
  ['aladdin', 'six'],
  ['the-lion-king', 'beetlejuice-2019'],
  ['aladdin', 'beetlejuice-2019'],
  ['aladdin', 'mean-girls-2018'],

  // === 2025-2026 SEASON: NEW SHOWS ===
  ['operation-mincemeat', 'six'],
  ['operation-mincemeat', 'hadestown'],
  ['buena-vista-social-club', 'moulin-rouge'],
  ['buena-vista-social-club', 'hadestown'],
  ['ragtime', 'hamilton'],
  ['ragtime', 'hadestown'],
  ['chess', 'six'],
  ['chess', 'hamilton'],
  ['two-strangers', 'maybe-happy-ending'],
  ['schmigadoon', 'six'],
  ['schmigadoon', 'and-juliet'],
  ['titanique', 'six'],
  ['titanique', 'and-juliet'],
  ['cats-the-jellicle-ball', 'the-lion-king'],
  ['cats-the-jellicle-ball', 'six'],
  ['beaches', 'moulin-rouge'],
  ['the-rocky-horror-show', 'beetlejuice-2019'],
  ['the-lost-boys', 'death-becomes-her'],
  ['death-of-a-salesman', 'the-great-gatsby'],
  ['giant', 'the-outsiders'],
];

// Generate all comparison slugs for static generation
export function getAllComparisonSlugs(): string[] {
  return COMPARISON_PAIRS.map(([a, b]) => `${a}-vs-${b}`);
}

// Parse a comparison slug into show slugs
export function parseComparisonSlug(slug: string): { showA: string; showB: string } | null {
  const match = slug.match(/^(.+)-vs-(.+)$/);
  if (!match) return null;

  const [, showA, showB] = match;
  return { showA, showB };
}

// Check if a comparison is in our curated list
export function isValidComparison(showA: string, showB: string): boolean {
  return COMPARISON_PAIRS.some(
    ([a, b]) => (a === showA && b === showB) || (a === showB && b === showA)
  );
}

// Get all comparison pages featuring a specific show (for internal linking)
export function getComparisonsForShow(showSlug: string): { slug: string; otherSlug: string }[] {
  return COMPARISON_PAIRS
    .filter(([a, b]) => a === showSlug || b === showSlug)
    .map(([a, b]) => ({
      slug: `${a}-vs-${b}`,
      otherSlug: a === showSlug ? b : a,
    }));
}
