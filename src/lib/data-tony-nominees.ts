/**
 * Data layer for the Tony Nominees comparison page (/tony-awards/nominees).
 * Returns all 26 nominated categories with show scores and win-probability odds
 * from GoldDerby (all 26 categories), Kalshi (25 categories), and Polymarket (3 categories:
 * Best Musical, Best Play, Best Book of a Musical).
 */

import { getBroadwayShows } from '@/lib/data-core';
import {
  getEligibleShows,
  groupIntoCategories,
  serializeShow,
  lookupCriticPicks,
  lookupShouldPicks,
  getPrecursorWins,
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
// Static imports — keep NFT bundling deterministic. Replaces previous dynamic
// process.cwd() reads that pulled all of data/cast/ (~2400 files) into the
// serverless function bundle and tripped Vercel's 300MB limit.
// See memory/feedback_vercel_nft_dynamic_paths.md.
import polymarketOddsRaw from '../../data/tony-polymarket-odds.json';
import kalshiOddsRaw from '../../data/tony-kalshi-odds.json';
import actorSlugsManifest from '../../data/actor-slugs.json';

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
  'Best Orchestrations':            'Best Orchestrations',
  'Scenic Design (Musical)':        'Best Scenic Design of a Musical',
  'Scenic Design (Play)':           'Best Scenic Design of a Play',
  'Costume Design (Musical)':       'Best Costume Design of a Musical',
  'Costume Design (Play)':          'Best Costume Design of a Play',
  'Lighting Design (Musical)':      'Best Lighting Design of a Musical',
  'Lighting Design (Play)':         'Best Lighting Design of a Play',
  'Sound Design (Musical)':         'Best Sound Design of a Musical',
  'Sound Design (Play)':            'Best Sound Design of a Play',
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
  categories: Record<string, { pWin: number; pNom: number; votes: number; prevDayPWin?: number }>;
};

type GdPersonEntry = Record<string, { pWin: number; votes: number }>;

type GdData = {
  shows: Record<string, GdShowEntry>;
  persons?: Record<string, GdPersonEntry>;
};

type PmCategoryData = { nominees: Record<string, number>; prevNominees?: Record<string, number> };
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

/**
 * Pre-compute per-GD-category pWin totals. When a category's total < 0.5
 * (sparse market — most votes went to nominees outside our dataset), we
 * normalize within our known nominees so relative rankings still render.
 */
function buildGdNormMap(gdData: GdData): Map<string, number> {
  const totals = new Map<string, number>();
  for (const show of Object.values(gdData.shows)) {
    for (const [cat, entry] of Object.entries(show.categories)) {
      if (entry.votes > 0 && typeof entry.pWin === 'number') {
        totals.set(cat, (totals.get(cat) ?? 0) + entry.pWin);
      }
    }
  }
  return totals;
}

function lookupGdOdds(
  gdData: GdData,
  normMap: Map<string, number>,
  showId: string,
  canonicalCatName: string,
  personName?: string | null,
): number | null {
  const gdCatName = TONY_TO_GD[canonicalCatName];
  if (!gdCatName) return null;

  // For acting categories, use per-person odds — avoids show-level max-pWin
  // conflation when two performers from the same show are in the same category.
  if (personName && gdData.persons) {
    const personEntry = gdData.persons[personName];
    if (personEntry?.[gdCatName]) {
      const p = personEntry[gdCatName];
      if (p.votes > 0 && typeof p.pWin === 'number') return p.pWin;
    }
  }

  // Fallback to show-keyed lookup (non-acting categories, or person not found)
  const show = gdData.shows[showId];
  if (!show) return null;
  const cat = show.categories[gdCatName];
  if (!cat || cat.votes === 0 || typeof cat.pWin !== 'number') return null;
  const total = normMap.get(gdCatName) ?? 1;
  // Hide GD odds when total coverage < 0.5 — sparse data produces misleading
  // normalized values (acting categories: GD tracks per-person but show-level
  // index is incomplete, so most votes are missing).
  if (total < 0.5) return null;
  return cat.pWin;
}

function lookupGdOddsChange(
  gdData: GdData,
  showId: string,
  canonicalCatName: string,
  personName?: string | null,
): number | null {
  const gdCatName = TONY_TO_GD[canonicalCatName];
  if (!gdCatName) return null;
  // Person-level: GD doesn't store prevDayPWin per-person, only per-show category
  const show = gdData.shows[showId];
  if (!show) return null;
  const cat = show.categories[gdCatName];
  if (!cat || typeof cat.pWin !== 'number' || typeof cat.prevDayPWin !== 'number') return null;
  return cat.pWin - cat.prevDayPWin;
}

function asMarketData(raw: unknown): PmData | null {
  const data = raw as PmData | undefined;
  if (!data?.categories || Object.keys(data.categories).length === 0) return null;
  return data;
}

const POLYMARKET_DATA = asMarketData(polymarketOddsRaw);
const KALSHI_DATA = asMarketData(kalshiOddsRaw);

function loadMarketData(filename: string): PmData | null {
  if (filename === 'tony-polymarket-odds.json') return POLYMARKET_DATA;
  if (filename === 'tony-kalshi-odds.json') return KALSHI_DATA;
  return null;
}

// Normalize for odds matching — mirrors normalizeTitle() in scripts/lib/title-normalization.js:
// strips accents (NFD), apostrophes, commas, converts & → "and", collapses whitespace.
// Used to handle: Titaníque↔Titanique (accent), Arthur Miller's↔bare title (apostrophe),
// "The Lost Boys" leading-the strip, etc.
function normTitle(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/&/g, 'and')
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9\s]/g, '') // strip apostrophes, commas, punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

// Sort-normalized name tokens for order-insensitive matching of multi-person credit lists.
// e.g. "Marla Mindelle, Constantine Rousouli and Tye Blue" ↔ "Marla Mindelle & Constantine Rousouli & Tye Blue"
// Also handles different ordering: "Ethan Popp, Kyler England, ... Gabriel Mann" ↔ "Ethan Popp & ... & Kyler England"
function normForNameList(s: string): string {
  return normTitle(s).split(' ').filter(t => t !== 'and').sort().join(' ');
}

function findMarketOdds(nominees: Record<string, number>, name: string): number | null {
  if (name in nominees) return nominees[name];
  const normName = normTitle(name);
  const nameListNorm = normForNameList(name);
  const nameTokens = new Set(nameListNorm.split(' '));
  for (const [k, v] of Object.entries(nominees)) {
    const normK = normTitle(k);
    // Exact normalized match (handles accents: Titaníque ↔ Titanique)
    if (normK === normName) return v;
    // Playwright-prefix suffix match: "Arthur Miller's Death of a Salesman" ends with "death of a salesman"
    if (normK.endsWith(' ' + normName)) return v;
    // Name-separator-insensitive + order-insensitive match (sorted tokens, commas/&/and equivalent)
    if (normForNameList(k) === nameListNorm) return v;
    // Shared-credit subset match: "Zhailon Levingston" matches "Zhailon Levingston and Bill Rauch"
    // (co-credited collaborators share the same market entry)
    const keyTokens = new Set(normForNameList(k).split(' '));
    if (nameTokens.size >= 2 && Array.from(nameTokens).every(t => keyTokens.has(t))) return v;
  }
  return null;
}

/** Returns current − prev odds for a market nominee; null if prev data absent. */
function findMarketOddsChange(catData: PmCategoryData | undefined, name: string): number | null {
  if (!catData?.prevNominees || !catData?.nominees) return null;
  const current = findMarketOdds(catData.nominees, name);
  const prev = findMarketOdds(catData.prevNominees, name);
  if (current == null || prev == null) return null;
  return current - prev;
}

// Build-time manifest mapping `${showId}:${normalizedName}` → ibdbPersonId,
// generated by scripts/build-actor-slugs-manifest.js (runs in prebuild).
// Replaces a per-request fs.readFileSync of data/cast/${showId}.json.
const ACTOR_SLUG_ENTRIES = (actorSlugsManifest as { entries?: Record<string, string> }).entries ?? {};

/** Finds the /cast/[slug] slug for an actor by name within a show's cast. */
function findActorSlug(showId: string, personName: string): string | null {
  const key = `${showId}:${personName.toLowerCase().trim()}`;
  const ibdbPersonId = ACTOR_SLUG_ENTRIES[key];
  if (!ibdbPersonId) return null;
  return getActorSlug(ibdbPersonId) ?? null;
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

/**
 * Most recent `_meta.lastUpdated` across the three odds sources (GD / Kalshi /
 * Polymarket). Returns an ISO string, or null if no meta is present. Used by
 * the Predictions page to surface scrape freshness next to "Updated frequently".
 */
export function getOddsLastUpdated(): string | null {
  const metas = [
    (gdRawData as { _meta?: { lastUpdated?: string } })._meta?.lastUpdated,
    (kalshiOddsRaw as { _meta?: { lastUpdated?: string } })._meta?.lastUpdated,
    (polymarketOddsRaw as { _meta?: { lastUpdated?: string } })._meta?.lastUpdated,
  ].filter((s): s is string => typeof s === 'string' && s.length > 0);
  if (metas.length === 0) return null;
  return metas.sort().pop() || null;
}

/**
 * Enrich the 4 major categories (Best Musical/Play/Revival) with prediction-market
 * odds, precursor wins, and press picks. Used by both the Nominations Center
 * (which then sorts by GD odds) and the Tony Predictions table (which keeps
 * the blended-score ranking).
 */
export function enrichMajorCategoriesWithOdds(
  majorCats: TonyCategory[],
  season: TonySeasonWindow,
): TonyCategory[] {
  const allShows = getBroadwayShows();
  const eligible = getEligibleShows(allShows, season);
  const gdRaw = gdRawData as unknown as GdData;
  const gdData: GdData = gdRaw.persons
    ? { ...gdRaw, persons: Object.fromEntries(Object.entries(gdRaw.persons).map(([k, v]) => [k.trim(), v])) }
    : gdRaw;
  const pmData = loadMarketData('tony-polymarket-odds.json');
  const kalshiData = loadMarketData('tony-kalshi-odds.json');
  const gdNormMap = buildGdNormMap(gdData);

  return majorCats.map(cat => {
    const shows = cat.shows.map(show => {
      const computedShow = eligible.find(s => s.slug === show.slug);
      const showId = computedShow?.id ?? '';
      const pmCatData = pmData?.categories[cat.title];
      const kalshiCatData = kalshiData?.categories[cat.title];
      const pmNominees = pmCatData?.nominees ?? null;
      const kalshiNominees = kalshiCatData?.nominees ?? null;
      return {
        ...show,
        awardsScore: showId ? computeSiteAwardScore(showId).displayScore : show.awardsScore,
        gdOdds: lookupGdOdds(gdData, gdNormMap, showId, cat.title),
        gdOddsChange: showId ? lookupGdOddsChange(gdData, showId, cat.title) : null,
        polymarketOdds: pmNominees ? findMarketOdds(pmNominees, show.title) : null,
        polymarketOddsChange: findMarketOddsChange(pmCatData, show.title),
        kalshiOdds: kalshiNominees ? findMarketOdds(kalshiNominees, show.title) : null,
        kalshiOddsChange: findMarketOddsChange(kalshiCatData, show.title),
        criticPicks: showId ? lookupCriticPicks(showId, null, cat.title) : [],
        shouldPicks: showId ? lookupShouldPicks(showId, null, cat.title) : [],
        precursorWins: showId ? getPrecursorWins(showId, cat.title) : [],
      };
    });
    return { ...cat, shows };
  });
}

export function getNomineesByCategory(season: TonySeasonWindow): TonyCategory[] {
  const allShows = getBroadwayShows();
  const eligible = getEligibleShows(allShows, season);
  const gdRaw = gdRawData as unknown as GdData;
  // GD persons keys have trailing spaces ("Nathan Lane ") — normalize to trimmed keys.
  const gdData: GdData = gdRaw.persons
    ? { ...gdRaw, persons: Object.fromEntries(Object.entries(gdRaw.persons).map(([k, v]) => [k.trim(), v])) }
    : gdRaw;
  const pmData = loadMarketData('tony-polymarket-odds.json');
  const awardsSeason = toAwardsSeason(season.label);

  const showById = new Map(eligible.map(s => [s.id, s]));
  const kalshiData = loadMarketData('tony-kalshi-odds.json');
  const gdNormMap = buildGdNormMap(gdData);

  // 4 major categories: delegate to groupIntoCategories (handles score blending)
  // then enrich with odds/precursor/picks and sort by GD odds (nominees-page convention).
  const enrichedMajor = enrichMajorCategoriesWithOdds(
    groupIntoCategories(eligible, { nomineesOnly: true, season }),
    season,
  );
  const majorCats = enrichedMajor.map(cat => {
    const showsWithOdds = [...cat.shows];
    showsWithOdds.sort((a, b) => ((b.gdOdds ?? -1) - (a.gdOdds ?? -1)));
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
    const pmCatData = pmData?.categories[catTitle];
    const kalshiCatData = kalshiData?.categories[catTitle];
    const pmNominees = pmCatData?.nominees ?? null;
    const kalshiNominees = kalshiCatData?.nominees ?? null;

    if (isPersonLevel) {
      // Precursor chips are stored at show level — suppress when multiple nominees from same
      // show compete in the same acting category (can't know which person actually won).
      const showNomineeCount = new Map<string, number>();
      for (const nom of noms) showNomineeCount.set(nom.showId, (showNomineeCount.get(nom.showId) ?? 0) + 1);

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
          gdOdds: lookupGdOdds(gdData, gdNormMap, nom.showId, catTitle, personName),
          gdOddsChange: lookupGdOddsChange(gdData, nom.showId, catTitle),
          polymarketOdds: pmNominees ? findMarketOdds(pmNominees, pmMatchName) : null,
          polymarketOddsChange: findMarketOddsChange(pmCatData, pmMatchName),
          kalshiOdds: kalshiNominees ? findMarketOdds(kalshiNominees, pmMatchName) : null,
          kalshiOddsChange: findMarketOddsChange(kalshiCatData, pmMatchName),
          nomineePersonName: personName,
          nomineeCategoryTitle: catTitle,
          nomineeActorSlug: actorSlug,
          nomineePriorNominations: pastStats?.priorNominations ?? 0,
          nomineePriorWins: pastStats?.priorWins ?? 0,
          criticPicks: lookupCriticPicks(nom.showId, personName, catTitle),
          shouldPicks: lookupShouldPicks(nom.showId, personName, catTitle),
          precursorWins: getPrecursorWins(nom.showId, catTitle, personName),
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
        // Kalshi craft nominees are listed by designer name, not show title — try both
        const kalshiCraftKey = names[0] ?? null;

        const craftPmKey = pmNominees
          ? (findMarketOdds(pmNominees, computedShow.title) != null ? computedShow.title : (personName ?? computedShow.title))
          : computedShow.title;
        const craftKalshiKey = kalshiNominees
          ? (findMarketOdds(kalshiNominees, computedShow.title) != null ? computedShow.title
            : (personName && findMarketOdds(kalshiNominees, personName) != null ? personName
            : (kalshiCraftKey ?? computedShow.title)))
          : computedShow.title;

        shows.push({
          ...serializeShow(computedShow),
          awardsScore: computeSiteAwardScore(showId).displayScore,
          gdOdds: lookupGdOdds(gdData, gdNormMap, showId, catTitle),
          gdOddsChange: lookupGdOddsChange(gdData, showId, catTitle),
          polymarketOdds: pmNominees
            ? (findMarketOdds(pmNominees, computedShow.title)
               ?? (personName ? findMarketOdds(pmNominees, personName) : null))
            : null,
          polymarketOddsChange: findMarketOddsChange(pmCatData, craftPmKey),
          kalshiOdds: kalshiNominees
            ? (findMarketOdds(kalshiNominees, computedShow.title)
               ?? (personName ? findMarketOdds(kalshiNominees, personName) : null)
               ?? (kalshiCraftKey ? findMarketOdds(kalshiNominees, kalshiCraftKey) : null))
            : null,
          kalshiOddsChange: findMarketOddsChange(kalshiCatData, craftKalshiKey),
          nomineePersonName: personName,
          nomineeCategoryTitle: catTitle,
          criticPicks: lookupCriticPicks(showId, null, catTitle),
          shouldPicks: lookupShouldPicks(showId, null, catTitle),
          precursorWins: getPrecursorWins(showId, catTitle),
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
