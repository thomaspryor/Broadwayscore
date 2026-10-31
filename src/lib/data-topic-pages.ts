// Data for the Profitability Scorecard topic pages (BRO-5865): joins shows, commercial
// records, canonical Critic Scores and audience buzz, then hands them to the
// pure aggregates in investment-topics.ts.

import { getCriticScoreMap } from '../../scripts/lib/canonical-critic-scores';
import { getAllShows } from './data-core';
import { getAudienceBuzz, hasEnoughAudienceReviews } from './data-audience';
import { getMarketDate } from './date-utils';
import { getTopicShowInputs } from './data-commercial';
import { featureFlags } from '@/config/feature-flags';
import awardsData from '../../data/awards.json';
import { buildMusicalsSinceReopening, buildWhatPredictsTheMoney, buildFlopsAndRecoups, buildTonyWinners, tonyFromAwards, type TopicShowInput } from './investment-topics';

// awards.json is keyed by show id (the-outsiders-2024), the commercial record by slug.
const awardShows = (awardsData as { shows: Record<string, { tony?: Parameters<typeof tonyFromAwards>[0] }> }).shows;

let cache: TopicShowInput[] | null = null;

function inputs(): TopicShowInput[] {
  if (!cache) {
    // Audience score counts only with enough audience reviews behind it.
    const audience = new Map<string, number | null>();
    for (const s of getAllShows()) {
      const buzz = getAudienceBuzz(s.id);
      audience.set(s.id, buzz && hasEnoughAudienceReviews(buzz) ? buzz.combinedScore ?? null : null);
    }
    // Commercial data is read only while featureFlags.commercial is on (released 2026-10-26, BRO-6192).
    const base = featureFlags.commercial ? getTopicShowInputs(getCriticScoreMap(), audience) : [];
    cache = base.map((s) => ({
      ...s,
      tony: tonyFromAwards((awardShows[s.id ?? ''] ?? awardShows[s.slug])?.tony),
    }));
  }
  return cache;
}

export function getMusicalsSinceReopening(asOf: string = getMarketDate('broadway')) {
  return buildMusicalsSinceReopening(inputs(), asOf);
}

export function getWhatPredictsTheMoney(asOf: string = getMarketDate('broadway')) {
  return buildWhatPredictsTheMoney(inputs(), asOf);
}

export function getFlopsAndRecoups(asOf: string = getMarketDate('broadway')) {
  return buildFlopsAndRecoups(inputs(), asOf);
}

export function getTonyWinners(asOf: string = getMarketDate('broadway')) {
  return buildTonyWinners(inputs(), asOf);
}
