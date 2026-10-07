// Guide pages data loading module
// Provides filtered/sorted show lists, template metadata, editorial content, and critic consensus

import fs from 'fs';
import path from 'path';
import { ComputedShow } from './engine';
import { getBroadwayShows } from './data-core';
import { stripInlineMarkdown } from './formatting';
import { getShowGrosses } from './data-grosses';
import {
  GuidePageConfig,
  getGuideConfig,
  parseGuideSlug,
  interpolateTemplate,
} from '@/config/guide-pages';

// --- Critic Consensus ---

interface ConsensusData {
  shows: Record<string, { text: string; lastUpdated: string; reviewCount: number }>;
}

let consensusCache: ConsensusData | null = null;

function loadConsensus(): ConsensusData {
  if (consensusCache) return consensusCache;
  try {
    const filePath = path.join(process.cwd(), 'data', 'critic-consensus.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    consensusCache = data;
    return data;
  } catch {
    return { shows: {} };
  }
}

export function getCriticConsensus(showId: string): string | null {
  const data = loadConsensus();
  return stripInlineMarkdown(data.shows[showId]?.text) || null;
}

// --- Guide Editorials ---

interface EditorialEntry {
  intro: string;
  monthYear?: string;
  year?: number;
  lastUpdated: string;
  showCount: number;
}

interface EditorialsData {
  _meta?: { lastGenerated: string; updatePolicy: string };
  guides: Record<string, EditorialEntry>;
}

let editorialsCache: EditorialsData | null = null;

function loadEditorials(): EditorialsData {
  if (editorialsCache) return editorialsCache;
  try {
    const filePath = path.join(process.cwd(), 'data', 'guide-editorials.json');
    if (!fs.existsSync(filePath)) return { guides: {} };
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    editorialsCache = data;
    return data;
  } catch {
    return { guides: {} };
  }
}

export function getGuideEditorial(slug: string, actualShowCount?: number): EditorialEntry | null {
  const data = loadEditorials();
  const entry = data.guides[slug] || null;
  if (!entry) return null;

  // If the editorial references a show count that's way off from reality, it's stale.
  // Stale editorials mention specific shows that no longer match — misleading for users and SEO.
  if (actualShowCount !== undefined && entry.showCount > 0) {
    const drift = Math.abs(entry.showCount - actualShowCount) / Math.max(entry.showCount, actualShowCount);
    if (actualShowCount === 0 || drift > 0.65) return null;
  }

  return entry;
}

// --- Date/Season Helpers ---

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function getCurrentMonthYear(): string {
  const now = new Date();
  return `${MONTH_NAMES[now.getMonth()]} ${now.getFullYear()}`;
}

function getCurrentSeason(): string {
  const now = new Date();
  const year = now.getFullYear();
  // Broadway season starts September 1
  if (now.getMonth() >= 8) {
    return `${year}-${year + 1}`;
  }
  return `${year - 1}-${year}`;
}

// --- Guide List ---

export interface GuideList {
  config: GuidePageConfig;
  shows: ComputedShow[];
  metadata: {
    monthYear: string;
    year: number;
    season: string;
    count: number;
    topShow: string;
  };
}

export function getGuideList(slug: string): GuideList | null {
  const config = getGuideConfig(slug);
  if (!config) return null;

  const { year } = parseGuideSlug(slug);
  const allShows = getBroadwayShows();

  // Filter
  let filtered = allShows.filter(show => config.filter(show));

  // Sort
  if (config.sort === 'score') {
    filtered.sort((a, b) => (b.criticScore?.score ?? 0) - (a.criticScore?.score ?? 0));
  } else if (config.sort === 'opening-date') {
    filtered.sort((a, b) => {
      if (!a.openingDate && !b.openingDate) return 0;
      if (!a.openingDate) return 1;
      if (!b.openingDate) return -1;
      return new Date(b.openingDate).getTime() - new Date(a.openingDate).getTime();
    });
  } else if (config.sort === 'closing-date') {
    filtered.sort((a, b) => {
      if (!a.closingDate) return 1;
      if (!b.closingDate) return -1;
      return new Date(a.closingDate).getTime() - new Date(b.closingDate).getTime();
    });
  }

  // Apply limit
  if (config.limit) {
    filtered = filtered.slice(0, config.limit);
  }

  const metadata = {
    monthYear: getCurrentMonthYear(),
    year: year || new Date().getFullYear(),
    season: getCurrentSeason(),
    count: filtered.length,
    topShow: filtered[0]?.title || '',
  };

  return { config, shows: filtered, metadata };
}

// Build template variables from metadata
export function buildTemplateVars(metadata: GuideList['metadata']): Record<string, string | number> {
  return {
    monthYear: metadata.monthYear,
    year: metadata.year,
    season: metadata.season,
    count: metadata.count,
    topShow: metadata.topShow,
  };
}
