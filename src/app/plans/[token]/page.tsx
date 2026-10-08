import type { Metadata } from 'next';
import { cache } from 'react';
import { notFound, redirect } from 'next/navigation';
import { SHARE_TOKEN_RE, shareTokenFromParam } from '@/lib/share-links/load';
import { loadSharedPlansView } from '@/lib/shared-plans/load-view';
import { plansSummary, plansTitle } from '@/lib/shared-plans/view-model';
import SharedPlansView from './SharedPlansView';

/**
 * /plans/<token> — someone's shared theater plans (BRO-4481,
 * docs/specs/shared-plans.md). Public, no sign-in.
 *
 * Rendered per request and never cached: the link is live, and a share the
 * owner just stopped must stop showing. Not feature-flagged — it 404s for
 * every token until an owner creates a share.
 */
export const dynamic = 'force-dynamic';

// generateMetadata and the page share one load per request.
const load = cache((token: string) => loadSharedPlansView(token));

interface PageProps {
  params: { token: string };
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const data = await load(params.token);
  // Private, per-person pages: never indexed, and the token never leaves in a
  // Referer header when a friend taps through to another site.
  const base: Metadata = { robots: { index: false, follow: false }, referrer: 'no-referrer' };
  if (data.status !== 'ok') return { ...base, title: 'Theater plans' };
  const title = plansTitle(data.view.name);
  const description = `${plansSummary(data.view.counts)} on Broadway Scorecard`;
  return {
    ...base,
    title,
    description,
    openGraph: { title, description, type: 'website', siteName: 'Broadway Scorecard' },
    twitter: { card: 'summary_large_image', title, description },
  };
}

export default async function SharedPlansPage({ params }: PageProps) {
  // A share sheet glued its message onto the link: send the friend to the
  // clean URL so the address bar (and anything copied from it) is the real link.
  const clean = shareTokenFromParam(params.token);
  if (clean !== params.token && SHARE_TOKEN_RE.test(clean)) redirect(`/plans/${clean}`);
  const data = await load(params.token);
  if (data.status === 'not-shared') notFound();
  // Database or config failure: the error boundary shows "try again" rather
  // than the not-shared page, so a blip never looks like sharing was stopped.
  if (data.status === 'unavailable') throw new Error('Shared plans are temporarily unavailable');
  return <SharedPlansView view={data.view} />;
}
