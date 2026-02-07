import { getAudienceGrade } from '@/lib/data-audience';

export function formatGoldListDate(dateStr: string): string {
  const date = new Date(dateStr);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

export function RankBadge({ rank }: { rank: number }) {
  const isTop3 = rank <= 3;
  return (
    <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm flex-shrink-0 ${
      isTop3 ? 'bg-accent-gold text-gray-900' : 'bg-surface-overlay text-gray-400 border border-white/10'
    }`}>
      {rank}
    </div>
  );
}

export function ValueBadge({ displayValue, label }: { displayValue: string; label: string }) {
  return (
    <div className="flex-shrink-0 text-right">
      <div className="px-2 py-1.5 sm:px-3 sm:py-2 bg-surface-overlay border border-white/10 rounded-lg sm:rounded-xl text-center min-w-[56px]">
        <div className="text-white font-bold text-xs sm:text-sm leading-tight">{displayValue}</div>
      </div>
      <div className="text-[10px] text-gray-500 mt-0.5 text-center">{label}</div>
    </div>
  );
}

export function AudienceGradeBadge({ score }: { score: number }) {
  const grade = getAudienceGrade(score);
  return (
    <div className="flex-shrink-0 flex flex-col items-center gap-0.5">
      <div
        className={`score-badge w-11 h-11 text-lg rounded-lg font-bold${grade.grade === 'A+' ? ' audience-top-grade' : ''}`}
        style={grade.grade === 'A+' ? {} : {
          backgroundColor: grade.color,
          color: grade.textColor,
          boxShadow: `0 2px 8px ${grade.color}4d`,
        }}
        title={grade.tooltip}
      >
        {grade.grade}
      </div>
      <span className="text-[9px] font-semibold uppercase tracking-wide" style={{ color: grade.color }}>
        {grade.label}
      </span>
    </div>
  );
}
