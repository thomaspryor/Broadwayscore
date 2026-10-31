// Creative team profile data module
// Builds profiles for directors, playwrights, composers, lyricists at module load time
// Import directly — NOT through data.ts barrel (bundle protection)

import type { CreativeCategory, CreativeProfile, CreativeShowEntry, UnifiedCreativeProfile, UnifiedCreativeShowEntry } from './data-types';
import { getBroadwayShows } from './data-core';
import { slugify } from './data-core';
import { getCategoriesForRole as getCategoriesForRoleJs } from '../../scripts/lib/creative-roles';
import { creativeNamesInPageOrder } from '../../scripts/lib/page-name-sources';
import { assignUniqueSlugs } from '../../scripts/lib/url-slug';
import { resolveNameRedirect, type SlugRedirectMap } from './slug-redirects';
// Retired-slug map (prebuild: scripts/build-slug-redirects.js) — getUnifiedCreativeProfile
// falls back through it, exactly like data-reviews.ts getCriticBySlug()
import slugRedirectsData from '../../data/slug-redirects-compact.json';

// ============================================
// Role mapping — which show.creativeTeam roles map to which page category
// ============================================

/**
 * The role table and its compound-role splitting live in
 * scripts/lib/creative-roles.js (ONE copy, shared with
 * scripts/build-slug-redirects.js, which must know which creative-team names
 * become pages — and in what order — to derive the retired-slug redirects;
 * S7-T3 follow-up). Re-exported here so every site caller keeps importing it
 * from this module.
 */
export function getCategoriesForRole(role: string): CreativeCategory[] {
  return getCategoriesForRoleJs(role);
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

  // Slugs, with collision numbering, from the ONE shared rule: the names in
  // page order (scripts/lib/page-name-sources.js creativeNamesInPageOrder —
  // the same walk as the loop above) through assignUniqueSlugs
  // (scripts/lib/url-slug.js). scripts/build-slug-redirects.js replays exactly
  // this over shows.json to derive the retired pre-fold slugs, so "Noël Coward"
  // (`noel-coward-2`, because "Noel Coward" reached `noel-coward` first) redirects
  // to the page it actually gets, never to the other person (S7-T3 follow-up).
  const namesInPageOrder = creativeNamesInPageOrder(allShows);
  const slugByName = new Map<string, string>();
  assignUniqueSlugs(namesInPageOrder).forEach((slug, i) => slugByName.set(namesInPageOrder[i], slug));

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

    // Slug with collision guard (assigned above; a numbered slug means a
    // different person already owns slugify(name))
    const slug = slugByName.get(name) ?? slugify(name);
    if (slug !== slugify(name)) {
      const existing = unifiedSlugMap.get(slugify(name));
      console.warn(`[data-creative] Slug collision: "${name}" and "${existing?.name ?? '?'}" both slugify to "${slugify(name)}". Appending disambiguator.`);
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

const nameRedirectMap: SlugRedirectMap = slugRedirectsData as Record<string, string>;

/**
 * @param redirects the compact redirect map — tests only; production callers
 *   always resolve through the tracked data/slug-redirects-compact.json.
 */
export function getUnifiedCreativeProfile(slug: string, redirects: SlugRedirectMap = nameRedirectMap): UnifiedCreativeProfile | undefined {
  ensureBuilt();
  const exact = unifiedSlugMap.get(slug);
  if (exact) return exact;
  // Retired (pre-S7-T3, unfolded) slug → the live profile. Requests normally
  // never get here — src/middleware.ts 301s first — but any caller holding an
  // old slug (or a runtime without the middleware) still finds the page.
  const live = resolveNameRedirect(redirects, 'creative', slug);
  return live ? unifiedSlugMap.get(live) : undefined;
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
