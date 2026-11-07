// Creative-team twin of actor-indexability.ts: one rule for page robots and sitemap (BRO-5399).
import type { UnifiedCreativeProfile } from './data-types';
import { getPersonTonyStatsByName } from './data-tony-noms';
import { isThinActorProfile } from '../../scripts/lib/actor-indexability';

export function isThinCreative(profile: UnifiedCreativeProfile): boolean {
  return isThinActorProfile(profile, getPersonTonyStatsByName(profile.name)?.nominations ?? 0);
}
