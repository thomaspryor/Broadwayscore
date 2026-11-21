import fs from 'fs';
import path from 'path';
import type { Metadata } from 'next';
import { getShowById } from '@/lib/data-core';
import { serializeShowForClient } from '@/lib/serialize-show';
import { BASE_URL } from '@/lib/seo';
import featuredVideo from '../../../data/links-featured.json';
import LinksPageClient from './LinksPageClient';

// Link-in-bio page for the Instagram, TikTok and Threads profiles (BRO-6377).
// Lists the shows our social accounts posted most recently, newest first, read
// at build time from the autopost ledger (scripts/social-autopost/run.js). A
// new post lands in the ledger and redeploys via should-deploy-gate.js.
// Videos are posted separately. Update links-featured.json when a new show
// video goes live, so its subject stays above the image-post ledger.

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
  const featuredShow = getShowById(featuredVideo.showId);
  const featured = featuredShow ? { ...serializeShowForClient(featuredShow), ticketLinks: [] } : null;
  const shows = latestPostedShowIds()
    .filter((id) => id !== featured?.id)
    .map((id) => getShowById(id))
    .filter((s): s is NonNullable<typeof s> => Boolean(s))
    .slice(0, MAX_SHOWS)
    .map((s) => ({ ...serializeShowForClient(s), ticketLinks: [] }));

  return <LinksPageClient featured={featured} label={featuredVideo.label} shows={shows} />;
}
