'use client';

interface ScoreBadgeProps {
  score?: number | null;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  showRing?: boolean;
}

export default function ScoreBadge({ score, size = 'md', showRing = true }: ScoreBadgeProps) {
  const sizeConfig = {
    sm: { badge: 'w-11 h-11 text-lg', ring: 'w-[52px] h-[52px]', stroke: 3 },
    md: { badge: 'w-14 h-14 text-2xl', ring: 'w-[64px] h-[64px]', stroke: 3 },
    lg: { badge: 'w-16 h-16 text-3xl', ring: 'w-[72px] h-[72px]', stroke: 4 },
    xl: { badge: 'w-20 h-20 text-4xl', ring: 'w-[88px] h-[88px]', stroke: 4 },
  };

  const { badge, ring, stroke } = sizeConfig[size];

  if (score === undefined || score === null) {
    return (
      <div className="relative flex items-center justify-center">
        <div className={`score-badge ${badge} rounded-xl score-none font-bold`}>
          —
        </div>
      </div>
    );
  }

  const roundedScore = Math.round(score);
  const isHighScore = roundedScore >= 85;

  // Determine color classes based on score
  const colorClass = roundedScore >= 70 ? 'score-high' : roundedScore >= 50 ? 'score-medium' : 'score-low';
  const ringColor = roundedScore >= 70
    ? 'stroke-emerald-500'
    : roundedScore >= 50
    ? 'stroke-amber-500'
    : 'stroke-red-500';

  // Calculate ring progress (score out of 100)
  const circumference = 2 * Math.PI * 45; // radius of 45
  const progress = (roundedScore / 100) * circumference;
  const dashOffset = circumference - progress;

  return (
    <div className="relative flex items-center justify-center">
      {/* Progress ring */}
      {showRing && (
        <svg
          className={`absolute ${ring} -rotate-90`}
          viewBox="0 0 100 100"
        >
          {/* Background ring */}
          <circle
            cx="50"
            cy="50"
            r="45"
            fill="none"
            stroke="currentColor"
            strokeWidth={stroke}
            className="text-white/10"
          />
          {/* Progress ring */}
          <circle
            cx="50"
            cy="50"
            r="45"
            fill="none"
            strokeWidth={stroke}
            strokeLinecap="round"
            className={`${ringColor} transition-all duration-500`}
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
          />
        </svg>
      )}

      {/* Score badge */}
      <div
        className={`score-badge ${badge} rounded-xl ${colorClass} font-bold relative z-10 ${
          isHighScore ? 'shadow-[0_0_20px_rgba(16,185,129,0.5)]' : ''
        }`}
      >
        {roundedScore}
      </div>
    </div>
  );
}
