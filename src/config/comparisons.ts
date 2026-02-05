// Show Comparison Configuration
// Defines popular show comparisons for programmatic SEO pages
// Format: "show-a-slug--vs--show-b-slug"

// Popular comparison pairs (manually curated for high search volume)
// These generate static pages at /compare/[showA]-vs-[showB]
export const COMPARISON_PAIRS: [string, string][] = [
  // Classic matchups
  ['hamilton', 'wicked'],
  ['the-lion-king', 'aladdin'],
  ['the-lion-king', 'wicked'],
  ['hamilton', 'the-lion-king'],
  ['wicked', 'aladdin'],
  ['chicago', 'moulin-rouge'],

  // Family show comparisons
  ['the-lion-king', 'harry-potter'],
  ['aladdin', 'beetlejuice'],
  ['wicked', 'beetlejuice'],

  // Current hit comparisons
  ['hamilton', 'moulin-rouge'],
  ['wicked', 'moulin-rouge'],
  ['the-outsiders', 'water-for-elephants'],

  // Musical vs Play comparisons
  ['hamilton', 'harry-potter'],
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
