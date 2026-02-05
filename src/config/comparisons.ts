// Show Comparison Configuration
// Defines popular show comparisons for programmatic SEO pages
// Format: "show-a-slug--vs--show-b-slug"

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
  ['aladdin', 'the-lion-king'],
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
  ['stereophonic-2024', 'appropriate'],
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
