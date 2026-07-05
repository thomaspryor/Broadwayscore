import { notFound } from 'next/navigation';
import { isAdmin } from '@/lib/admin-auth';
import Dashboard from './Dashboard';

export const dynamic = 'force-dynamic';

// No metadata export — we don't want this page in search indexes or social cards.
// robots.ts disallows /admin/ for every crawler.

export default function AdminFinancesPage() {
  if (!isAdmin()) {
    // Plain 404 rather than a gate form — don't advertise the admin surface.
    // Bootstrap via /api/admin/login?token=XXX (same as /admin/affiliate).
    notFound();
  }

  return (
    <div className="min-h-screen bg-surface text-white">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-10">
        <header className="mb-6">
          <h1 className="text-2xl sm:text-3xl font-extrabold text-white">Finances</h1>
          <p className="text-sm text-gray-400 mt-1">
            Monthly P&L from the receipt ledger (private repo). Cached 5 minutes.
          </p>
        </header>
        <Dashboard />
      </div>
    </div>
  );
}
