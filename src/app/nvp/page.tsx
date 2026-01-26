import Link from 'next/link';
import { Metadata } from 'next';
import { getAllShows } from '@/lib/data';
import { getOptimizedImageUrl } from '@/lib/images';

// NVP show IDs - shows invested in by Nothing Ventured Productions
const NVP_SHOW_IDS = [
  'two-strangers-bway-2025',
  'chess-2025',
  'and-juliet-2022',
  'cats-the-jellicle-ball-2026',
  'proof-2026',
  'cabaret-2024',
  'water-for-elephants-2024',
  'suffs-2024',
  // Future additions as they get added to database:
  // 'sunset-blvd-2024',
  // 'enemy-of-the-people-2024',
  // 'smash-2025',
  // 'good-night-good-luck-2025',
  // 'waiting-for-godot-2024',
  // 'parade-2023',
  // 'redwood-2025',
  // 'hold-on-to-me-darling-2024',
  // 'once-upon-a-mattress-2024',
  // 'romeo-juliet-2024',
];

export const metadata: Metadata = {
  title: 'NVP Portfolio | BroadwayScorecard',
  description: 'Broadway shows invested in by Nothing Ventured Productions',
  robots: 'noindex, nofollow', // Easter egg - don't index
};

function ScoreBadge({ score, reviewCount, status }: { score?: number | null; reviewCount?: number; status?: string }) {
  if (status === 'previews') {
    return (
      <div className="w-12 h-12 bg-surface-overlay text-gray-400 border border-white/10 flex items-center justify-center font-bold text-sm rounded-xl">
        TBD
      </div>
    );
  }

  if (reviewCount !== undefined && reviewCount < 5) {
    return (
      <div className="w-12 h-12 bg-surface-overlay text-gray-400 border border-white/10 flex items-center justify-center font-bold text-sm rounded-xl">
        TBD
      </div>
    );
  }

  if (score === undefined || score === null) {
    return (
      <div className="w-12 h-12 bg-surface-overlay text-gray-500 border border-white/10 flex items-center justify-center font-bold text-lg rounded-xl">
        -
      </div>
    );
  }

  const roundedScore = Math.round(score);
  let colorClass: string;

  if (roundedScore >= 85) {
    colorClass = 'score-must-see';
  } else if (roundedScore >= 75) {
    colorClass = 'score-great';
  } else if (roundedScore >= 65) {
    colorClass = 'score-good';
  } else if (roundedScore >= 55) {
    colorClass = 'score-tepid';
  } else {
    colorClass = 'score-skip';
  }

  return (
    <div className={`w-12 h-12 ${colorClass} flex items-center justify-center font-bold text-lg rounded-xl`}>
      {roundedScore}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const config = {
    open: { label: 'Now Playing', color: 'bg-emerald-500/20 text-emerald-400' },
    previews: { label: 'In Previews', color: 'bg-purple-500/20 text-purple-400' },
    closed: { label: 'Closed', color: 'bg-gray-500/20 text-gray-400' },
  }[status] || { label: status, color: 'bg-gray-500/20 text-gray-400' };

  return (
    <span className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded ${config.color}`}>
      {config.label}
    </span>
  );
}

export default function NVPPage() {
  const allShows = getAllShows();

  // Filter to NVP shows and sort: open first, then previews, then closed (by score within each)
  const nvpShows = allShows
    .filter(show => NVP_SHOW_IDS.includes(show.id))
    .sort((a, b) => {
      const statusOrder = { open: 0, previews: 1, closed: 2 };
      const aOrder = statusOrder[a.status as keyof typeof statusOrder] ?? 3;
      const bOrder = statusOrder[b.status as keyof typeof statusOrder] ?? 3;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return (b.criticScore?.score ?? 0) - (a.criticScore?.score ?? 0);
    });

  const openShows = nvpShows.filter(s => s.status === 'open');
  const previewShows = nvpShows.filter(s => s.status === 'previews');
  const closedShows = nvpShows.filter(s => s.status === 'closed');

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center text-white font-bold text-lg">
            NVP
          </div>
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-white">NVP Portfolio</h1>
            <p className="text-gray-400 text-sm">Nothing Ventured Productions</p>
          </div>
        </div>

        <p className="text-gray-300 leading-relaxed mb-4">
          Shows invested in by <a href="https://www.nvpbroadway.com/" target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">Nothing Ventured Productions</a>,
          a four-time Tony nominated production company founded by Alexandra Cavoulacos, Kathryn Minshew, and Christina Wallace.
        </p>

        <div className="flex flex-wrap gap-3 text-sm">
          <div className="px-3 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-400">
            {openShows.length} Playing
          </div>
          <div className="px-3 py-1.5 rounded-lg bg-purple-500/10 text-purple-400">
            {previewShows.length} In Previews
          </div>
          <div className="px-3 py-1.5 rounded-lg bg-gray-500/10 text-gray-400">
            {closedShows.length} Closed
          </div>
        </div>
      </div>

      {/* Show List */}
      {nvpShows.length > 0 ? (
        <div className="space-y-3">
          {nvpShows.map((show) => (
            <Link
              key={show.id}
              href={`/show/${show.slug}`}
              className="card p-4 flex items-center gap-4 hover:bg-surface-raised/80 transition-colors group"
            >
              {/* Thumbnail */}
              <div className="w-16 h-16 rounded-lg overflow-hidden bg-surface-overlay flex-shrink-0">
                {show.images?.thumbnail ? (
                  <img
                    src={getOptimizedImageUrl(show.images.thumbnail, 'thumbnail')}
                    alt={`${show.title} poster`}
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <span className="text-2xl">🎭</span>
                  </div>
                )}
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <h2 className="font-bold text-white text-base group-hover:text-brand transition-colors truncate">
                  {show.title}
                </h2>
                <p className="text-gray-400 text-sm truncate">
                  {show.venue}
                </p>
                <div className="flex items-center gap-2 mt-1.5">
                  <StatusPill status={show.status} />
                  {show.status === 'previews' && (
                    <span className="text-xs text-gray-500">
                      Opens {new Date(show.openingDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </span>
                  )}
                  {show.closingDate && show.status === 'open' && (
                    <span className="text-xs text-amber-400">
                      Closes {new Date(show.closingDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </span>
                  )}
                </div>
              </div>

              {/* Score */}
              <ScoreBadge
                score={show.criticScore?.score}
                reviewCount={show.criticScore?.reviewCount}
                status={show.status}
              />
            </Link>
          ))}
        </div>
      ) : (
        <div className="card p-8 text-center">
          <div className="text-4xl mb-4">🎭</div>
          <h2 className="text-xl font-bold text-white mb-2">No Shows Found</h2>
          <p className="text-gray-400">NVP shows haven&apos;t been added to the database yet.</p>
        </div>
      )}

      {/* Footer Note */}
      <div className="mt-8 p-4 rounded-xl bg-surface-overlay/50 border border-white/5">
        <p className="text-xs text-gray-500 text-center">
          This is an unofficial fan page. Visit <a href="https://www.nvpbroadway.com/" target="_blank" rel="noopener noreferrer" className="text-gray-400 hover:text-white">nvpbroadway.com</a> for official NVP information.
        </p>
      </div>

      {/* Back to Home */}
      <div className="mt-6 text-center">
        <Link href="/" className="text-brand hover:text-brand-hover text-sm font-medium transition-colors">
          ← Back to all shows
        </Link>
      </div>
    </div>
  );
}
