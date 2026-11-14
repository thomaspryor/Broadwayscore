'use client';

/*
 * LIVE A/B TEST (BRO-5989): related-shows-position.
 * Read memory/feedback_ab_test_guardrails.md and docs/experiments/related-shows-position.md
 * before changing this file or the PostHog flag.
 *
 * Arms (PostHog flag `related-shows-position`, 50/50, mobile only):
 *   control               renders nothing; the page is unchanged.
 *   compact-after-reviews renders a compact related-shows row right after the
 *                         Critic Scorecard card (reviews stay above it).
 * Desktop visitors never read the flag, so they never join an arm.
 * The bottom-of-page RelatedShows sections are untouched in both arms.
 */

import { useEffect, useState } from 'react';
import MiniShowCard from '@/components/show-cards/MiniShowCard';
import ScrollRow from '@/components/ScrollRow';
import type { ShowCardShow } from '@/components/show-cards/types';
import { usePostHogFlag } from '@/lib/hooks';
import { VARIANT_COMPACT } from '../../scripts/lib/related-shows-ab';

// Literal here (not imported) so scripts/lib/flag-registry.js can resolve it statically.
const RELATED_SHOWS_FLAG = 'related-shows-position';
const MOBILE_QUERY = '(max-width: 639px)';

export default function RelatedShowsCompactAB({ shows, sourceShowId }: { shows: ShowCardShow[]; sourceShowId: string }) {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    setIsMobile(window.matchMedia(MOBILE_QUERY).matches);
  }, []);

  // Exposure is recorded by getFeatureFlag ($feature_flag_called); gate on
  // eligibility first so desktop and empty-pool visitors stay out of the test.
  const eligible = isMobile && shows.length > 0;
  const variant = usePostHogFlag(RELATED_SHOWS_FLAG, eligible);

  useEffect(() => {
    if (!variant) return;
    window.posthog?.capture('related_shows_ab_exposed', { flag: RELATED_SHOWS_FLAG, variant, show_id: sourceShowId });
  }, [variant, sourceShowId]);

  if (!eligible || variant !== VARIANT_COMPACT) return null;

  return (
    <section
      className="mb-5 sm:hidden"
      aria-labelledby="related-compact-heading"
      data-testid="related-shows-compact"
      onClickCapture={(e) => {
        const a = (e.target as HTMLElement).closest('a');
        if (a) window.posthog?.capture('related_shows_ab_click', { flag: RELATED_SHOWS_FLAG, variant, show_id: sourceShowId, href: a.getAttribute('href') });
      }}
    >
      <h2 id="related-compact-heading" className="text-[11px] font-bold uppercase tracking-[0.12em] text-gray-400 leading-none mb-3">
        You Might Also Like
      </h2>
      <ScrollRow>
        {shows.map((show) => (
          <MiniShowCard key={show.id} show={show} />
        ))}
      </ScrollRow>
    </section>
  );
}
