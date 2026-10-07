import { notFound } from 'next/navigation';
import Link from 'next/link';
import { isAdmin } from '@/lib/admin-auth';
import LockForm from './LockForm';

export const dynamic = 'force-dynamic';

interface SearchParams {
  showId?: string;
  outletId?: string;
  criticName?: string;
  score?: string;
  // Optional canonical filename from locks.json — passed through so the
  // form can submit it to /api/admin/lock-score for files whose
  // criticName -> filename round-trip is lossy (4/217 catalog as of
  // 2026-04-27).
  filename?: string;
  mode?: string;
}

export default function AdminLockNewPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  if (!isAdmin()) {
    notFound();
  }

  const isEdit = searchParams.mode === 'edit';
  const initialScore = searchParams.score ? Number(searchParams.score) : null;

  return (
    <div className="min-h-screen bg-surface text-white">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 sm:py-10">
        <header className="mb-6">
          <Link href="/admin/locks" className="text-[11px] text-gray-400 hover:text-white">
            ← Back to locks
          </Link>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-white mt-2">
            {isEdit ? 'Edit lock' : 'Lock a score'}
          </h1>
          <p className="text-sm text-gray-400 mt-1">
            {isEdit
              ? 'Update score or rationale. The audit trail keeps the original lockedAt and lockedBy.'
              : 'Lock a humanReviewScore on an existing review. Rationale is required (min 20 chars) so the audit trail makes sense in 30 days.'}
          </p>
        </header>
        <LockForm
          initialShowId={searchParams.showId || ''}
          initialOutletId={searchParams.outletId || ''}
          initialCriticName={searchParams.criticName || ''}
          initialScore={Number.isFinite(initialScore as number) ? (initialScore as number) : null}
          initialFilename={searchParams.filename || ''}
          isEdit={isEdit}
        />
      </div>
    </div>
  );
}
