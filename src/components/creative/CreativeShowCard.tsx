import Link from 'next/link';
import type { ShowTonyInfo } from '@/lib/data-tony-noms';
import { getOptimizedImageUrl } from '@/lib/images';
import { getScoreClass } from '@/lib/critic-page-utils';
import { TrophyIcon } from '@/components/icons';
import { showFormatTitle } from '@/lib/show-format';

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

interface CreativeShow {
  slug: string;
  title: string;
  thumbnail: string | null;
  venue: string;
  openingDate: string | null;
  score: number | null;
  type: string | null;
  isRevival: boolean;
  status: string;
}

export function CreativeShowCard({
  show,
  roles,
  loading = 'lazy',
  tonyInfo,
}: {
  show: CreativeShow;
  roles: string[];
  loading?: 'eager' | 'lazy';
  tonyInfo?: ShowTonyInfo;
}) {
  return (
    <Link
      href={`/show/${show.slug}`}
      className="card p-3 sm:p-4 flex items-center gap-3 sm:gap-4 hover:bg-surface-raised/80 transition-colors group"
    >
      {/* Thumbnail */}
      <div className="w-14 h-14 rounded-lg overflow-hidden bg-surface-overlay flex-shrink-0">
        {show.thumbnail ? (
          <img
            src={getOptimizedImageUrl(show.thumbnail, 'thumbnail')}
            alt={show.title}
            className="w-full h-full object-cover"
            width={56}
            height={56}
            loading={loading}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="text-xl">🎭</span>
          </div>
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <h3 className="font-bold text-white group-hover:text-brand transition-colors truncate">
          {show.title}
        </h3>
        <p className="text-gray-400 text-xs sm:text-sm truncate">
          {show.venue}
          {show.openingDate && ` · ${formatDate(show.openingDate)}`}
        </p>
        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
          {roles.map(role => (
            <span key={role} className="text-[10px] font-medium px-1.5 py-0.5 rounded border bg-white/5 text-gray-400 border-white/10">
              {role}
            </span>
          ))}
          {show.type && (
            <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${
              show.type === 'musical'
                ? 'bg-purple-500/20 text-purple-400 border-purple-500/30'
                : 'bg-blue-500/20 text-blue-400 border-blue-500/30'
            }`}>
              {showFormatTitle(show.type)}
            </span>
          )}
          {show.isRevival && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border bg-amber-500/20 text-amber-400 border-amber-500/30">
              Revival
            </span>
          )}
          {tonyInfo && (
            <span
              className={`text-[10px] font-medium px-1.5 py-0.5 rounded border inline-flex items-center gap-0.5 ${
                tonyInfo.won
                  ? 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30'
                  : 'bg-sky-500/15 text-sky-400 border-sky-500/25'
              }`}
              title={tonyInfo.categories.join(', ')}
            >
              <TrophyIcon className="w-2.5 h-2.5" />
              {tonyInfo.won ? 'Tony Winner' : 'Tony Nom'}
            </span>
          )}
        </div>
      </div>

      {/* Score */}
      {show.score !== null ? (
        <div className={`w-10 h-10 text-sm rounded-lg ${getScoreClass(show.score)} flex items-center justify-center font-bold flex-shrink-0`}>
          {Math.round(show.score)}
        </div>
      ) : (
        <div className="w-10 h-10 text-sm rounded-lg bg-surface-overlay flex items-center justify-center text-gray-500 font-bold flex-shrink-0">
          —
        </div>
      )}
    </Link>
  );
}
