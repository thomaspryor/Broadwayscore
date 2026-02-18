// Cast data module — reads per-show cast files from data/cast/
// Each file: data/cast/{show-id}.json with openingNightCast + optional currentCast

import * as fs from 'fs';
import * as path from 'path';
import type { ShowCastFile, CastMemberOBC } from './data-types';

const CAST_DIR = path.join(process.cwd(), 'data', 'cast');

// Cache: showId → ShowCastFile
let castCache: Map<string, ShowCastFile> | null = null;

function loadAllCastFiles(): Map<string, ShowCastFile> {
  if (castCache) return castCache;
  castCache = new Map();

  if (!fs.existsSync(CAST_DIR)) return castCache;

  const files = fs.readdirSync(CAST_DIR).filter(f => f.endsWith('.json'));
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(CAST_DIR, file), 'utf-8');
      const data: ShowCastFile = JSON.parse(raw);
      if (data.showId) {
        castCache.set(data.showId, data);
      }
    } catch {
      // Skip malformed files
    }
  }

  return castCache;
}

/**
 * Get OBC cast for a show by ID
 */
export function getShowOBC(showId: string): CastMemberOBC[] | null {
  const cache = loadAllCastFiles();
  const data = cache.get(showId);
  if (!data || !data.openingNightCast || data.openingNightCast.length === 0) return null;
  return data.openingNightCast;
}

/**
 * Get current cast for a show by ID (open shows only)
 */
export function getShowCurrentCast(showId: string): { cast: CastMemberOBC[]; updatedAt: string | null } | null {
  const cache = loadAllCastFiles();
  const data = cache.get(showId);
  if (!data || !data.currentCast || data.currentCast.length === 0) return null;
  return {
    cast: data.currentCast,
    updatedAt: data.currentCastUpdatedAt || null,
  };
}

/**
 * Get full cast file for a show
 */
export function getShowCastFile(showId: string): ShowCastFile | null {
  const cache = loadAllCastFiles();
  return cache.get(showId) || null;
}

/**
 * Check if any cast data exists for a show
 */
export function hasShowCast(showId: string): boolean {
  const cache = loadAllCastFiles();
  return cache.has(showId);
}

/**
 * Get count of shows with cast data
 */
export function getCastDataStats(): { showsWithCast: number; totalCastMembers: number } {
  const cache = loadAllCastFiles();
  let totalCastMembers = 0;
  for (const data of Array.from(cache.values())) {
    totalCastMembers += data.openingNightCast?.length || 0;
  }
  return { showsWithCast: cache.size, totalCastMembers };
}
