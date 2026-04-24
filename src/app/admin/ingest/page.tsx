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
          <h1 className="text-2xl sm:text-3xl font-extrabold text-white">Ingest review</h1>
          <p className="text-sm text-gray-400 mt-1">
            Paste a review URL + full text. Server-side: resolves outlet, writes protected review
            file to the private repo, triggers a fast rebuild. Bypasses the 8-bug CLI flow.
          </p>
        </header>
        <IngestForm />
      </div>
    </div>
  );
}
