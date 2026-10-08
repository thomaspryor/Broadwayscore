import type { Metadata } from 'next';
import { cache } from 'react';
import { notFound, redirect } from 'next/navigation';
import { SHARE_TOKEN_RE, shareTokenFromParam } from '@/lib/share-links/load';
import { privateShareMetadata } from '@/components/PrivateShareLayout';
import { loadSharedDiaryView } from '@/lib/shared-diary/load-view';
import { diarySummary, diaryTitle } from '@/lib/shared-diary/view-model';
import SeenView from './SeenView';

/**
 * /seen/<token> — someone's shared theater diary (BRO-4566,
 * docs/specs/shared-diary.md). Public, no sign-in.
 *
 * Rendered per request and never cached: a share the owner just stopped must
 * stop showing. It 404s for every token until an owner creates a share.
 */
export const dynamic = 'force-dynamic';

// generateMetadata and the page share one load per request.
const load = cache((token: string) => loadSharedDiaryView(token));

interface PageProps {
  params: { token: string };
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const data = await load(params.token);
  if (data.status !== 'ok') return { ...privateShareMetadata, title: 'Theater diary' };
  const title = diaryTitle(data.view.name);
  // Never note text here: previews travel to group chats.
  const description = `${diarySummary(data.view.showsSeen)} on Broadway Scorecard`;
  return {
    ...privateShareMetadata,
    title,
    description,
    openGraph: { title, description, type: 'website', siteName: 'Broadway Scorecard' },
    twitter: { card: 'summary_large_image', title, description },
  };
}

export default async function SharedDiaryPage({ params }: PageProps) {
  // A share sheet glued its message onto the link: send the friend to the
  // clean URL so the address bar (and anything copied from it) is the real link.
  const clean = shareTokenFromParam(params.token);
  if (clean !== params.token && SHARE_TOKEN_RE.test(clean)) redirect(`/seen/${clean}`);
  const data = await load(params.token);
  if (data.status === 'not-shared') notFound();
  // Database or config failure: the error boundary shows "try again" rather
  // than the not-shared page, so a blip never looks like sharing was stopped.
  if (data.status === 'unavailable') throw new Error('Shared diary is temporarily unavailable');
  return <SeenView view={data.view} />;
}
