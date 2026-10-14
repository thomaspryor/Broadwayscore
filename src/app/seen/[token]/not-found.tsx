import Link from 'next/link';

// One neutral page for an unknown, stopped or reset link, the same for all
// three, so a link gives away nothing about which it was.
export default function SharedDiaryNotFound() {
  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center px-4 text-center" data-testid="diary-not-shared">
      <h1 className="text-xl font-bold text-white mb-2">This diary isn&apos;t being shared right now</h1>
      <p className="text-sm text-gray-400 mb-6 max-w-sm">
        The link may have been turned off or replaced. Ask your friend for a new one.
      </p>
      <Link href="/" className="btn btn-secondary">
        See what&apos;s playing
      </Link>
    </div>
  );
}
