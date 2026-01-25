'use client';

import { useState } from 'react';
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

// Chevron icon for expand/collapse
function ChevronIcon({ expanded, className }: { expanded: boolean; className?: string }) {
  return (
    <svg
      className={`${className} transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      width="16"
      height="16"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
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

// Category importance order - most prestigious first
const TONY_CATEGORY_ORDER = [
  'Best Musical',
  'Best Play',
  'Best Revival of a Musical',
  'Best Revival of a Play',
  'Best Book of a Musical',
  'Best Original Score',
  'Best Actor in a Musical',
  'Best Actress in a Musical',
  'Best Actor in a Play',
  'Best Actress in a Play',
  'Best Direction of a Musical',
  'Best Direction of a Play',
  'Best Featured Actor in a Musical',
  'Best Featured Actress in a Musical',
  'Best Featured Actor in a Play',
  'Best Featured Actress in a Play',
  'Best Choreography',
  'Best Orchestrations',
  'Best Scenic Design',
  'Best Scenic Design of a Musical',
  'Best Scenic Design of a Play',
  'Best Costume Design',
  'Best Costume Design of a Musical',
  'Best Costume Design of a Play',
  'Best Lighting Design',
  'Best Lighting Design of a Musical',
  'Best Lighting Design of a Play',
  'Best Sound Design',
  'Best Sound Design of a Musical',
  'Best Sound Design of a Play',
];

// Sort awards by importance
function sortByImportance(items: string[]): string[] {
  return [...items].sort((a, b) => {
    const aIndex = TONY_CATEGORY_ORDER.indexOf(a);
    const bIndex = TONY_CATEGORY_ORDER.indexOf(b);
    const aOrder = aIndex === -1 ? 999 : aIndex;
    const bOrder = bIndex === -1 ? 999 : bIndex;
    return aOrder - bOrder;
  });
}

// Check if category is a "major" award (top-tier)
function isMajorCategory(category: string): boolean {
  const majorCategories = [
    'Best Musical',
    'Best Play',
    'Best Revival of a Musical',
    'Best Revival of a Play',
    'Best Book of a Musical',
    'Best Original Score',
    'Best Actor in a Musical',
    'Best Actress in a Musical',
    'Best Actor in a Play',
    'Best Actress in a Play',
    'Best Direction of a Musical',
    'Best Direction of a Play',
  ];
  return majorCategories.includes(category);
}

// Designation config with better labels
const DESIGNATION_CONFIG: Record<AwardsDesignation, {
  label: string;
  sublabel: string;
  bgClass: string;
  textClass: string;
  borderClass: string;
}> = {
  'sweeper': {
    label: 'Awards Sweeper',
    sublabel: 'Dominated the Tony Awards',
    bgClass: 'bg-gradient-to-r from-amber-500/20 to-yellow-500/20',
    textClass: 'text-amber-400',
    borderClass: 'border-amber-500/30',
  },
  'lavished': {
    label: 'Award Darling',
    sublabel: 'Multiple Tony wins',
    bgClass: 'bg-gradient-to-r from-violet-500/15 to-purple-500/15',
    textClass: 'text-violet-400',
    borderClass: 'border-violet-500/30',
  },
  'recognized': {
    label: 'Award Winner',
    sublabel: 'Tony winner',
    bgClass: 'bg-emerald-500/10',
    textClass: 'text-emerald-400',
    borderClass: 'border-emerald-500/20',
  },
  'nominated': {
    label: 'Tony Nominated',
    sublabel: 'Nominated for Tony Awards',
    bgClass: 'bg-blue-500/10',
    textClass: 'text-blue-400',
    borderClass: 'border-blue-500/20',
  },
  'shut-out': {
    label: 'No Nominations',
    sublabel: 'Eligible but not nominated',
    bgClass: 'bg-gray-500/10',
    textClass: 'text-gray-400',
    borderClass: 'border-gray-500/20',
  },
  'pre-season': {
    label: 'Awaiting Eligibility',
    sublabel: 'Not yet eligible for awards',
    bgClass: 'bg-gray-700/30',
    textClass: 'text-gray-500',
    borderClass: 'border-gray-600/20',
  },
};

// Combined Tony Awards item (win or nomination)
interface TonyItem {
  category: string;
  isWin: boolean;
}

// Combined expandable section for Tony wins and nominations
function TonyExpandableSection({
  wins,
  nominations,
  defaultExpanded = false
}: {
  wins: string[];
  nominations: string[];
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  // Combine and sort - wins first, then nominations, both sorted by importance
  const sortedWins = sortByImportance(wins);
  const sortedNoms = sortByImportance(nominations);

  const items: TonyItem[] = [
    ...sortedWins.map(cat => ({ category: cat, isWin: true })),
    ...sortedNoms.map(cat => ({ category: cat, isWin: false })),
  ];

  if (items.length === 0) return null;

  const totalCount = items.length;

  return (
    <div className="border-t border-white/5 pt-3 mt-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between text-left group"
      >
        <span className="text-sm font-medium text-gray-300">
          See all categories ({totalCount})
        </span>
        <ChevronIcon expanded={expanded} className="text-gray-500 group-hover:text-gray-400" />
      </button>

      {expanded && (
        <ul className="mt-3 space-y-2">
          {items.map((item, idx) => (
            <li key={idx} className="flex items-center gap-2 text-sm">
              {item.isWin ? (
                <TrophyIcon className="text-amber-400 flex-shrink-0" />
              ) : (
                <StarIcon className="text-gray-500 flex-shrink-0" />
              )}
              <span className={
                item.isWin
                  ? (isMajorCategory(item.category) ? 'text-white font-medium' : 'text-amber-200')
                  : (isMajorCategory(item.category) ? 'text-gray-300' : 'text-gray-500')
              }>
                {item.category}
              </span>
              {item.isWin && (
                <span className="text-[10px] uppercase tracking-wide text-amber-400/70 font-semibold">Won</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Expandable section for Other Major Awards
function OtherAwardsExpandableSection({ awards }: { awards: ShowAwards }) {
  const [expanded, setExpanded] = useState(false);

  const dramaDeskWins = awards.dramadesk?.wins || [];
  const occWins = awards.outerCriticsCircle?.wins || [];
  const dramaLeagueWins = awards.dramaLeague?.wins || [];

  const hasAwards = dramaDeskWins.length > 0 || occWins.length > 0 || dramaLeagueWins.length > 0;

  if (!hasAwards) return null;

  const totalCount = dramaDeskWins.length + occWins.length + dramaLeagueWins.length;

  return (
    <div className="mt-4 pt-4 border-t border-white/5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between text-left group"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 uppercase tracking-wide font-medium">
            Other Major Awards
          </span>
          <span className="text-xs text-gray-600">({totalCount} wins)</span>
        </div>
        <ChevronIcon expanded={expanded} className="text-gray-500 group-hover:text-gray-400" />
      </button>

      {/* Summary badges - always visible */}
      <div className="flex flex-wrap gap-2 mt-2">
        {dramaDeskWins.length > 0 && (
          <span className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-purple-500/10 text-purple-400 text-xs font-medium border border-purple-500/20">
            <TrophyIcon className="w-3.5 h-3.5" />
            {dramaDeskWins.length} Drama Desk
          </span>
        )}
        {occWins.length > 0 && (
          <span className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-cyan-500/10 text-cyan-400 text-xs font-medium border border-cyan-500/20">
            <TrophyIcon className="w-3.5 h-3.5" />
            {occWins.length} Outer Critics
          </span>
        )}
        {dramaLeagueWins.length > 0 && (
          <span className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-teal-500/10 text-teal-400 text-xs font-medium border border-teal-500/20">
            <TrophyIcon className="w-3.5 h-3.5" />
            {dramaLeagueWins.length} Drama League
          </span>
        )}
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="mt-3 space-y-3">
          {dramaDeskWins.length > 0 && (
            <div>
              <div className="text-xs text-purple-400 font-medium mb-1.5">Drama Desk Awards</div>
              <ul className="space-y-1 pl-4">
                {dramaDeskWins.map((win, idx) => (
                  <li key={idx} className="flex items-center gap-2 text-sm text-gray-400">
                    <TrophyIcon className="w-3 h-3 text-purple-400 flex-shrink-0" />
                    {win}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {occWins.length > 0 && (
            <div>
              <div className="text-xs text-cyan-400 font-medium mb-1.5">Outer Critics Circle Awards</div>
              <ul className="space-y-1 pl-4">
                {occWins.map((win, idx) => (
                  <li key={idx} className="flex items-center gap-2 text-sm text-gray-400">
                    <TrophyIcon className="w-3 h-3 text-cyan-400 flex-shrink-0" />
                    {win}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {dramaLeagueWins.length > 0 && (
            <div>
              <div className="text-xs text-teal-400 font-medium mb-1.5">Drama League Awards</div>
              <ul className="space-y-1 pl-4">
                {dramaLeagueWins.map((win, idx) => (
                  <li key={idx} className="flex items-center gap-2 text-sm text-gray-400">
                    <TrophyIcon className="w-3 h-3 text-teal-400 flex-shrink-0" />
                    {win}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function AwardsCard({ showId, awards }: AwardsCardProps) {
  const designation = getAwardsDesignation(showId);
  const tonyWins = getTonyWinCount(showId);
  const tonyNoms = getTonyNominationCount(showId);
  const hasPulitzer = !!awards?.pulitzer;
  const config = DESIGNATION_CONFIG[designation];

  // Get wins and nominations lists
  const tonyWinsList = awards?.tony?.wins || [];
  const tonyNominatedFor = awards?.tony?.nominatedFor || [];
  // Nominations that aren't wins
  const tonyNominationsOnly = tonyNominatedFor.filter(nom => !tonyWinsList.includes(nom));

  // Don't show card if pre-season with no data
  if (designation === 'pre-season' && !awards?.tony?.note) {
    return (
      <div className="card p-5 sm:p-6 mb-8">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-4">Awards Scorecard</h2>
        <div className="text-center py-4">
          <div className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg border ${config.bgClass} ${config.borderClass}`}>
            <span className={`text-base font-semibold ${config.textClass}`}>{config.label}</span>
          </div>
          <p className="text-gray-500 text-sm mt-3">
            This show has not yet been eligible for major awards.
          </p>
        </div>
      </div>
    );
  }

  // Get Tony season for display
  const tonySeason = awards?.tony?.season;
  const tonyCeremony = awards?.tony?.ceremony;

  // Build sublabel based on actual data
  let dynamicSublabel = config.sublabel;
  if (designation === 'sweeper' && tonyWinsList.length > 0) {
    const topWin = sortByImportance(tonyWinsList)[0];
    dynamicSublabel = `Won ${topWin} + ${tonyWins - 1} more`;
  } else if (designation === 'lavished' && tonyWinsList.length > 0) {
    dynamicSublabel = `${tonyWins} Tony wins`;
  } else if (designation === 'recognized' && tonyWinsList.length > 0) {
    const topWin = sortByImportance(tonyWinsList)[0];
    dynamicSublabel = `Won ${topWin}`;
  } else if (designation === 'nominated' && tonyNoms > 0) {
    dynamicSublabel = `${tonyNoms} Tony nomination${tonyNoms > 1 ? 's' : ''}`;
  }

  return (
    <div className="card p-5 sm:p-6 mb-8">
      <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-4">Awards Scorecard</h2>

      {/* Main Designation Badge - More prominent */}
      <div className={`rounded-xl p-4 border mb-4 ${config.bgClass} ${config.borderClass}`}>
        <div className="flex items-center gap-3">
          {tonyWins > 0 && <TrophyIcon className={`${config.textClass} w-6 h-6`} />}
          {tonyWins === 0 && tonyNoms > 0 && <StarIcon className={`${config.textClass} w-5 h-5`} />}
          {tonyWins === 0 && tonyNoms === 0 && (
            <div className={`w-5 h-5 rounded-full border-2 ${config.borderClass}`} />
          )}
          <div>
            <div className={`text-lg font-bold ${config.textClass}`}>{config.label}</div>
            <div className="text-sm text-gray-400">{dynamicSublabel}</div>
          </div>
        </div>
      </div>

      {/* Pulitzer Special Callout */}
      {hasPulitzer && awards?.pulitzer && (
        <div className="bg-gradient-to-r from-amber-500/10 to-yellow-500/10 rounded-lg p-3 border border-amber-500/20 mb-4">
          <div className="flex items-center gap-2">
            <PulitzerIcon className="text-amber-400" />
            <span className="text-amber-300 font-medium">
              Pulitzer Prize for Drama ({awards.pulitzer.year})
            </span>
          </div>
        </div>
      )}

      {/* Tony Stats Summary */}
      {(tonyWins > 0 || tonyNoms > 0) && (
        <div className="bg-surface-overlay rounded-xl p-4 border border-white/5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs text-gray-500 uppercase tracking-wide font-medium">
              Tony Awards {tonySeason && `(${tonySeason})`}
            </span>
            {tonyCeremony && (
              <span className="text-xs text-gray-600">{tonyCeremony} Ceremony</span>
            )}
          </div>

          {/* Win/Nom counts */}
          <div className="flex flex-wrap gap-4">
            {tonyWins > 0 && (
              <div className="flex items-center gap-1.5">
                <TrophyIcon className="text-amber-400" />
                <span className="text-white font-bold text-lg">{tonyWins}</span>
                <span className="text-gray-400 text-sm">Win{tonyWins !== 1 ? 's' : ''}</span>
              </div>
            )}
            {tonyNominationsOnly.length > 0 && (
              <div className="flex items-center gap-1.5">
                <StarIcon className="text-gray-400" />
                <span className="text-white font-bold text-lg">{tonyNominationsOnly.length}</span>
                <span className="text-gray-400 text-sm">Other Nomination{tonyNominationsOnly.length !== 1 ? 's' : ''}</span>
              </div>
            )}
          </div>

          {/* Combined expandable section for all Tony categories */}
          <TonyExpandableSection
            wins={tonyWinsList}
            nominations={tonyNominationsOnly}
            defaultExpanded={tonyWinsList.length + tonyNominationsOnly.length <= 5}
          />
        </div>
      )}

      {/* Other Major Awards - Expandable */}
      {awards && <OtherAwardsExpandableSection awards={awards} />}
    </div>
  );
}
