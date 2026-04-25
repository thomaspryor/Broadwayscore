import { notFound } from 'next/navigation';
import { isAdmin } from '@/lib/admin-auth';
import IngestForm from './IngestForm';

export const dynamic = 'force-dynamic';

// robots.ts disallows /admin/ for every crawler. Not advertised publicly.

export default function AdminIngestPage() {
  if (!isAdmin()) {
    notFound();
  }

  return (
    <div className="min-h-screen bg-surface text-white">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 sm:py-10">
        <header className="mb-6">
          <h1 className="text-2xl sm:text-3xl font-extrabold text-white">Add a review</h1>
          <p className="text-sm text-gray-400 mt-1">
            Paste the review&apos;s URL and full text. We&apos;ll figure out the outlet, critic,
            show, and date — you confirm or fix anything that&apos;s wrong, then submit.
          </p>
        </header>
        <IngestForm />
      </div>
    </div>
  );
}
