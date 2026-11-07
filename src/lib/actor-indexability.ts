// Single place that decides whether a /cast/[slug] page is indexable, so the page
// metadata and the sitemap can never disagree (BRO-5399).
import type { ActorProfile } from './data-types';
import { getPersonTonyStats } from './data-tony-noms';
import { isThinActorProfile } from '../../scripts/lib/actor-indexability';
import { hasSearchLanding, hasGscImpressions, thinRulesEnabled } from '../../scripts/lib/seo-indexability';

export function isThinActor(profile: ActorProfile): boolean {
  return isThinActorProfile(
    profile,
    getPersonTonyStats(profile.ibdbPersonId)?.nominations ?? 0,
    thinRulesEnabled() && (hasSearchLanding(`/cast/${profile.slug}`) || hasGscImpressions(`/cast/${profile.slug}`)),
    thinRulesEnabled(),
  );
}
