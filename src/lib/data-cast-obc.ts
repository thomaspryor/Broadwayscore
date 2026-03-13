// Cast data module — reads per-show cast files from data/cast/
// Each file: data/cast/{show-id}.json with openingNightCast + optional currentCast

import * as fs from 'fs';
import * as path from 'path';
import type { ShowCastFile } from './data-types';

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
 * Get full cast file for a show
 */
export function getShowCastFile(showId: string): ShowCastFile | null {
  const cache = loadAllCastFiles();
  return cache.get(showId) || null;
}

