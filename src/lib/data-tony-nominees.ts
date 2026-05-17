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
import { computeSiteAwardScore } from '@/lib/awards-scoring';
import { getActorSlug } from '@/lib/data-actors';
import { getPersonTonyStatsByName } from '@/lib/data-tony-noms';
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

// These categories nominate individuals — show one row per person.
// Direction is excluded: one show wins, co-directors share the same GD odds,
// so they're grouped by show (like craft categories).
const PERSON_LEVEL_CATEGORIES = new Set([
  'Best Actor in a Musical',
  'Best Actress in a Musical',
  'Best Actor in a Play',
  'Best Actress in a Play',
  'Best Featured Actor in a Musical',
  'Best Featured Actress in a Musical',
  'Best Featured Actor in a Play',
  'Best Featured Actress in a Play',
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

type CastMember = { name: string; role?: string; ibdbPersonId?: string };

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

function loadMarketData(filename: string): PmData | null {
  try {
    const p = path.join(process.cwd(), 'data', filename);
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as PmData;
    if (!raw?.categories || Object.keys(raw.categories).length === 0) return null;
    return raw;
  } catch {
    return null;
  }
}

function findMarketOdds(nominees: Record<string, number>, name: string): number | null {
  if (name in nominees) return nominees[name];
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(nominees)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

/** Average PM + Kalshi odds when both available, use whichever exists otherwise. */
function averageMarketOdds(
  pmNominees: Record<string, number> | null,
  kalshiNominees: Record<string, number> | null,
  name: string,
): number | null {
  const pm = pmNominees ? findMarketOdds(pmNominees, name) : null;
  const k  = kalshiNominees ? findMarketOdds(kalshiNominees, name) : null;
  if (pm !== null && k !== null) return (pm + k) / 2;
  return pm ?? k;
}

/** Finds the /cast/[slug] slug for an actor by matching their name in the show's cast file. */
function findActorSlug(showId: string, personName: string): string | null {
  try {
    const castPath = path.join(process.cwd(), 'data', 'cast', `${showId}.json`);
    if (!fs.existsSync(castPath)) return null;
    const castFile = JSON.parse(fs.readFileSync(castPath, 'utf-8'));
    const cast: CastMember[] = castFile.openingNightCast ?? castFile.currentCast ?? [];
    const normalizedTarget = personName.toLowerCase().trim();
    const member = cast.find(m => m.name.toLowerCase().trim() === normalizedTarget);
    if (!member?.ibdbPersonId) return null;
    return getActorSlug(member.ibdbPersonId) ?? null;
  } catch {
    return null;
  }
}

/** Tony nominations/wins before the given season (excludes current season). */
function getPersonPastStats(name: string, currentAwardsSeason: string): { priorNominations: number; priorWins: number } {
  const stats = getPersonTonyStatsByName(name);
  if (!stats) return { priorNominations: 0, priorWins: 0 };
  const prior = stats.entries.filter((e: NominationEntry) => e.season !== currentAwardsSeason);
  return {
    priorNominations: prior.length,
    priorWins: prior.filter((e: NominationEntry) => e.won).length,
  };
}

// --- Main export ---

export function getNomineesByCategory(season: TonySeasonWindow): TonyCategory[] {
  const allShows = getBroadwayShows();
  const eligible = getEligibleShows(allShows, season);
  const gdData = gdRawData as unknown as GdData;
  const pmData = loadMarketData('tony-polymarket-odds.json');
  const awardsSeason = toAwardsSeason(season.label);

  const showById = new Map(eligible.map(s => [s.id, s]));
  const kalshiData = loadMarketData('tony-kalshi-odds.json');

  // 4 major categories: delegate to groupIntoCategories (handles score blending)
  const majorCats = groupIntoCategories(eligible, { nomineesOnly: true, season }).map(cat => {
    const showsWithOdds = cat.shows.map(show => {
      const computedShow = eligible.find(s => s.slug === show.slug);
      const showId = computedShow?.id ?? '';
      const pmNominees = pmData?.categories[cat.title]?.nominees ?? null;
      const kalshiNominees = kalshiData?.categories[cat.title]?.nominees ?? null;
      return {
        ...show,
        awardsScore: showId ? computeSiteAwardScore(showId).displayScore : 0,
        gdOdds: lookupGdOdds(gdData, showId, cat.title),
        polymarketOdds: averageMarketOdds(pmNominees, kalshiNominees, show.title),
      };
    });
    showsWithOdds.sort((a, b) => (b.gdOdds ?? -1) - (a.gdOdds ?? -1));
    return { ...cat, shows: showsWithOdds };
  });

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
    const isPersonLevel = PERSON_LEVEL_CATEGORIES.has(catTitle);
    const pmNominees = pmData?.categories[catTitle]?.nominees ?? null;

    if (isPersonLevel) {
      // One row per nominated individual
      for (const nom of noms) {
        const computedShow = showById.get(nom.showId);
        if (!computedShow) continue;

        const personName = nom.name !== '(show-level)' ? nom.name : null;
        const actorSlug = personName ? findActorSlug(nom.showId, personName) : null;
        const pastStats = personName ? getPersonPastStats(personName, awardsSeason) : null;
        const pmMatchName = personName ?? computedShow.title;

        shows.push({
          ...serializeShow(computedShow),
          awardsScore: computeSiteAwardScore(nom.showId).displayScore,
          gdOdds: lookupGdOdds(gdData, nom.showId, catTitle),
          polymarketOdds: pmNominees ? findMarketOdds(pmNominees, pmMatchName) : null,
          nomineePersonName: personName,
          nomineeCategoryTitle: catTitle,
          nomineeActorSlug: actorSlug,
          nomineePriorNominations: pastStats?.priorNominations ?? 0,
          nomineePriorWins: pastStats?.priorWins ?? 0,
        });
      }
    } else {
      // Group by show — one row per show, combining all credited collaborators
      const showGroups = new Map<string, NominationEntry[]>();
      for (const nom of noms) {
        if (!showGroups.has(nom.showId)) showGroups.set(nom.showId, []);
        showGroups.get(nom.showId)!.push(nom);
      }

      for (const [showId, showNoms] of Array.from(showGroups.entries())) {
        const computedShow = showById.get(showId);
        if (!computedShow) continue;

        const names = showNoms.map(n => n.name).filter(n => n !== '(show-level)');
        const personName = names.length > 0 ? names.join(' & ') : null;

        shows.push({
          ...serializeShow(computedShow),
          awardsScore: computeSiteAwardScore(showId).displayScore,
          gdOdds: lookupGdOdds(gdData, showId, catTitle),
          polymarketOdds: pmNominees ? findMarketOdds(pmNominees, computedShow.title) : null,
          nomineePersonName: personName,
          nomineeCategoryTitle: catTitle,
        });
      }
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
