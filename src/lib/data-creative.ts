// Creative team profile data module
// Builds profiles for directors, playwrights, composers, lyricists at module load time
// Import directly — NOT through data.ts barrel (bundle protection)

import type { CreativeCategory, CreativeProfile, CreativeShowEntry, UnifiedCreativeProfile, UnifiedCreativeShowEntry } from './data-types';
import { getBroadwayShows } from './data-core';
import { slugify } from './data-core';

// ============================================
// Role mapping — which show.creativeTeam roles map to which page category
// ============================================

const ROLE_TO_CATEGORIES: Record<string, CreativeCategory[]> = {
  // Director
  'Director': ['director'],
  'Directors': ['director'],
  // Playwright / Book
  'Playwright': ['playwright'],
  'Book': ['playwright'],
  'Written By': ['playwright'],
  'Writer': ['playwright'],
  'Book Writer': ['playwright'],
  // Composer
  'Music': ['composer'],
  'Composer': ['composer'],
  // Lyricist
  'Lyrics': ['lyricist'],
  'Lyricist': ['lyricist'],
  // Combined roles — appear in multiple categories
  'Music & Lyrics': ['composer', 'lyricist'],
  'Music & Lyrics (catalog)': ['composer', 'lyricist'],
  'Book & Lyrics': ['playwright', 'lyricist'],
  'Lyrics & Book': ['playwright', 'lyricist'],
  'Book, Music & Lyrics': ['playwright', 'composer', 'lyricist'],
  'Music, Lyrics & Book': ['playwright', 'composer', 'lyricist'],
  // Less common variants
  'Co-Writer': ['playwright'],
  'English Lyrics': ['lyricist'],
  'Co-Director': ['director'],
  'Book Writers': ['playwright'],
};

// Roles to exclude even if they contain "Director" (checked lowercase — the LLM
// pipeline emits arbitrary case, see ROLE_TO_CATEGORIES_LOWER below)
const EXCLUDED_DIRECTOR_ROLES = new Set([
  'music director', 'music direction', 'artistic director',
  'associate director', 'resident director',
]);

// Build a lowercase lookup so case-drift ("Book writer" vs "Book Writer") still maps.
// Auto-fix-show-data.js writes whatever case the LLM emitted — data already has 37
// entries with lowercase "Book writer" that the exact-case map silently dropped.
const ROLE_TO_CATEGORIES_LOWER: Record<string, CreativeCategory[]> = {};
for (const [k, v] of Object.entries(ROLE_TO_CATEGORIES)) {
  ROLE_TO_CATEGORIES_LOWER[k.toLowerCase()] = v;
}

export function getCategoriesForRole(role: string): CreativeCategory[] {
  // Direct match first (preserves any case-sensitive lookup callers may rely on)
  if (ROLE_TO_CATEGORIES[role]) return ROLE_TO_CATEGORIES[role];

  // Case-insensitive match next
  const lowerMatch = ROLE_TO_CATEGORIES_LOWER[role.toLowerCase()];
  if (lowerMatch) return lowerMatch;

  const roleLower = role.toLowerCase();
  if (EXCLUDED_DIRECTOR_ROLES.has(roleLower)) return [];

  // Compound roles: split on comma/ampersand/slash/"and" and map each part.
  // Handles "Director & Choreographer", "Book, Music, and Lyrics", "Composer/Lyricist",
  // "Book & Director" — the unmatched parts (Choreographer, Sound Design, …) drop out.
  // Multi-word parts like "Music Direction" or "Sound Design" stay whole and simply
  // don't match, so excluded roles can't leak in through splitting.
  const parts = role.split(/\s*(?:[,&/]|\band\b)\s*/i).map(p => p.trim()).filter(Boolean);
  if (parts.length > 1) {
    // Music-context guard: in "Music Supervisor & Director"-style credits the
    // "Director" part is the music department's, not the show's stage director.
    const isMusicContext = roleLower.includes('music');
    const cats = new Set<CreativeCategory>();
    for (const part of parts) {
      if (EXCLUDED_DIRECTOR_ROLES.has(part.toLowerCase())) continue;
      const mapped = ROLE_TO_CATEGORIES_LOWER[part.toLowerCase()];
      if (mapped) mapped.forEach(c => { if (!(c === 'director' && isMusicContext)) cats.add(c); });
    }
    if (cats.size > 0) return Array.from(cats);
  }

  return [];
}

// ============================================
// Category display config
// ============================================

export const CREATIVE_CATEGORY_CONFIG: Record<CreativeCategory, {
  label: string;
  labelPlural: string;
  routePath: string;
  verbPast: string;
}> = {
  director: { label: 'Director', labelPlural: 'Directors', routePath: 'directors', verbPast: 'directed' },
  playwright: { label: 'Playwright', labelPlural: 'Playwrights', routePath: 'playwrights', verbPast: 'written' },
  composer: { label: 'Composer', labelPlural: 'Composers', routePath: 'composers', verbPast: 'composed' },
  lyricist: { label: 'Lyricist', labelPlural: 'Lyricists', routePath: 'lyricists', verbPast: 'written lyrics for' },
};

export const ALL_CREATIVE_CATEGORIES: CreativeCategory[] = ['director', 'playwright', 'composer', 'lyricist'];

// ============================================
// Build profiles at module load time
// ============================================

// Per-category: name → { roles, shows }
type BuildAccum = Map<string, { roles: Set<string>; shows: CreativeShowEntry[] }>;

const categoryProfiles = new Map<CreativeCategory, CreativeProfile[]>();
const categorySlugs = new Map<CreativeCategory, Map<string, CreativeProfile>>();

function buildAllProfiles() {
  const allShows = getBroadwayShows();

  // Accumulate per category
  const accum: Record<CreativeCategory, BuildAccum> = {
    director: new Map(),
    playwright: new Map(),
    composer: new Map(),
    lyricist: new Map(),
  };

  for (const show of allShows) {
    if (!show.creativeTeam) continue;

    const showEntry: Omit<CreativeShowEntry, 'role'> = {
      title: show.title,
      slug: show.slug,
      venue: show.venue,
      openingDate: show.openingDate || null,
      closingDate: show.closingDate || null,
      status: show.status,
      type: show.type,
      thumbnail: show.images?.thumbnail || null,
      isRevival: !!(show.tags && show.tags.includes('revival')),
      season: show.season || null,
      score: show.criticScore?.score ?? null,
    };

    for (const member of show.creativeTeam) {
      const categories = getCategoriesForRole(member.role);
      for (const cat of categories) {
        const map = accum[cat];
        let entry = map.get(member.name);
        if (!entry) {
          entry = { roles: new Set(), shows: [] };
          map.set(member.name, entry);
        }
        entry.roles.add(member.role);
        // Avoid duplicate show entries for same person+show+category
        // (can happen if person has both "Music" and "Music & Lyrics" on same show)
        if (!entry.shows.some(s => s.slug === show.slug)) {
          entry.shows.push({ ...showEntry, role: member.role });
        }
      }
    }
  }

  // Build profiles for each category
  for (const cat of ALL_CREATIVE_CATEGORIES) {
    const slugMap = new Map<string, CreativeProfile>();
    const profiles: CreativeProfile[] = [];

    for (const [name, data] of Array.from(accum[cat].entries())) {
      const scoredShows = data.shows.filter(s => s.score !== null);
      const avgScore = scoredShows.length > 0
        ? Math.round(scoredShows.reduce((sum, s) => sum + (s.score || 0), 0) / scoredShows.length)
        : null;
      const highScore = scoredShows.length > 0
        ? Math.max(...scoredShows.map(s => s.score!))
        : null;
      const lowScore = scoredShows.length > 0
        ? Math.min(...scoredShows.map(s => s.score!))
        : null;

      // Slug with collision handling
      let slug = slugify(name);
      if (slugMap.has(slug)) {
        let counter = 2;
        while (slugMap.has(`${slug}-${counter}`)) counter++;
        slug = `${slug}-${counter}`;
      }

      // Sort shows by opening date (newest first), nulls last
      const sortedShows = [...data.shows].sort((a, b) => {
        if (!a.openingDate && !b.openingDate) return 0;
        if (!a.openingDate) return 1;
        if (!b.openingDate) return -1;
        return new Date(b.openingDate).getTime() - new Date(a.openingDate).getTime();
      });

      const profile: CreativeProfile = {
        name,
        slug,
        category: cat,
        roles: Array.from(data.roles),
        shows: sortedShows,
        showCount: data.shows.length,
        scoredShowCount: scoredShows.length,
        avgScore,
        highScore,
        lowScore,
        openShowCount: data.shows.filter(s => s.status === 'open' || s.status === 'previews').length,
        closedShowCount: data.shows.filter(s => s.status === 'closed').length,
      };

      profiles.push(profile);
      slugMap.set(slug, profile);
    }

    // Sort by show count descending
    profiles.sort((a, b) => b.showCount - a.showCount);

    categoryProfiles.set(cat, profiles);
    categorySlugs.set(cat, slugMap);
  }
}

// ============================================
// Unified profiles — one page per person across ALL categories
// ============================================

const unifiedProfiles: UnifiedCreativeProfile[] = [];
const unifiedSlugMap = new Map<string, UnifiedCreativeProfile>();
const nameToUnifiedSlug = new Map<string, string>();

function buildUnifiedProfiles() {
  const allShows = getBroadwayShows();

  // person name → { categories, roles, showMap: slug → { entry, roles } }
  const personMap = new Map<string, {
    categories: Set<CreativeCategory>;
    allRoles: Set<string>;
    showMap: Map<string, { entry: Omit<UnifiedCreativeShowEntry, 'roles'>; roles: Set<string> }>;
  }>();

  for (const show of allShows) {
    if (!show.creativeTeam) continue;

    const baseEntry = {
      title: show.title,
      slug: show.slug,
      showId: show.id,
      venue: show.venue,
      openingDate: show.openingDate || null,
      closingDate: show.closingDate || null,
      status: show.status,
      type: show.type,
      thumbnail: show.images?.thumbnail || null,
      isRevival: !!(show.tags && show.tags.includes('revival')),
      season: show.season || null,
      score: show.criticScore?.score ?? null,
    };

    for (const member of show.creativeTeam) {
      const categories = getCategoriesForRole(member.role);
      if (categories.length === 0) continue;

      let person = personMap.get(member.name);
      if (!person) {
        person = { categories: new Set(), allRoles: new Set(), showMap: new Map() };
        personMap.set(member.name, person);
      }

      for (const cat of categories) {
        person.categories.add(cat);
      }
      person.allRoles.add(member.role);

      let showEntry = person.showMap.get(show.slug);
      if (!showEntry) {
        showEntry = { entry: baseEntry, roles: new Set() };
        person.showMap.set(show.slug, showEntry);
      }
      showEntry.roles.add(member.role);
    }
  }

  // Build profiles from accumulated data
  // Use Array.from() — downlevelIteration is disabled
  for (const [name, data] of Array.from(personMap.entries())) {
    const shows: UnifiedCreativeShowEntry[] = [];
    for (const [, showData] of Array.from(data.showMap.entries())) {
      shows.push({
        ...showData.entry,
        roles: Array.from(showData.roles),
      });
    }

    // Sort by opening date (newest first), nulls last
    shows.sort((a, b) => {
      if (!a.openingDate && !b.openingDate) return 0;
      if (!a.openingDate) return 1;
      if (!b.openingDate) return -1;
      return new Date(b.openingDate).getTime() - new Date(a.openingDate).getTime();
    });

    const scoredShows = shows.filter(s => s.score !== null);
    const avgScore = scoredShows.length > 0
      ? Math.round(scoredShows.reduce((sum, s) => sum + (s.score || 0), 0) / scoredShows.length)
      : null;
    const highScore = scoredShows.length > 0
      ? Math.max(...scoredShows.map(s => s.score!))
      : null;
    const lowScore = scoredShows.length > 0
      ? Math.min(...scoredShows.map(s => s.score!))
      : null;

    // Slug with collision guard
    let slug = slugify(name);
    if (unifiedSlugMap.has(slug)) {
      // Different person, same slug — append disambiguator
      const existing = unifiedSlugMap.get(slug)!;
      if (existing.name !== name) {
        console.warn(`[data-creative] Slug collision: "${name}" and "${existing.name}" both slugify to "${slug}". Appending disambiguator.`);
        let counter = 2;
        while (unifiedSlugMap.has(`${slug}-${counter}`)) counter++;
        slug = `${slug}-${counter}`;
      }
    }

    const profile: UnifiedCreativeProfile = {
      name,
      slug,
      categories: Array.from(data.categories),
      allRoles: Array.from(data.allRoles),
      shows,
      showCount: shows.length,
      scoredShowCount: scoredShows.length,
      avgScore,
      highScore,
      lowScore,
      openShowCount: shows.filter(s => s.status === 'open' || s.status === 'previews').length,
      closedShowCount: shows.filter(s => s.status === 'closed').length,
    };

    unifiedProfiles.push(profile);
    unifiedSlugMap.set(slug, profile);
    nameToUnifiedSlug.set(name, slug);
  }

  // Sort by show count descending
  unifiedProfiles.sort((a, b) => b.showCount - a.showCount);
}

// Build on first access (lazy init)
let built = false;
function ensureBuilt() {
  if (!built) {
    buildAllProfiles();
    buildUnifiedProfiles();
    built = true;
  }
}

// ============================================
// Public API
// ============================================

export function getCreativeProfiles(category: CreativeCategory): CreativeProfile[] {
  ensureBuilt();
  return categoryProfiles.get(category) || [];
}

export function getCreativeSlugs(category: CreativeCategory): string[] {
  ensureBuilt();
  const slugMap = categorySlugs.get(category);
  return slugMap ? Array.from(slugMap.keys()) : [];
}

/**
 * Get the link path for a creative team member based on their role.
 * Returns the unified /creative/ page URL, or null if no creative page exists.
 */
export function getCreativeLink(name: string, _role: string): string | null {
  ensureBuilt();
  const slug = nameToUnifiedSlug.get(name);
  return slug ? `/creative/${slug}` : null;
}

// ============================================
// Unified profiles — public API
// ============================================

export function getUnifiedCreativeProfile(slug: string): UnifiedCreativeProfile | undefined {
  ensureBuilt();
  return unifiedSlugMap.get(slug);
}

export function getAllUnifiedCreativeProfiles(): UnifiedCreativeProfile[] {
  ensureBuilt();
  return unifiedProfiles;
}

export function getUnifiedCreativeSlugs(): string[] {
  ensureBuilt();
  return Array.from(unifiedSlugMap.keys());
}

export function getUnifiedSlugForName(name: string): string | undefined {
  ensureBuilt();
  return nameToUnifiedSlug.get(name);
}
