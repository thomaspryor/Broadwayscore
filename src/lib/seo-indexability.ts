// Page robots and sitemap share these so a noindex page is never submitted (BRO-5969).
// The thin rules are off unless SEO_THIN_NOINDEX=1 (scripts/lib/seo-indexability.js).
import { isThinClosedShow, isThinCritic, hasSearchLanding, thinRulesEnabled } from '../../scripts/lib/seo-indexability';
import { isTourIndexableShow } from './data-core';

export function isThinShow(show: { slug?: string; id?: string; status?: string; criticScore?: { reviewCount?: number } | null }, slug: string): boolean {
  if (!thinRulesEnabled()) return false;
  return isThinClosedShow({
    status: show.status,
    reviewCount: show.criticScore?.reviewCount ?? 0,
    hasSearchLanding: hasSearchLanding(`/show/${slug}`),
  });
}

export function isThinCriticPage(critic: { reviewCount?: number }, slug: string): boolean {
  if (!thinRulesEnabled()) return false;
  return isThinCritic({ reviewCount: critic.reviewCount, hasSearchLanding: hasSearchLanding(`/critics/${slug}`) });
}

/** The one show-indexability predicate: the tour rule plus the thin rule. Page robots and the sitemap both call it. */
export function isShowIndexable(
  show: Parameters<typeof isTourIndexableShow>[0] & Parameters<typeof isThinShow>[0],
  slug: string,
): boolean {
  return isTourIndexableShow(show) && !isThinShow(show, slug);
}
