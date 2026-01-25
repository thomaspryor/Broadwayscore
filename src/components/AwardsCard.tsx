'use client';

import {
  ShowAwards,
  AwardsDesignation,
  getAwardsDesignation,
  getTonyWinCount,
  getTonyNominationCount,
} from '@/lib/data';

interface AwardsCardProps {
  showId: string;
  awards: ShowAwards | undefined;
}

// Trophy icon for wins
function TrophyIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
      <path d="M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94A5.01 5.01 0 0011 15.9V19H7v2h10v-2h-4v-3.1a5.01 5.01 0 003.61-2.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z"/>
    </svg>
  );
}

// Star icon for nominations
function StarIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
    </svg>
  );
}

// Book/Pulitzer icon
function PulitzerIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
      <path d="M18 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 4h5v8l-2.5-1.5L6 12V4z"/>
    </svg>
  );
}

// Designation badge colors and labels
const DESIGNATION_CONFIG: Record<AwardsDesignation, { label: string; bgClass: string; textClass: string; borderClass: string }> = {
  'pulitzer-winner': {
    label: 'Pulitzer Winner',
    bgClass: 'bg-gradient-to-r from-amber-500/20 to-yellow-500/20',
    textClass: 'text-amber-400',
    borderClass: 'border-amber-500/30',
  },
  'lavished': {
    label: 'Award Darling',
    bgClass: 'bg-gradient-to-r from-violet-500/15 to-purple-500/15',
    textClass: 'text-violet-400',
    borderClass: 'border-violet-500/30',
  },
  'recognized': {
    label: 'Recognized',
    bgClass: 'bg-emerald-500/10',
    textClass: 'text-emerald-400',
    borderClass: 'border-emerald-500/20',
  },
  'nominated': {
    label: 'Nominated',
    bgClass: 'bg-blue-500/10',
    textClass: 'text-blue-400',
    borderClass: 'border-blue-500/20',
  },
  'shut-out': {
    label: 'Overlooked',
    bgClass: 'bg-gray-500/10',
    textClass: 'text-gray-400',
    borderClass: 'border-gray-500/20',
  },
  'pre-season': {
    label: 'Awaiting Eligibility',
    bgClass: 'bg-gray-700/30',
    textClass: 'text-gray-500',
    borderClass: 'border-gray-600/20',
  },
};

interface AwardsBadgeProps {
  designation: AwardsDesignation;
  tonyWins: number;
  tonyNoms: number;
  hasPulitzer: boolean;
}

function AwardsBadge({ designation, tonyWins, tonyNoms, hasPulitzer }: AwardsBadgeProps) {
  const config = DESIGNATION_CONFIG[designation];

  return (
    <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full border ${config.bgClass} ${config.borderClass}`}>
      {hasPulitzer && <PulitzerIcon className="text-amber-400" />}
      {!hasPulitzer && tonyWins > 0 && <TrophyIcon className={config.textClass} />}
      {!hasPulitzer && tonyWins === 0 && tonyNoms > 0 && <StarIcon className={config.textClass} />}
      <span className={`text-sm font-semibold ${config.textClass}`}>{config.label}</span>
    </div>
  );
}

interface TonyStatProps {
  value: number;
  label: string;
  icon: 'trophy' | 'star';
}

function TonyStat({ value, label, icon }: TonyStatProps) {
  if (value === 0) return null;

  return (
    <div className="flex items-center gap-1.5">
      {icon === 'trophy' ? (
        <TrophyIcon className="text-amber-400" />
      ) : (
        <StarIcon className="text-gray-400" />
      )}
      <span className="text-white font-bold">{value}</span>
      <span className="text-gray-400 text-sm">{label}</span>
    </div>
  );
}

export default function AwardsCard({ showId, awards }: AwardsCardProps) {
  const designation = getAwardsDesignation(showId);
  const tonyWins = getTonyWinCount(showId);
  const tonyNoms = getTonyNominationCount(showId);
  const hasPulitzer = !!awards?.pulitzer;

  // Don't show card if pre-season with no data
  if (designation === 'pre-season' && !awards?.tony?.note) {
    return (
      <div className="card p-5 sm:p-6 mb-8">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-4">Awards</h2>
        <div className="text-center py-4">
          <AwardsBadge designation={designation} tonyWins={0} tonyNoms={0} hasPulitzer={false} />
          <p className="text-gray-500 text-sm mt-3">
            This show has not yet been eligible for major awards.
          </p>
        </div>
      </div>
    );
  }

  // Get notable wins for display
  const notableWins: string[] = [];
  if (awards?.tony?.wins) {
    // Prioritize the big categories
    const bigCategories = ['Best Musical', 'Best Play', 'Best Revival of a Musical', 'Best Revival of a Play'];
    for (const category of bigCategories) {
      if (awards.tony.wins.includes(category)) {
        notableWins.push(`Tony: ${category}`);
      }
    }
  }
  if (awards?.pulitzer) {
    notableWins.unshift(`Pulitzer Prize for Drama (${awards.pulitzer.year})`);
  }

  // Get Tony season for display
  const tonySeason = awards?.tony?.season;
  const tonyCeremony = awards?.tony?.ceremony;

  return (
    <div className="card p-5 sm:p-6 mb-8">
      <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-4">Awards</h2>

      {/* Designation Badge */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <AwardsBadge
          designation={designation}
          tonyWins={tonyWins}
          tonyNoms={tonyNoms}
          hasPulitzer={hasPulitzer}
        />
      </div>

      {/* Tony Stats */}
      {(tonyWins > 0 || tonyNoms > 0) && (
        <div className="bg-surface-overlay rounded-xl p-4 border border-white/5 mb-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs text-gray-500 uppercase tracking-wide font-medium">
              Tony Awards {tonySeason && `(${tonySeason})`}
            </span>
            {tonyCeremony && (
              <span className="text-xs text-gray-600">{tonyCeremony} Ceremony</span>
            )}
          </div>
          <div className="flex flex-wrap gap-4">
            <TonyStat value={tonyWins} label="Wins" icon="trophy" />
            <TonyStat value={tonyNoms - tonyWins} label="Other Nominations" icon="star" />
          </div>
        </div>
      )}

      {/* Notable Wins */}
      {notableWins.length > 0 && (
        <div className="space-y-2">
          <span className="text-xs text-gray-500 uppercase tracking-wide font-medium">Notable Wins</span>
          <ul className="space-y-1.5">
            {notableWins.slice(0, 4).map((win, idx) => (
              <li key={idx} className="flex items-center gap-2 text-sm">
                <TrophyIcon className="text-amber-400 flex-shrink-0" />
                <span className="text-gray-300">{win}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Other Awards Summary */}
      {(awards?.dramadesk?.wins?.length || awards?.outerCriticsCircle?.wins?.length || awards?.dramaLeague?.wins?.length) && (
        <div className="mt-4 pt-4 border-t border-white/5">
          <span className="text-xs text-gray-500 uppercase tracking-wide font-medium">Other Major Awards</span>
          <div className="flex flex-wrap gap-2 mt-2">
            {awards.dramadesk?.wins && awards.dramadesk.wins.length > 0 && (
              <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-purple-500/10 text-purple-400 text-xs border border-purple-500/20">
                <TrophyIcon className="w-3 h-3" />
                {awards.dramadesk.wins.length} Drama Desk
              </span>
            )}
            {awards.outerCriticsCircle?.wins && awards.outerCriticsCircle.wins.length > 0 && (
              <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-cyan-500/10 text-cyan-400 text-xs border border-cyan-500/20">
                <TrophyIcon className="w-3 h-3" />
                {awards.outerCriticsCircle.wins.length} Outer Critics
              </span>
            )}
            {awards.dramaLeague?.wins && awards.dramaLeague.wins.length > 0 && (
              <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-teal-500/10 text-teal-400 text-xs border border-teal-500/20">
                <TrophyIcon className="w-3 h-3" />
                {awards.dramaLeague.wins.length} Drama League
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
