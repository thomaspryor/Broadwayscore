import { getBroadwayShows } from '@/lib/data-core';
import {
  getTonySeasonWindow,
  getEligibleShows,
  groupIntoCategories,
  type SerializedTonyShow,
  type TonyCategory,
} from '@/lib/data-tony-predictions';
import { BeatTheCriticsClient } from './BeatTheCriticsClient';

export const metadata = {
  title: 'Beat the Critics | TodayTix x Broadway Scorecard',
  description: 'Pick Tony Award winners and compete against top critics and the CriticScore algorithm. Win free TodayTix tickets.',
  robots: { index: false, follow: false },
};

export interface ActorNominee {
  name: string;
  showTitle: string;
  showSlug: string;
  thumbnailPath: string | null;
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

// Curated likely nominees per Tier 1 category (~5 per, simulating post-nomination slate)
// NOTE: These use SerializedTonyShow.slug (not show ID), e.g. 'ragtime' not 'ragtime-2025'
const CURATED_SHOW_NOMINEES: Record<string, string[]> = {
  'Best Musical': [
    'two-strangers',             // NYT Critics Pick, frontrunner
    'queen-of-versailles',       // Kristin Chenoweth, Stephen Schwartz
    'schmigadoon',               // Apple TV+ adaptation
    'the-lost-boys',             // Michael Arden directing
    'beaches',                   // Major new musical
  ],
  'Best Play': [
    'giant',                     // Olivier Award winner, John Lithgow
    'dog-day-afternoon',         // Stephen Adly Guirgis, Jon Bernthal
    'the-balusters',             // David Lindsay-Abaire, Kenny Leon
    'oedipus',                   // Mark Strong, Lesley Manville
    'the-fear-of-13',            // Adrien Brody, Tessa Thompson
  ],
  'Best Revival of a Musical': [
    'ragtime',                   // Lincoln Center, 96% audience score
    'chess',                     // Aaron Tveit, Lea Michele
    'cats-the-jellicle-ball',    // Ballroom reimagining, OB hit
    'the-rocky-horror-show',     // Luke Evans, Roundabout
    'mamma-mia',                 // Tony-eligible revival
  ],
  'Best Revival of a Play': [
    'waiting-for-godot-2025',    // Keanu Reeves, Jamie Lloyd
    'art-2025',                  // Cannavale, NPH, Corden
    'marjorie-prime',            // June Squibb, Cynthia Nixon
    'joe-turners-come-and-gone', // August Wilson classic
    'bug',                       // Carrie Coon, Namir Smallwood
  ],
};

// Tier 2: Lead Actor contenders — curated from eligible shows' cast data
const LEAD_ACTOR_NOMINEES: Record<string, { name: string; showTitle: string; showSlug: string }[]> = {
  'Best Actor in a Musical': [
    { name: 'Joshua Henry', showTitle: 'Ragtime', showSlug: 'ragtime-2025' },
    { name: 'Sam Tutty', showTitle: 'Two Strangers', showSlug: 'two-strangers-bway-2025' },
    { name: 'Aaron Tveit', showTitle: 'Chess', showSlug: 'chess-2025' },
    { name: 'Brandon Uranowitz', showTitle: 'Ragtime', showSlug: 'ragtime-2025' },
    { name: 'Alex Brightman', showTitle: 'Schmigadoon!', showSlug: 'schmigadoon-2026' },
    { name: 'Nicholas Christopher', showTitle: 'Chess', showSlug: 'chess-2025' },
  ],
  'Best Actress in a Musical': [
    { name: 'Caissie Levy', showTitle: 'Ragtime', showSlug: 'ragtime-2025' },
    { name: 'Lea Michele', showTitle: 'Chess', showSlug: 'chess-2025' },
    { name: 'Kristin Chenoweth', showTitle: 'The Queen of Versailles', showSlug: 'queen-versailles-2025' },
    { name: 'Christiani Pitts', showTitle: 'Two Strangers', showSlug: 'two-strangers-bway-2025' },
    { name: 'Christine Sherrill', showTitle: 'Mamma Mia!', showSlug: 'mamma-mia-2025' },
    { name: 'Jessica Vosk', showTitle: 'Beaches', showSlug: 'beaches-2026' },
  ],
  'Best Actor in a Play': [
    { name: 'Mark Strong', showTitle: 'Oedipus', showSlug: 'oedipus-2025' },
    { name: 'Keanu Reeves', showTitle: 'Waiting for Godot', showSlug: 'waiting-for-godot-2025' },
    { name: 'Will Harrison', showTitle: 'Punch', showSlug: 'punch-2025' },
    { name: 'Namir Smallwood', showTitle: 'Bug', showSlug: 'bug-2026' },
    { name: 'Bobby Cannavale', showTitle: 'Art', showSlug: 'art-2025' },
    { name: 'Adrien Brody', showTitle: 'The Fear of 13', showSlug: 'the-fear-of-13-2026' },
  ],
  'Best Actress in a Play': [
    { name: 'Lesley Manville', showTitle: 'Oedipus', showSlug: 'oedipus-2025' },
    { name: 'Jean Smart', showTitle: 'Call Me Izzy', showSlug: 'call-me-izzy-2025' },
    { name: 'Carrie Coon', showTitle: 'Bug', showSlug: 'bug-2026' },
    { name: 'Ayo Edebiri', showTitle: 'Proof', showSlug: 'proof-2026' },
    { name: 'Laurie Metcalf', showTitle: 'Little Bear Ridge Road', showSlug: 'little-bear-ridge-road-2025' },
    { name: 'Taraji P. Henson', showTitle: "Joe Turner's Come and Gone", showSlug: 'joe-turners-come-and-gone-2026' },
  ],
};

// Tier 3: Featured Actor contenders
const FEATURED_ACTOR_NOMINEES: Record<string, { name: string; showTitle: string; showSlug: string }[]> = {
  'Best Featured Actor in a Musical': [
    { name: 'Ben Levi Ross', showTitle: 'Ragtime', showSlug: 'ragtime-2025' },
    { name: 'Bryce Pinkham', showTitle: 'Chess', showSlug: 'chess-2025' },
    { name: 'Colin Donnell', showTitle: 'Ragtime', showSlug: 'ragtime-2025' },
    { name: 'Brad Oscar', showTitle: 'Schmigadoon!', showSlug: 'schmigadoon-2026' },
    { name: 'Ephraim Sykes', showTitle: 'Buena Vista Social Club', showSlug: 'buena-vista-social-club-2025' },
  ],
  'Best Featured Actress in a Musical': [
    { name: 'Shaina Taub', showTitle: 'Ragtime', showSlug: 'ragtime-2025' },
    { name: 'Nichelle Lewis', showTitle: 'Ragtime', showSlug: 'ragtime-2025' },
    { name: 'Hannah Cruz', showTitle: 'Chess', showSlug: 'chess-2025' },
    { name: 'Ana Gasteyer', showTitle: 'Schmigadoon!', showSlug: 'schmigadoon-2026' },
    { name: 'Carly Sakolove', showTitle: 'Mamma Mia!', showSlug: 'mamma-mia-2025' },
    { name: 'McKenzie Kurtz', showTitle: 'Schmigadoon!', showSlug: 'schmigadoon-2026' },
  ],
  'Best Featured Actor in a Play': [
    { name: 'Danny Burstein', showTitle: 'Marjorie Prime', showSlug: 'marjorie-prime-2025' },
    { name: 'Christopher Lowell', showTitle: 'Marjorie Prime', showSlug: 'marjorie-prime-2025' },
    { name: 'Glenn Fleshler', showTitle: 'Good Night, and Good Luck', showSlug: 'good-night-and-good-luck-2025' },
    { name: 'Joshua Boone', showTitle: "Joe Turner's Come and Gone", showSlug: 'joe-turners-come-and-gone-2026' },
    { name: 'Jin Ha', showTitle: 'Proof', showSlug: 'proof-2026' },
  ],
  'Best Featured Actress in a Play': [
    { name: 'June Squibb', showTitle: 'Marjorie Prime', showSlug: 'marjorie-prime-2025' },
    { name: 'Cynthia Nixon', showTitle: 'Marjorie Prime', showSlug: 'marjorie-prime-2025' },
    { name: 'Susannah Flood', showTitle: 'Liberation', showSlug: 'liberation-2025' },
    { name: 'Samira Wiley', showTitle: 'Proof', showSlug: 'proof-2026' },
    { name: 'Tessa Thompson', showTitle: 'The Fear of 13', showSlug: 'the-fear-of-13-2026' },
  ],
};

export default function BeatTheCriticsPage() {
  const allShows = getBroadwayShows();
  const season = getTonySeasonWindow();
  const eligible = getEligibleShows(allShows, season);
  const grouped = groupIntoCategories(eligible);

  const categoryMap = new Map<string, TonyCategory>();
  for (const cat of grouped) {
    categoryMap.set(cat.title, cat);
  }

  // Build thumbnail lookup from eligible shows
  const thumbMap = new Map<string, string | null>();
  for (const s of eligible) {
    thumbMap.set(s.id, s.images?.thumbnail ?? null);
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
      })),
    })),
  };

  // Helper to merge curated show pools from multiple categories (deduped by slug)
  function mergeShowPools(...catTitles: string[]): SerializedTonyShow[] {
    const seen = new Set<string>();
    const merged: SerializedTonyShow[] = [];
    for (const title of catTitles) {
      const cat = categoryMap.get(title);
      if (!cat) continue;
      const curated = CURATED_SHOW_NOMINEES[title];
      for (const s of [...cat.shows, ...cat.upcoming]) {
        if (curated && !curated.includes(s.slug)) continue;
        if (!seen.has(s.slug)) { seen.add(s.slug); merged.push(s); }
      }
    }
    return merged;
  }

  // Tier 4: Creative & Technical (show-based — CriticScore applies)
  const tier4 = {
    key: 'tier4',
    label: 'Tier 4',
    name: 'Creative & Technical',
    categories: [
      { title: 'Best Direction of a Musical', nominees: mergeShowPools('Best Musical', 'Best Revival of a Musical') },
      { title: 'Best Direction of a Play', nominees: mergeShowPools('Best Play', 'Best Revival of a Play') },
      { title: 'Best Original Score', nominees: mergeShowPools('Best Musical') },
      { title: 'Best Book of a Musical', nominees: mergeShowPools('Best Musical') },
      { title: 'Best Choreography', nominees: mergeShowPools('Best Musical', 'Best Revival of a Musical') },
      { title: 'Best Orchestrations', nominees: mergeShowPools('Best Musical', 'Best Revival of a Musical') },
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
