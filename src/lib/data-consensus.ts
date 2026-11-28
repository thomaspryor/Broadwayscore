// Critic Consensus data module
// Imports: critic-consensus.json only (~217 KB)

import type { CriticConsensus } from './data-types';
import criticConsensusData from '../../data/critic-consensus.json';
import { stripInlineMarkdown } from './formatting';

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
  return normalizeCriticConsensus(criticConsensus.shows[showId]);
}

/**
 * One show's raw critic-consensus.json entry as readers see it. Pure, shared
 * with show-refresh (BRO-8056), which carries the raw entry in a show's slice.
 */
export function normalizeCriticConsensus(consensus: CriticConsensus | null | undefined): CriticConsensus | undefined {
  // Same stripping contract as data-guides getCriticConsensus — LLM-generated
  // consensus text can carry markdown that must not reach UI or JSON-LD.
  return consensus ? { ...consensus, text: stripInlineMarkdown(consensus.text) } : undefined;
}

/**
 * Get critic consensus last generated timestamp
 */
export function getCriticConsensusLastUpdated(): string | null {
  return criticConsensus._meta.lastGenerated;
}
