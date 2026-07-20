import { notFound } from 'next/navigation';
import { Metadata } from 'next';
import { getDiaryShowById, getShowStubById } from '@/lib/diary-show';
import DiaryShowClient from './DiaryShowClient';

// Never prerender — the diary catalog is 32k+ shows and would blow up the
// build. Rendered on demand (dynamicParams) and cached for a day.
export function generateStaticParams() {
  return [];
}
export const dynamicParams = true;
export const revalidate = 86400;

export async function generateMetadata({ params }: { params: { id: string } }): Promise<Metadata> {
  const show = getDiaryShowById(params.id) || await getShowStubById(params.id);
  if (!show) return { title: 'Show Not Found' };
  return {
    // Root layout's title template already appends " | Broadway Scorecard".
    title: show.title,
    description: `${show.title}${show.venue ? ` at ${show.venue}` : ''} — track your rating on Broadway Scorecard.`,
    // Diary-only pages are low-content and near-duplicate at scale — keep
    // them out of search results.
    robots: { index: false, follow: false },
  };
}

export default async function DiaryShowPage({ params }: { params: { id: string } }) {
  // Fall back to a live-search stub (card 174) not yet promoted into
  // diary-lookup.json by the nightly resolver — a show added minutes ago
  // must still resolve, not 404 until tomorrow.
  const show = getDiaryShowById(params.id) || await getShowStubById(params.id);
  if (!show) notFound();
  return <DiaryShowClient show={show} />;
}
