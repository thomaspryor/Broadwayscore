'use client';

export default function ShowError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center px-4 text-center">
      <h1 className="text-6xl font-bold text-amber-500 mb-4">Oops</h1>
      <h2 className="text-2xl font-semibold text-white mb-4">Could not load this show</h2>
      <p className="text-gray-400 mb-8 max-w-md">
        Something went wrong loading this show&apos;s data. Try reloading, or browse all shows.
      </p>
      <div className="flex gap-4">
        <button
          onClick={() => reset()}
          className="px-6 py-3 bg-amber-500 text-black font-semibold rounded-lg hover:bg-amber-400 transition-colors"
        >
          Try Again
        </button>
        <a
          href="/"
          className="px-6 py-3 border border-white/20 text-gray-300 font-semibold rounded-lg hover:border-white/30 hover:text-white transition-colors"
        >
          View All Shows
        </a>
      </div>
    </div>
  );
}
