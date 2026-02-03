import Link from 'next/link';
import { Metadata } from 'next';
import { getAllShows } from '@/lib/data';
import { getOptimizedImageUrl } from '@/lib/images';

// NVP show IDs - shows invested in by Nothing Ventured Productions
const NVP_SHOW_IDS = [
  'two-strangers-bway-2025',
  'chess-2025',
  'cats-the-jellicle-ball-2026',
  'proof-2026',
  'sunset-boulevard-2024',
  'an-enemy-of-the-people-2024',
  'smash-2025',
  'good-night-and-good-luck-2025',
  'parade-2023',
  'redwood-2025',
  'once-upon-a-mattress-2024',
  'romeo-juliet-2024',
  'waiting-for-godot-2025',
  'cabaret-2024',
  'water-for-elephants-2024',
  'suffs-2024',
];

// Off-Broadway NVP investments (not in shows.json)
const NVP_OFF_BROADWAY = [
  { title: 'Hold On to Me Darling', venue: 'Lucille Lortel Theatre', year: '2024', note: 'Off-Broadway' },
];

export const metadata: Metadata = {
  title: 'NVP Portfolio | BroadwayScorecard',
  description: 'Broadway shows invested in by Nothing Ventured Productions',
  robots: 'noindex, nofollow', // Easter egg - don't index
};

const SCORE_TIERS = {
  mustSee: { label: 'Must-See', color: '#FFD700' },
  recommended: { label: 'Recommended', color: '#22c55e' },
  worthSeeing: { label: 'Worth Seeing', color: '#14b8a6' },
  skippable: { label: 'Skippable', color: '#f59e0b' },
  stayAway: { label: 'Stay Away', color: '#ef4444' },
};

function getScoreTier(score: number | null | undefined) {
  if (score === null || score === undefined) return null;
  const rounded = Math.round(score);
  if (rounded >= 85) return SCORE_TIERS.mustSee;
  if (rounded >= 75) return SCORE_TIERS.recommended;
  if (rounded >= 65) return SCORE_TIERS.worthSeeing;
  if (rounded >= 55) return SCORE_TIERS.skippable;
  return SCORE_TIERS.stayAway;
}

function ScoreBadge({ score, reviewCount, status }: { score?: number | null; reviewCount?: number; status?: string }) {
  const sizeClass = 'w-14 h-14 text-2xl rounded-xl';

  if (status === 'previews') {
    return (
      <div className={`score-badge ${sizeClass} score-none font-bold text-gray-400`}>
        TBD
      </div>
    );
  }

  if (reviewCount !== undefined && reviewCount < 5) {
    return (
      <div className={`score-badge ${sizeClass} score-none font-bold text-gray-400`}>
        TBD
      </div>
    );
  }

  if (score === undefined || score === null) {
    return (
      <div className={`score-badge ${sizeClass} score-none font-bold`}>
        —
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
    <div className={`score-badge ${sizeClass} ${colorClass} font-bold`}>
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
              <div className="flex-shrink-0 flex flex-col items-center gap-1.5">
                {(() => {
                  const tier = getScoreTier(show.criticScore?.score);
                  return tier && show.status !== 'previews' && (show.criticScore?.reviewCount ?? 0) >= 5 ? (
                    <span
                      className="text-[9px] font-semibold uppercase tracking-wide whitespace-nowrap"
                      style={{ color: tier.color }}
                    >
                      {tier.label}
                    </span>
                  ) : null;
                })()}
                <ScoreBadge
                  score={show.criticScore?.score}
                  reviewCount={show.criticScore?.reviewCount}
                  status={show.status}
                />
              </div>
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

      {/* Off-Broadway */}
      {NVP_OFF_BROADWAY.length > 0 && (
        <div className="mt-6">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-3">Off-Broadway</h3>
          <div className="space-y-3">
            {NVP_OFF_BROADWAY.map((show) => (
              <div key={show.title} className="card p-4 flex items-center gap-4 opacity-70">
                <div className="w-16 h-16 rounded-lg bg-surface-overlay flex-shrink-0 flex items-center justify-center">
                  <span className="text-2xl">🎭</span>
                </div>
                <div className="flex-1 min-w-0">
                  <h2 className="font-bold text-white text-base truncate">{show.title}</h2>
                  <p className="text-gray-400 text-sm truncate">{show.venue}</p>
                  <div className="flex items-center gap-2 mt-1.5">
                    <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-400">
                      {show.note}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
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
