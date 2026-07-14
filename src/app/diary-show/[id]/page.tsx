import { notFound } from 'next/navigation';
import { Metadata } from 'next';
import { getDiaryShowById } from '@/lib/diary-show';
import DiaryShowClient from './DiaryShowClient';

// Never prerender — the diary catalog is 32k+ shows and would blow up the
// build. Rendered on demand (dynamicParams) and cached for a day.
export function generateStaticParams() {
  return [];
}
export const dynamicParams = true;
export const revalidate = 86400;

export function generateMetadata({ params }: { params: { id: string } }): Metadata {
  const show = getDiaryShowById(params.id);
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

export default function DiaryShowPage({ params }: { params: { id: string } }) {
  const show = getDiaryShowById(params.id);
  if (!show) notFound();
  return <DiaryShowClient show={show} />;
}
