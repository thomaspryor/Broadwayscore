// Cast data module — exposes per-show cast files (opening night + replacements
// + current) used by /show/[slug] for JSON-LD schema and the CastSection UI.
//
// Source: data/cast-manifest.json (static-required, built in prebuild). NEVER
// re-introduce a dynamic fs.readdirSync('data/cast') here — next.config.js
// excludes data/cast/** from the Vercel NFT bundle, so a runtime read returns
// nothing and silently strips cast data from every /show/[slug] page once ISR
// regenerates them. The same bug took down every /cast/[slug] in May 2026;
// scripts/audit-nft-excluded-runtime-reads.js guards against the regression.

import type { ShowCastFile, CastMemberOBC } from './data-types';
import castManifest from '../../data/cast-manifest.json';

type CastManifestEntry = {
  showId: string;
  castType: 'obc' | 'replacement' | 'current';
  name: string;
  // Optional since 2026-05-24: West End / Off-Broadway cast members
  // without IBDB entries are included in the manifest and rendered by
  // CastSection.tsx without a /cast/[slug] link (italic + tooltip).
  ibdbPersonId?: string;
  role: string;
  flags?: string[];
};

let castCache: Map<string, ShowCastFile> | null = null;

function loadAllCastFiles(): Map<string, ShowCastFile> {
  if (castCache) return castCache;
  castCache = new Map();

  const entries = (castManifest as { entries: CastManifestEntry[] }).entries;
  for (const e of entries) {
    let file = castCache.get(e.showId);
    if (!file) {
      file = {
        showId: e.showId,
        scrapedAt: '',
        openingNightCast: [],
        currentCast: null,
        replacements: null,
      };
      castCache.set(e.showId, file);
    }
    const member: CastMemberOBC = {
      name: e.name,
      role: e.role,
      ...(e.ibdbPersonId ? { ibdbPersonId: e.ibdbPersonId } : {}),
      ...(e.flags ? { flags: e.flags } : {}),
    };
    if (e.castType === 'obc') {
      file.openingNightCast.push(member);
    } else if (e.castType === 'replacement') {
      (file.replacements ||= []).push(member);
    } else if (e.castType === 'current') {
      (file.currentCast ||= []).push(member);
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
