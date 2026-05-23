// Actor profile data module
// Builds profiles for Broadway actors from cast data files
// Import directly — NOT through data.ts barrel (bundle protection)

import type { ActorProfile, ActorShowEntry } from './data-types';
import { getBroadwayShows, slugify } from './data-core';
import { getAudienceBuzz } from './data-audience';
// Static manifest: data/cast-manifest.json is built by
// scripts/build-cast-manifest.js in prebuild. It collapses ~2400 per-show
// cast files (~300MB) into a single static-required JSON so Vercel's NFT
// can keep data/cast/** out of the serverless bundle. NEVER replace this
// with fs.readdirSync('data/cast') — that re-bundles every cast file
// (tripping Vercel's 300MB limit) AND silently 404s every /cast/[slug]
// page when next.config.js excludes data/cast/** from NFT.
// See memory/feedback_vercel_nft_dynamic_paths.md.
import castManifest from '../../data/cast-manifest.json';
import actorImagesData from '../../data/actor-images.json';

type CastManifestEntry = {
  showId: string;
  castType: 'obc' | 'replacement' | 'current';
  name: string;
  ibdbPersonId: string;
  role: string;
  flags?: string[];
};

// ============================================
// Lazy-init state
// ============================================

let profiles: ActorProfile[] = [];
const slugMap = new Map<string, ActorProfile>();
const idToSlug = new Map<string, string>(); // ibdbPersonId → slug
let built = false;

function ensureBuilt() {
  if (!built) {
    buildAllProfiles();
    built = true;
  }
}

// ============================================
// Build profiles at first access
// ============================================

function buildAllProfiles() {
  const allShows = getBroadwayShows();
  const showMap = new Map(allShows.map(s => [s.id, s]));

  // Accumulate: ibdbPersonId → { name, showEntries }
  const actorMap = new Map<string, {
    name: string;
    ibdbPersonId: string;
    showMap: Map<string, { entry: ActorShowEntry; flags: Set<string> }>;
  }>();

  const buzzCache = new Map<string, ReturnType<typeof getAudienceBuzz> | null>();
  const allEntries = (castManifest as { entries: CastManifestEntry[] }).entries;

  for (const member of allEntries) {
    const show = showMap.get(member.showId);
    if (!show) continue;

    let buzz = buzzCache.get(member.showId);
    if (buzz === undefined) {
      buzz = getAudienceBuzz(member.showId) ?? null;
      buzzCache.set(member.showId, buzz);
    }

    const castType = member.castType;

    let actor = actorMap.get(member.ibdbPersonId);
    if (!actor) {
      actor = {
        name: member.name,
        ibdbPersonId: member.ibdbPersonId,
        showMap: new Map(),
      };
      actorMap.set(member.ibdbPersonId, actor);
    }

    // Use the most recent name spelling
    if (castType === 'current') {
      actor.name = member.name;
    }

    // Dedup per show — keep first entry (OBC takes priority for role/flags).
    // Manifest preserves source-file order: obc → replacement → current,
    // matching the original processCast() invocation order.
    if (!actor.showMap.has(member.showId)) {
      actor.showMap.set(member.showId, {
        entry: {
          title: show.title,
          slug: show.slug,
          showId: member.showId,
          role: member.role,
          castType,
          venue: show.venue,
          openingDate: show.openingDate || null,
          closingDate: show.closingDate || null,
          status: show.status,
          type: show.type,
          thumbnail: show.images?.thumbnail || null,
          isRevival: !!(show.tags && show.tags.includes('revival')),
          score: show.criticScore?.score ?? null,
          audienceScore: buzz?.combinedScore ?? null,
          category: show.category,
          wasObc: castType === 'obc',
        },
        flags: new Set(member.flags || []),
      });
    } else {
      const existing = actor.showMap.get(member.showId)!;
      // Upgrade castType: if actor is in currentCast, mark as 'current'
      // even if they were originally OBC (they're still performing)
      if (castType === 'current') {
        existing.entry.castType = 'current';
      }
      // Preserve wasObc flag if they were originally in the opening night cast
      if (castType === 'obc') {
        existing.entry.wasObc = true;
      }
      if (member.flags) {
        for (const flag of member.flags) existing.flags.add(flag);
      }
    }
  }

  const actorImages = actorImagesData as Record<string, { name: string; imageUrl: string; source: string }>;

  // Build profiles from accumulated data
  for (const [, data] of Array.from(actorMap.entries())) {
    const shows: ActorShowEntry[] = [];
    let hasBroadwayDebut = false;

    for (const [, showData] of Array.from(data.showMap.entries())) {
      const flags = Array.from(showData.flags);
      if (flags.some(f => f.toLowerCase().includes('broadway debut'))) {
        hasBroadwayDebut = true;
      }
      shows.push({ ...showData.entry, flags });
    }

    // Sort by opening date (newest first), nulls last
    shows.sort((a, b) => {
      if (!a.openingDate && !b.openingDate) return 0;
      if (!a.openingDate) return 1;
      if (!b.openingDate) return -1;
      return new Date(b.openingDate).getTime() - new Date(a.openingDate).getTime();
    });

    // Stats
    const scoredShows = shows.filter(s => s.score !== null);
    const avgScore = scoredShows.length > 0
      ? Math.round(scoredShows.reduce((sum, s) => sum + (s.score || 0), 0) / scoredShows.length)
      : null;

    let highScore: ActorProfile['highScore'] = null;
    let lowScore: ActorProfile['lowScore'] = null;
    if (scoredShows.length > 0) {
      const highest = scoredShows.reduce((best, s) => (s.score! > best.score!) ? s : best);
      const lowest = scoredShows.reduce((worst, s) => (s.score! < worst.score!) ? s : worst);
      highScore = { score: Math.round(highest.score!), showTitle: highest.title };
      lowScore = { score: Math.round(lowest.score!), showTitle: lowest.title };
    }

    // Slug with collision handling
    let slug = slugify(data.name);
    if (slugMap.has(slug)) {
      let counter = 2;
      while (slugMap.has(`${slug}-${counter}`)) counter++;
      slug = `${slug}-${counter}`;
    }

    const profile: ActorProfile = {
      name: data.name,
      slug,
      ibdbPersonId: data.ibdbPersonId,
      headshot: actorImages[data.ibdbPersonId]?.imageUrl || null,
      shows,
      showCount: shows.length,
      scoredShowCount: scoredShows.length,
      avgScore,
      highScore,
      lowScore,
      openShowCount: shows.filter(s => (s.status === 'open' || s.status === 'previews') && s.castType === 'current').length,
      closedShowCount: shows.filter(s => s.status === 'closed').length,
      hasBroadwayDebut,
    };

    profiles.push(profile);
    slugMap.set(slug, profile);
    idToSlug.set(data.ibdbPersonId, slug);
  }

  // Sort by show count descending
  profiles.sort((a, b) => b.showCount - a.showCount);
}

// ============================================
// Public API
// ============================================

export function getActorBySlug(slug: string): ActorProfile | undefined {
  ensureBuilt();
  return slugMap.get(slug);
}

export function getAllActorSlugs(): string[] {
  ensureBuilt();
  return Array.from(slugMap.keys());
}

export function getAllActorProfiles(): ActorProfile[] {
  ensureBuilt();
  return profiles;
}

/**
 * Get actor slug from ibdbPersonId — used by CastSection to build links
 */
export function getActorSlug(ibdbPersonId: string): string | null {
  ensureBuilt();
  return idToSlug.get(ibdbPersonId) || null;
}

/**
 * Build a slug map for a list of ibdbPersonIds — batch lookup for CastSection
 * Returns Map<ibdbPersonId, slug>
 */
export function getActorSlugMap(personIds: string[]): Map<string, string> {
  ensureBuilt();
  const result = new Map<string, string>();
  for (const id of personIds) {
    const slug = idToSlug.get(id);
    if (slug) result.set(id, slug);
  }
  return result;
}
