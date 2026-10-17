'use client';

import { startTransition } from 'react';
import { useRouter } from 'next/navigation';

// The database (or its config) failed. Kept apart from not-found.tsx so a
// temporary outage never reads as "your friend stopped sharing".
export default function SharedPlansError({ reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  // reset() alone re-renders the same failed server output; refresh() asks the
  // server to render the page again (Next 14 error-boundary recovery).
  const retry = () => startTransition(() => { router.refresh(); reset(); });
  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center px-4 text-center" data-testid="plans-unavailable">
      <h1 className="text-xl font-bold text-white mb-2">Couldn&apos;t load these plans</h1>
      <p className="text-sm text-gray-400 mb-6 max-w-sm">Try again in a minute.</p>
      <button type="button" onClick={retry} className="btn btn-secondary">
        Try again
      </button>
    </div>
  );
}
