import fs from 'fs';
import path from 'path';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getShowById } from '@/lib/data-core';
import { serializeShowForClient } from '@/lib/serialize-show';
import { BASE_URL } from '@/lib/seo';
import { ShowListCard } from '@/components/show-cards';

// Link-in-bio page for the Instagram, TikTok and Threads profiles (BRO-6377).
// Lists the shows our social accounts posted most recently, newest first, read
// at build time from the autopost ledger (scripts/social-autopost/run.js). A
// new post lands in the ledger and redeploys via should-deploy-gate.js.

const MAX_SHOWS = 12;

export const metadata: Metadata = {
  title: 'Latest From Our Socials',
  description: 'The shows we just posted about, with every critic review and the Critic Score for each.',
  alternates: { canonical: `${BASE_URL}/links` },
  // A bio landing page, not a search destination.
  robots: { index: false, follow: true },
};

interface LedgerPost {
  showId?: string;
  dueAt?: string;
  date?: string;
  skipped?: string;
  channels?: Record<string, { result?: string }>;
}

function latestPostedShowIds(): string[] {
  let posts: LedgerPost[] = [];
  try {
    posts = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/social-autopost-ledger.json'), 'utf8')).posts || [];
  } catch {
    return [];
  }
  const sent = posts
    .filter((p) => p.showId && !p.skipped && Object.values(p.channels || {}).some((c) => c && c.result === 'sent'))
    .sort((a, b) => String(b.dueAt || b.date).localeCompare(String(a.dueAt || a.date)));
  const ids: string[] = [];
  for (const p of sent) if (!ids.includes(p.showId as string)) ids.push(p.showId as string);
  return ids;
}

export default function LinksPage() {
  const shows = latestPostedShowIds()
    .map((id) => getShowById(id))
    .filter((s): s is NonNullable<typeof s> => Boolean(s))
    .slice(0, MAX_SHOWS)
    .map((s) => ({ ...serializeShowForClient(s), ticketLinks: [] }));

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <header className="text-center mb-8">
        <h1 className="text-3xl sm:text-4xl font-extrabold text-white mb-3">Latest From Our Socials</h1>
        <p className="text-gray-300">
          The shows we just posted about. Tap one for every critic review and its Critic Score.
        </p>
      </header>

      {shows.length > 0 ? (
        <ol className="space-y-3">
          {shows.map((show, i) => (
            <li key={show.id}>
              <ShowListCard show={show} index={i} priorityFirstImage scoreMode="critics" variant="compact" showReviewCount showCategoryBadge isMixedStatus />
            </li>
          ))}
        </ol>
      ) : (
        <div className="card p-6 text-center text-gray-300">No posts yet. See what&apos;s scoring now on the homepage.</div>
      )}

      <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Link href="/" className="btn-primary text-center">Broadway shows</Link>
        <Link href="/west-end" className="btn-secondary text-center">West End shows</Link>
      </div>
    </div>
  );
}
