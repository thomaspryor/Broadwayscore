import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isAdmin } from '@/lib/admin-auth';
import { getAllCritics } from '@/lib/data-reviews';
import { criticBackendReady, sbAdmin } from '@/lib/critic-server';
import InviteCreator, { type InviteCritic } from './InviteCreator';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { robots: { index: false, follow: false } };

/** Slugs with an approved owner, or null when that could not be checked. */
async function ownedSlugs(): Promise<string[] | null> {
  if (!criticBackendReady()) return process.env.NODE_ENV === 'production' ? null : [];
  try {
    const res = await sbAdmin('/rest/v1/critic_claims?status=eq.approved&select=critic_slug&limit=5000');
    if (!res.ok) return null;
    return ((await res.json()) as { critic_slug: string }[]).map((r) => r.critic_slug);
  } catch { return null; }
}

// BRO-7087: the owner makes an invite link for a critic they know. Not linked
// from any nav; robots.ts disallows /admin/.
export default async function CriticInvitesPage() {
  if (!(await isAdmin())) notFound();
  const owned = await ownedSlugs();
  const ownedSet = new Set(owned || []);
  const critics: InviteCritic[] = getAllCritics().map((c) => ({
    slug: c.slug, name: c.name, outlet: c.primaryOutlet, reviews: c.reviewCount, owned: ownedSet.has(c.slug),
  }));

  return (
    <div className="min-h-screen bg-surface text-white">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 sm:py-10">
        <header className="mb-6">
          <Link href="/admin" className="text-sm text-brand hover:underline">Admin</Link>
          <h1 className="text-2xl sm:text-3xl font-extrabold mt-3">Invite a critic</h1>
          <p className="text-sm text-gray-400 mt-1">
            Make a link for a critic you know. When they open it and sign in, their page is theirs. No form, no approval email.
          </p>
        </header>
        {owned === null && (
          <p role="alert" className="card p-4 mb-4 text-sm text-score-tepid">
            Could not check which pages already have an owner. Creating a link still checks this.
          </p>
        )}
        <InviteCreator critics={critics} />
      </div>
    </div>
  );
}
