// Status pill - subtle background with accent color
export function StatusBadge({ status }: { status: string }) {
  const label = {
    open: 'NOW PLAYING',
    closed: 'CLOSED',
    previews: 'IN PREVIEWS',
    upcoming: 'UPCOMING',
    announced: 'ANNOUNCED',
  }[status] || status.toUpperCase();

  const colorClass = {
    open: 'bg-emerald-500/15 text-emerald-400',
    closed: 'bg-gray-500/15 text-gray-400',
    previews: 'bg-purple-500/15 text-purple-400',
    upcoming: 'bg-blue-500/15 text-blue-400',
    announced: 'bg-blue-500/15 text-blue-400',
  }[status] || 'bg-gray-500/15 text-gray-400';

  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wide ${colorClass}`}>
      {label}
    </span>
  );
}

// Format pill - outline style
export function FormatPill({ type }: { type: string }) {
  const isMusical = type === 'musical';
  const label = isMusical ? 'MUSICAL' : 'PLAY';
  const colorClass = isMusical
    ? 'border-purple-500/50 text-purple-400'
    : 'border-blue-500/50 text-blue-400';

  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wide border ${colorClass}`}>
      {label}
    </span>
  );
}

// Audience grade chip - small pill shown below critic score in critics mode
export function AudienceChip({ grade }: { grade: { grade: string; color: string; tooltip: string } }) {
  return (
    <div
      className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold"
      style={{ backgroundColor: `${grade.color}20`, color: grade.color }}
      title={grade.tooltip}
    >
      <span className="opacity-60">Audience:</span>
      <span>{grade.grade}</span>
    </div>
  );
}

// Category badge - for Off-Broadway and West End shows
export function CategoryBadge({ category }: { category?: string }) {
  if (!category || category === 'broadway') return null;

  const config: Record<string, { label: string; colorClass: string }> = {
    'off-broadway': {
      label: 'OFF-BROADWAY',
      colorClass: 'bg-indigo-500/15 text-indigo-400 border border-indigo-500/30',
    },
    'west-end': {
      label: 'WEST END',
      colorClass: 'bg-teal-500/15 text-teal-400 border border-teal-500/30',
    },
  };

  const cfg = config[category];
  if (!cfg) return null;

  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wide ${cfg.colorClass}`}>
      {cfg.label}
    </span>
  );
}

// Production pill - solid muted fill
export function ProductionPill({ isRevival }: { isRevival: boolean }) {
  const label = isRevival ? 'REVIVAL' : 'ORIGINAL';
  const colorClass = isRevival
    ? 'bg-gray-500/20 text-gray-400'
    : 'bg-amber-500/20 text-amber-400';

  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wide ${colorClass}`}>
      {label}
    </span>
  );
}
