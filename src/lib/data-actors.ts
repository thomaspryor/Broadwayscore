// Actor profile data module
// Builds profiles for Broadway actors from cast data files
// Import directly — NOT through data.ts barrel (bundle protection)

import * as fs from 'fs';
import * as path from 'path';
import type { ActorProfile, ActorShowEntry, ShowCastFile, CastMemberOBC } from './data-types';
import { getAllShows, slugify } from './data-core';
import { getAudienceBuzz } from './data-audience';

const CAST_DIR = path.join(process.cwd(), 'data', 'cast');
const ACTOR_IMAGES_FILE = path.join(process.cwd(), 'data', 'actor-images.json');

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
  const allShows = getAllShows();
  const showMap = new Map(allShows.map(s => [s.id, s]));

  // Accumulate: ibdbPersonId → { name, showEntries }
  const actorMap = new Map<string, {
    name: string;
    ibdbPersonId: string;
    showMap: Map<string, { entry: ActorShowEntry; flags: Set<string> }>;
  }>();

  // Read all cast files
  if (!fs.existsSync(CAST_DIR)) return;
  const files = fs.readdirSync(CAST_DIR).filter(f => f.endsWith('.json'));

  for (const file of files) {
    let castFile: ShowCastFile;
    try {
      castFile = JSON.parse(fs.readFileSync(path.join(CAST_DIR, file), 'utf-8'));
    } catch {
      continue;
    }

    const show = showMap.get(castFile.showId);
    if (!show) continue;

    const buzz = getAudienceBuzz(castFile.showId);

    const processCast = (members: CastMemberOBC[], castType: ActorShowEntry['castType']) => {
      for (const member of members) {
        if (!member.ibdbPersonId) continue;

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

        // Dedup per show — keep first entry (OBC takes priority for role/flags)
        if (!actor.showMap.has(castFile.showId)) {
          actor.showMap.set(castFile.showId, {
            entry: {
              title: show.title,
              slug: show.slug,
              showId: castFile.showId,
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
              wasObc: castType === 'obc',
            },
            flags: new Set(member.flags || []),
          });
        } else {
          const existing = actor.showMap.get(castFile.showId)!;
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
    };

    processCast(castFile.openingNightCast || [], 'obc');
    if (castFile.replacements) {
      processCast(castFile.replacements, 'replacement');
    }
    if (castFile.currentCast) {
      processCast(castFile.currentCast, 'current');
    }
  }

  // Load actor images map
  let actorImages: Record<string, { name: string; imageUrl: string; source: string }> = {};
  try {
    if (fs.existsSync(ACTOR_IMAGES_FILE)) {
      actorImages = JSON.parse(fs.readFileSync(ACTOR_IMAGES_FILE, 'utf-8'));
    }
  } catch { /* no images available */ }

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
