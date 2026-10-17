// Shared Tony Award category constants and utilities

// Category importance order - most prestigious first
export const TONY_CATEGORY_ORDER = [
  'Best Musical',
  'Best Play',
  'Best Revival of a Musical',
  'Best Revival of a Play',
  'Best Book of a Musical',
  'Best Original Score',
  'Best Actor in a Musical',
  'Best Actress in a Musical',
  'Best Actor in a Play',
  'Best Actress in a Play',
  'Best Direction of a Musical',
  'Best Direction of a Play',
  'Best Featured Actor in a Musical',
  'Best Featured Actress in a Musical',
  'Best Featured Actor in a Play',
  'Best Featured Actress in a Play',
  'Best Choreography',
  'Best Orchestrations',
  'Best Scenic Design',
  'Best Scenic Design of a Musical',
  'Best Scenic Design of a Play',
  'Best Costume Design',
  'Best Costume Design of a Musical',
  'Best Costume Design of a Play',
  'Best Lighting Design',
  'Best Lighting Design of a Musical',
  'Best Lighting Design of a Play',
  'Best Sound Design',
  'Best Sound Design of a Musical',
  'Best Sound Design of a Play',
];

// Sort awards by importance
export function sortByImportance(items: string[]): string[] {
  return [...items].sort((a, b) => {
    const aIndex = TONY_CATEGORY_ORDER.indexOf(a);
    const bIndex = TONY_CATEGORY_ORDER.indexOf(b);
    const aOrder = aIndex === -1 ? 999 : aIndex;
    const bOrder = bIndex === -1 ? 999 : bIndex;
    return aOrder - bOrder;
  });
}

// Check if category is a "major" award (top-tier)
const MAJOR_CATEGORIES = [
  'Best Musical',
  'Best Play',
  'Best Revival of a Musical',
  'Best Revival of a Play',
  'Best Book of a Musical',
  'Best Original Score',
  'Best Actor in a Musical',
  'Best Actress in a Musical',
  'Best Actor in a Play',
  'Best Actress in a Play',
  'Best Direction of a Musical',
  'Best Direction of a Play',
];

export function isMajorCategory(category: string): boolean {
  return MAJOR_CATEGORIES.includes(category);
}

// Acting categories — used to distinguish actor vs creative nominations
const ACTING_CATEGORIES = [
  'Best Actor in a Musical',
  'Best Actress in a Musical',
  'Best Actor in a Play',
  'Best Actress in a Play',
  'Best Featured Actor in a Musical',
  'Best Featured Actress in a Musical',
  'Best Featured Actor in a Play',
  'Best Featured Actress in a Play',
];

export function isActingCategory(category: string): boolean {
  return ACTING_CATEGORIES.includes(category);
}

// Lead vs featured distinction
export function isLeadCategory(category: string): boolean {
  return category.startsWith('Best Actor') || category.startsWith('Best Actress');
}

export function isFeaturedCategory(category: string): boolean {
  return category.startsWith('Best Featured');
}
