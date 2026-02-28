import { getBroadwayShows } from '@/lib/data-core';
import { getAudienceBuzz, hasEnoughAudienceReviews } from '@/lib/data-audience';
import NVPClient from './NVPClient';
import type { NVPShow } from './NVPClient';

// NVP show IDs - shows invested in by Nothing Ventured Productions
const NVP_SHOW_IDS = [
  'two-strangers-bway-2025',
  'chess-2025',
  'cats-the-jellicle-ball-2026',
  'proof-2026',
  'sunset-boulevard-2024',
  'an-enemy-of-the-people-2024',
  'smash-2025',
  'good-night-and-good-luck-2025',
  'parade-2023',
  'redwood-2025',
  'once-upon-a-mattress-2024',
  'romeo-juliet-2024',
  'waiting-for-godot-2025',
  'cabaret-2024',
  'water-for-elephants-2024',
  'suffs-2024',
];

// Off-Broadway NVP investments (not in shows.json)
const NVP_OFF_BROADWAY = [
  { title: 'Hold On to Me Darling', venue: 'Lucille Lortel Theatre', year: '2024', note: 'Off-Broadway' },
];

export default function NVPPage() {
  const allShows = getBroadwayShows();

  // Pre-serialize only NVP shows with audience data
  const nvpShows: NVPShow[] = allShows
    .filter(show => NVP_SHOW_IDS.includes(show.id))
    .map(show => {
      const buzz = getAudienceBuzz(show.id);
      return {
        id: show.id,
        slug: show.slug,
        title: show.title,
        type: show.type,
        status: show.status,
        isRevival: show.isRevival === true,
        openingDate: show.openingDate,
        closingDate: show.closingDate || undefined,
        images: show.images ? {
          thumbnail: show.images.thumbnail || undefined,
          poster: show.images.poster || undefined,
          hero: show.images.hero || undefined,
        } : undefined,
        criticScore: show.criticScore ? {
          score: show.criticScore.score,
          reviewCount: show.criticScore.reviewCount,
        } : null,
        audienceCombinedScore: buzz?.combinedScore ?? null,
        audienceHasEnoughReviews: buzz ? hasEnoughAudienceReviews(buzz) : false,
      };
    });

  return <NVPClient shows={nvpShows} offBroadway={NVP_OFF_BROADWAY} />;
}
