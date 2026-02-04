// Critic Consensus data module
// Imports: critic-consensus.json only (~217 KB)

import type { CriticConsensus } from './data-types';
import criticConsensusData from '../../data/critic-consensus.json';

interface CriticConsensusFile {
  _meta: {
    description: string;
    lastGenerated: string | null;
    updatePolicy: string;
  };
  shows: Record<string, CriticConsensus>;
}

const criticConsensus = criticConsensusData as unknown as CriticConsensusFile;

/**
 * Get critic consensus for a specific show by ID
 */
export function getCriticConsensus(showId: string): CriticConsensus | undefined {
  return criticConsensus.shows[showId];
}

/**
 * Get critic consensus last generated timestamp
 */
export function getCriticConsensusLastUpdated(): string | null {
  return criticConsensus._meta.lastGenerated;
}
