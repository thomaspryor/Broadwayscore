import { Metadata } from 'next';
import { getBroadwayShows } from '@/lib/data-core';
import {
  getTonySeasonWindowFor,
  getEligibleShows,
  groupIntoCategories,
  type SerializedTonyShow,
  type TonyCategory,
} from '@/lib/data-tony-predictions';
import { BeatTheCriticsClient } from './BeatTheCriticsClient';
import { BASE_URL } from '@/lib/seo';

export const metadata: Metadata = {
  title: 'Beat the Critics | Tony Award Picks | Broadway Scorecard',
  description: 'Make your Tony Award picks and see how you stack up against top critics and the CriticScore algorithm. Ceremony: June 7, 2026.',
  alternates: {
    canonical: `${BASE_URL}/beat-the-critics`,
  },
  openGraph: {
    title: 'Beat the Critics — Tony Award Picks',
    description: 'Pick the Tony Award winners and see how your predictions compare to top critics and the CriticScore algorithm.',
    url: `${BASE_URL}/beat-the-critics`,
    type: 'website',
    images: [{ url: `${BASE_URL}/og/beat-the-critics.png`, width: 1200, height: 630, alt: 'Beat the Critics — Tony Award Picks' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Beat the Critics — Tony Award Picks',
    description: 'Pick the Tony Award winners and compare your predictions to top critics and the CriticScore algorithm.',
  },
};

export interface ActorNominee {
  name: string;
  showTitle: string;
  showSlug: string;
  thumbnailPath: string | null;
  showScore: number | null;
}

export interface BeatTheCriticsCategoryData {
  title: string;
  nominees: SerializedTonyShow[];
  actorNominees?: ActorNominee[];
  isActorCategory?: boolean;
}

export interface BeatTheCriticsData {
  tiers: {
    key: string;
    label: string;
    name: string;
    categories: BeatTheCriticsCategoryData[];
  }[];
  season: { label: string; ceremonyYear: number };
  stats: { reviewsScored: number; showsTracked: number; criticsTracked: number };
}

// Official 2026 Tony nominees — show slugs (without year suffix)
const CURATED_SHOW_NOMINEES: Record<string, string[]> = {
  'Best Musical': [
    'two-strangers',
    'schmigadoon',
    'the-lost-boys',
    'titanique',
  ],
  'Best Play': [
    'liberation',
    'giant',
    'the-balusters',
    'little-bear-ridge-road',
  ],
  'Best Revival of a Musical': [
    'ragtime',
    'the-rocky-horror-show',
    'cats-the-jellicle-ball',
  ],
  'Best Revival of a Play': [
    'oedipus',
    'every-brilliant-thing',
    'death-of-a-salesman',
    'becky-shaw',
    'fallen-angels',
  ],
};

// Official 2026 Tony nominees — lead acting categories
const LEAD_ACTOR_NOMINEES: Record<string, { name: string; showTitle: string; showSlug: string }[]> = {
  'Best Actor in a Musical': [
    { name: 'Sam Tutty', showTitle: 'Two Strangers (Carry a Cake Across New York)', showSlug: 'two-strangers-bway-2025' },
    { name: 'Joshua Henry', showTitle: 'Ragtime', showSlug: 'ragtime-2025' },
    { name: 'Brandon Uranowitz', showTitle: 'Ragtime', showSlug: 'ragtime-2025' },
    { name: 'Nicholas Christopher', showTitle: 'Chess', showSlug: 'chess-2025' },
    { name: 'Luke Evans', showTitle: 'The Rocky Horror Show', showSlug: 'the-rocky-horror-show-2026' },
  ],
  'Best Actress in a Musical': [
    { name: 'Christiani Pitts', showTitle: 'Two Strangers (Carry a Cake Across New York)', showSlug: 'two-strangers-bway-2025' },
    { name: 'Caissie Levy', showTitle: 'Ragtime', showSlug: 'ragtime-2025' },
    { name: 'Sara Chase', showTitle: 'Schmigadoon!', showSlug: 'schmigadoon-2026' },
    { name: 'Stephanie Hsu', showTitle: 'The Rocky Horror Show', showSlug: 'the-rocky-horror-show-2026' },
    { name: 'Marla Mindelle', showTitle: 'Titanique', showSlug: 'titanique-2026' },
  ],
  'Best Actor in a Play': [
    { name: 'Mark Strong', showTitle: 'Oedipus', showSlug: 'oedipus-2025' },
    { name: 'Daniel Radcliffe', showTitle: 'Every Brilliant Thing', showSlug: 'every-brilliant-thing-2026' },
    { name: 'Nathan Lane', showTitle: 'Death of a Salesman', showSlug: 'death-of-a-salesman-2026' },
    { name: 'John Lithgow', showTitle: 'Giant', showSlug: 'giant-2026' },
    { name: 'Will Harrison', showTitle: 'Punch', showSlug: 'punch-2025' },
  ],
  'Best Actress in a Play': [
    { name: 'Susannah Flood', showTitle: 'Liberation', showSlug: 'liberation-2025' },
    { name: 'Lesley Manville', showTitle: 'Oedipus', showSlug: 'oedipus-2025' },
    { name: 'Carrie Coon', showTitle: 'Bug', showSlug: 'bug-2026' },
    { name: 'Rose Byrne', showTitle: 'Fallen Angels', showSlug: 'fallen-angels-2026' },
    { name: 'Kelli O\'Hara', showTitle: 'Fallen Angels', showSlug: 'fallen-angels-2026' },
  ],
};

// Official 2026 Tony nominees — featured acting categories
const FEATURED_ACTOR_NOMINEES: Record<string, { name: string; showTitle: string; showSlug: string }[]> = {
  'Best Featured Actor in a Musical': [
    { name: 'Ben Levi Ross', showTitle: 'Ragtime', showSlug: 'ragtime-2025' },
    { name: 'Bryce Pinkham', showTitle: 'Chess', showSlug: 'chess-2025' },
    { name: 'Ali Louis Bourzgui', showTitle: 'The Lost Boys', showSlug: 'the-lost-boys-2026' },
    { name: 'Layton Williams', showTitle: 'Titanique', showSlug: 'titanique-2026' },
    { name: 'André De Shields', showTitle: "Cats: The Jellicle Ball", showSlug: 'cats-the-jellicle-ball-2026' },
  ],
  'Best Featured Actress in a Musical': [
    { name: 'Nichelle Lewis', showTitle: 'Ragtime', showSlug: 'ragtime-2025' },
    { name: 'Hannah Cruz', showTitle: 'Chess', showSlug: 'chess-2025' },
    { name: 'Ana Gasteyer', showTitle: 'Schmigadoon!', showSlug: 'schmigadoon-2026' },
    { name: 'Rachel Dratch', showTitle: 'The Rocky Horror Show', showSlug: 'the-rocky-horror-show-2026' },
    { name: 'Shoshana Bean', showTitle: 'The Lost Boys', showSlug: 'the-lost-boys-2026' },
  ],
  'Best Featured Actor in a Play': [
    { name: 'Danny Burstein', showTitle: 'Marjorie Prime', showSlug: 'marjorie-prime-2025' },
    { name: 'Christopher Abbott', showTitle: 'Death of a Salesman', showSlug: 'death-of-a-salesman-2026' },
    { name: 'Brandon J. Dirden', showTitle: 'Waiting for Godot', showSlug: 'waiting-for-godot-2025' },
    { name: 'Richard Thomas', showTitle: 'The Balusters', showSlug: 'the-balusters-2026' },
    { name: 'Alden Ehrenreich', showTitle: 'Becky Shaw', showSlug: 'becky-shaw-2026' },
    { name: 'Ruben Santiago-Hudson', showTitle: "Joe Turner's Come and Gone", showSlug: 'joe-turners-come-and-gone-2026' },
  ],
  'Best Featured Actress in a Play': [
    { name: 'Betsy Aidem', showTitle: 'Liberation', showSlug: 'liberation-2025' },
    { name: 'June Squibb', showTitle: 'Marjorie Prime', showSlug: 'marjorie-prime-2025' },
    { name: 'Laurie Metcalf', showTitle: 'Death of a Salesman', showSlug: 'death-of-a-salesman-2026' },
    { name: 'Aya Cash', showTitle: 'Giant', showSlug: 'giant-2026' },
    { name: 'Marylouise Burke', showTitle: 'The Balusters', showSlug: 'the-balusters-2026' },
  ],
};

// Beat the Critics is a one-time contest frozen to the 79th ceremony (nominees,
// critics' picks, and rules dates below are all hardcoded to it). Pin the season
// explicitly rather than deriving "current" — currentPredictionSeason() rolls
// forward to the next ceremony year 14 days after this one, which would put a
// "TONY AWARDS 2027" badge over this page's "2026 Tony Awards have taken place"
// copy (BRO-242).
const BEAT_THE_CRITICS_CEREMONY_YEAR = 2026;

export default function BeatTheCriticsPage() {
  const allShows = getBroadwayShows();
  const season = getTonySeasonWindowFor(BEAT_THE_CRITICS_CEREMONY_YEAR);
  const eligible = getEligibleShows(allShows, season);
  const grouped = groupIntoCategories(eligible);

  const categoryMap = new Map<string, TonyCategory>();
  for (const cat of grouped) {
    categoryMap.set(cat.title, cat);
  }

  // Build thumbnail + score lookup from eligible shows
  const thumbMap = new Map<string, string | null>();
  const scoreMap = new Map<string, number | null>();
  for (const s of eligible) {
    thumbMap.set(s.slug, s.images?.thumbnail ?? null);
    scoreMap.set(s.slug, s.compositeScore ?? null);
  }

  // Tier 1: The Big Four (show categories) — filtered to curated likely nominees
  const tier1 = {
    key: 'tier1',
    label: 'Tier 1',
    name: 'The Big Four',
    categories: ['Best Musical', 'Best Play', 'Best Revival of a Musical', 'Best Revival of a Play'].map(catTitle => {
      const catData = categoryMap.get(catTitle);
      const allNominees = catData ? [...catData.shows, ...catData.upcoming] : [];
      const curated = CURATED_SHOW_NOMINEES[catTitle];
      const nominees = curated
        ? allNominees.filter(n => curated.includes(n.slug))
        : allNominees;
      return { title: catTitle, nominees };
    }),
  };

  // Tier 2: Lead Actor Awards (no CriticScore — critics only)
  const tier2 = {
    key: 'tier2',
    label: 'Tier 2',
    name: 'Lead Actors',
    categories: Object.entries(LEAD_ACTOR_NOMINEES).map(([catTitle, actors]) => ({
      title: catTitle,
      nominees: [] as SerializedTonyShow[],
      isActorCategory: true,
      actorNominees: actors.map(a => ({
        ...a,
        thumbnailPath: thumbMap.get(a.showSlug) ?? null,
          showScore: scoreMap.get(a.showSlug) ?? null,
      })),
    })),
  };

  // Tier 3: Featured Actor Awards
  const tier3 = {
    key: 'tier3',
    label: 'Tier 3',
    name: 'Featured Actors',
    categories: Object.entries(FEATURED_ACTOR_NOMINEES).map(([catTitle, actors]) => ({
      title: catTitle,
      nominees: [] as SerializedTonyShow[],
      isActorCategory: true,
      actorNominees: actors.map(a => ({
        ...a,
        thumbnailPath: thumbMap.get(a.showSlug) ?? null,
          showScore: scoreMap.get(a.showSlug) ?? null,
      })),
    })),
  };

  // Exact 2026 Tony nominees per creative/technical category (sourced from tony-nominations.json)
  const CURATED_TIER4_NOMINEES: Record<string, string[]> = {
    'Best Direction of a Musical': ['two-strangers', 'ragtime', 'schmigadoon', 'the-lost-boys', 'cats-the-jellicle-ball'],
    'Best Direction of a Play':    ['liberation', 'oedipus', 'death-of-a-salesman', 'giant', 'the-balusters'],
    'Best Original Score':         ['two-strangers', 'schmigadoon', 'the-lost-boys', 'joe-turners-come-and-gone', 'death-of-a-salesman'],
    'Best Book of a Musical':      ['two-strangers', 'schmigadoon', 'the-lost-boys', 'titanique'],
    'Best Choreography':           ['ragtime', 'schmigadoon', 'the-rocky-horror-show', 'the-lost-boys', 'cats-the-jellicle-ball'],
    'Best Orchestrations':         ['two-strangers', 'chess', 'schmigadoon', 'the-lost-boys', 'cats-the-jellicle-ball'],
  };

  // Flat slug index across all eligible categories (includes shows not in tier1 curated lists)
  const allShowsBySlug = new Map<string, SerializedTonyShow>();
  for (const cat of grouped) {
    for (const s of [...cat.shows, ...cat.upcoming]) {
      if (!allShowsBySlug.has(s.slug)) allShowsBySlug.set(s.slug, s);
    }
  }
  function buildFromSlugs(slugs: string[]): SerializedTonyShow[] {
    return slugs.map(slug => allShowsBySlug.get(slug)).filter((s): s is SerializedTonyShow => !!s);
  }

  // Tier 4: Creative & Technical (show-based — CriticScore applies)
  const tier4 = {
    key: 'tier4',
    label: 'Tier 4',
    name: 'Creative & Technical',
    categories: [
      { title: 'Best Direction of a Musical', nominees: buildFromSlugs(CURATED_TIER4_NOMINEES['Best Direction of a Musical']) },
      { title: 'Best Direction of a Play',    nominees: buildFromSlugs(CURATED_TIER4_NOMINEES['Best Direction of a Play']) },
      { title: 'Best Original Score',         nominees: buildFromSlugs(CURATED_TIER4_NOMINEES['Best Original Score']) },
      { title: 'Best Book of a Musical',      nominees: buildFromSlugs(CURATED_TIER4_NOMINEES['Best Book of a Musical']) },
      { title: 'Best Choreography',           nominees: buildFromSlugs(CURATED_TIER4_NOMINEES['Best Choreography']) },
      { title: 'Best Orchestrations',         nominees: buildFromSlugs(CURATED_TIER4_NOMINEES['Best Orchestrations']) },
    ],
  };

  const tiers = [tier1, tier2, tier3, tier4];

  const eligibleCount = eligible.length;
  const totalReviews = eligible.reduce((sum, s) => sum + (s.criticScore?.reviewCount || 0), 0);

  const data: BeatTheCriticsData = {
    tiers,
    season: { label: season.label, ceremonyYear: season.ceremonyYear },
    stats: {
      reviewsScored: totalReviews || 2400,
      showsTracked: eligibleCount || 38,
      criticsTracked: 150,
    },
  };

  return <BeatTheCriticsClient data={data} />;
}
