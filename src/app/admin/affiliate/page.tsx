import { notFound } from 'next/navigation';
import { isAdmin } from '@/lib/admin-auth';
import Dashboard from './Dashboard';

export const dynamic = 'force-dynamic';

// No metadata export — we don't want this page in search indexes or social cards.
// robots.ts disallows /admin/ for every crawler.

export default function AdminAffiliatePage() {
  if (!isAdmin()) {
    // Return plain 404 rather than a gate form so we don't advertise the
    // existence of the admin surface. Bootstrap via /api/admin/login?token=XXX.
    notFound();
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-10">
        <header className="mb-6">
          <h1 className="text-2xl sm:text-3xl font-extrabold text-white">Affiliate Dashboard</h1>
          <p className="text-sm text-gray-400 mt-1">
            Live performance across Impact, Partnerize, and PostHog. Cached 5 minutes.
          </p>
        </header>
        <Dashboard />
      </div>
    </div>
  );
}
