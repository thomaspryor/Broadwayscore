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

// Tier 2: Actor contenders — curated from eligible shows' cast data
const ACTOR_NOMINEES: Record<string, { name: string; showTitle: string; showSlug: string }[]> = {
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

  // Tier 1: The Big Four (show categories)
  const tier1 = {
    key: 'tier1',
    label: 'Tier 1',
    name: 'The Big Four',
    categories: ['Best Musical', 'Best Play', 'Best Revival of a Musical', 'Best Revival of a Play'].map(catTitle => {
      const catData = categoryMap.get(catTitle);
      const nominees = catData ? [...catData.shows, ...catData.upcoming] : [];
      return { title: catTitle, nominees };
    }),
  };

  // Tier 2: Actor Awards (no CriticScore — critics only)
  const tier2 = {
    key: 'tier2',
    label: 'Tier 2',
    name: 'The Actors',
    categories: Object.entries(ACTOR_NOMINEES).map(([catTitle, actors]) => ({
      title: catTitle,
      nominees: [] as SerializedTonyShow[],
      isActorCategory: true,
      actorNominees: actors.map(a => ({
        ...a,
        thumbnailPath: thumbMap.get(a.showSlug) ?? null,
      })),
    })),
  };

  const tiers = [tier1, tier2];

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
