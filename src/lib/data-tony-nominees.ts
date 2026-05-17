/**
 * Data layer for the Tony Nominees comparison page (/tony-awards/nominees).
 * Returns all 26 nominated categories with show scores and win-probability odds
 * from GoldDerby (all 17 tracked categories) and Polymarket (6 major markets).
 */

import fs from 'fs';
import path from 'path';
import { getBroadwayShows } from '@/lib/data-core';
import {
  getEligibleShows,
  groupIntoCategories,
  serializeShow,
  type SerializedTonyShow,
  type TonyCategory,
  type TonySeasonWindow,
} from '@/lib/data-tony-predictions';
import { TONY_CATEGORY_ORDER } from '@/config/awards';
import gdRawData from '../../data/tony-win-probabilities.json';
import nominationsRawData from '../../data/tony-nominations.json';

// --- GoldDerby category name normalization ---

const GD_TO_TONY: Record<string, string> = {
  'Best Musical':                   'Best Musical',
  'Best Play':                      'Best Play',
  'Best Musical Revival':           'Best Revival of a Musical',
  'Best Play Revival':              'Best Revival of a Play',
  'Best Musical Book':              'Best Book of a Musical',
  'Best Original Score':            'Best Original Score',
  'Best Actor (Musical)':           'Best Actor in a Musical',
  'Best Actress (Musical)':         'Best Actress in a Musical',
  'Best Actor (Play)':              'Best Actor in a Play',
  'Best Actress (Play)':            'Best Actress in a Play',
  'Best Director (Musical)':        'Best Direction of a Musical',
  'Best Director (Play)':           'Best Direction of a Play',
  'Best Featured Actor (Musical)':  'Best Featured Actor in a Musical',
  'Best Featured Actress (Musical)':'Best Featured Actress in a Musical',
  'Best Featured Actor (Play)':     'Best Featured Actor in a Play',
  'Best Featured Actress (Play)':   'Best Featured Actress in a Play',
  'Best Choreography':              'Best Choreography',
};

const TONY_TO_GD: Record<string, string> = Object.fromEntries(
  Object.entries(GD_TO_TONY).map(([gd, tony]) => [tony, gd])
);

const MAJOR_CATEGORIES = new Set([
  'Best Musical',
  'Best Play',
  'Best Revival of a Musical',
  'Best Revival of a Play',
]);

// --- Types ---

type GdShowEntry = {
  title: string;
  categories: Record<string, { pWin: number; pNom: number; votes: number }>;
};

type GdData = { shows: Record<string, GdShowEntry> };

type PmCategoryData = { nominees: Record<string, number> };
type PmData = { categories: Record<string, PmCategoryData> };

type NominationEntry = {
  season: string;
  category: string;
  showId: string;
  name: string;
  won: boolean;
};

// --- Helpers ---

function toAwardsSeason(label: string): string {
  const parts = label.split('-');
  return `${parts[0]}-${parts[1].slice(2)}`;
}

function lookupGdOdds(gdData: GdData, showId: string, canonicalCatName: string): number | null {
  const gdCatName = TONY_TO_GD[canonicalCatName];
  if (!gdCatName) return null;
  const show = gdData.shows[showId];
  if (!show) return null;
  const cat = show.categories[gdCatName];
  if (!cat || cat.votes === 0) return null;
  return typeof cat.pWin === 'number' ? cat.pWin : null;
}

function loadPmData(): PmData | null {
  try {
    const pmPath = path.join(process.cwd(), 'data', 'tony-polymarket-odds.json');
    if (!fs.existsSync(pmPath)) return null;
    const raw = JSON.parse(fs.readFileSync(pmPath, 'utf-8')) as PmData;
    if (!raw?.categories || Object.keys(raw.categories).length === 0) return null;
    return raw;
  } catch {
    return null;
  }
}

function findPmOdds(nominees: Record<string, number>, name: string): number | null {
  if (name in nominees) return nominees[name];
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(nominees)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

// --- Main export ---

export function getNomineesByCategory(season: TonySeasonWindow): TonyCategory[] {
  const allShows = getBroadwayShows();
  const eligible = getEligibleShows(allShows, season);
  const gdData = gdRawData as unknown as GdData;
  const pmData = loadPmData();
  const awardsSeason = toAwardsSeason(season.label);

  const showById = new Map(eligible.map(s => [s.id, s]));

  // 4 major categories: delegate to groupIntoCategories (handles score blending)
  const majorCats = groupIntoCategories(eligible, { nomineesOnly: true, season }).map(cat => ({
    ...cat,
    shows: cat.shows.map(show => {
      const computedShow = eligible.find(s => s.slug === show.slug);
      const showId = computedShow?.id ?? '';
      const pmNominees = pmData?.categories[cat.title]?.nominees ?? null;
      return {
        ...show,
        gdOdds: lookupGdOdds(gdData, showId, cat.title),
        polymarketOdds: pmNominees ? findPmOdds(pmNominees, show.title) : null,
      };
    }),
  }));

  // 22 non-major categories: build from tony-nominations.json
  const nominations = (nominationsRawData as { nominations: NominationEntry[] })
    .nominations
    .filter(n => n.season === awardsSeason && !MAJOR_CATEGORIES.has(n.category));

  const nomsByCategory = new Map<string, NominationEntry[]>();
  for (const nom of nominations) {
    if (!nomsByCategory.has(nom.category)) nomsByCategory.set(nom.category, []);
    nomsByCategory.get(nom.category)!.push(nom);
  }

  const nonMajorCats: TonyCategory[] = [];
  for (const [catTitle, noms] of Array.from(nomsByCategory.entries())) {
    const shows: SerializedTonyShow[] = [];
    for (const nom of noms) {
      const computedShow = showById.get(nom.showId);
      if (!computedShow) continue;

      const serialized = serializeShow(computedShow);
      const personName = nom.name !== '(show-level)' ? nom.name : null;
      const pmNominees = pmData?.categories[catTitle]?.nominees ?? null;
      const pmMatchName = personName ?? computedShow.title;

      shows.push({
        ...serialized,
        gdOdds: lookupGdOdds(gdData, nom.showId, catTitle),
        polymarketOdds: pmNominees ? findPmOdds(pmNominees, pmMatchName) : null,
        nomineePersonName: personName,
        nomineeCategoryTitle: catTitle,
      });
    }

    shows.sort((a, b) => {
      const diff = (b.gdOdds ?? -1) - (a.gdOdds ?? -1);
      return diff !== 0 ? diff : a.title.localeCompare(b.title);
    });

    nonMajorCats.push({
      key: catTitle.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''),
      title: catTitle,
      description: '',
      shows,
      upcoming: [],
    });
  }

  const all = [...majorCats, ...nonMajorCats];
  all.sort((a, b) => {
    const ai = TONY_CATEGORY_ORDER.indexOf(a.title);
    const bi = TONY_CATEGORY_ORDER.indexOf(b.title);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
  return all;
}
