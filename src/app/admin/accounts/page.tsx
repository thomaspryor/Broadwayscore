import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isAdmin } from '@/lib/admin-auth';
import Dashboard from './Dashboard';

export const dynamic = 'force-dynamic';

// Not linked from any nav. robots.ts already disallows /admin/ for every
// crawler; noindex here as well in case a link to it ever leaks.
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function AdminAccountsPage() {
  if (!isAdmin()) {
    // Plain 404 rather than a gate form — don't advertise the admin surface.
    // Bootstrap via /api/admin/login?token=XXX&redirect=/admin/accounts.
    notFound();
  }

  return (
    <div className="min-h-screen bg-surface text-white">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-10">
        <header className="mb-6">
          <h1 className="text-2xl sm:text-3xl font-extrabold text-white">Accounts</h1>
          <p className="text-sm text-gray-400 mt-1">
            Sign-ups and what signed-in people do. Updated every 3 hours.
          </p>
        </header>
        <Dashboard />
      </div>
    </div>
  );
}
