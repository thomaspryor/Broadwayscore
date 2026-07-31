import { resolveShowFormat } from '@/lib/show-format';

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
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[10px] leading-none font-semibold uppercase tracking-wide ${colorClass}`}>
      {label}
    </span>
  );
}

// Format pill - outline style.
// Labels live in src/lib/show-format.ts so the web app, the email templates and
// the newsletter generator all agree. Do NOT reintroduce a local map here: the
// previous local copy defaulted every unknown type to PLAY, which is how 43
// `type: 'special'` shows (concerts, galas, immersive experiences) shipped
// badged as plays.
export function FormatPill({ type }: { type: string }) {
  const cfg = resolveShowFormat(type);
  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[10px] leading-none font-semibold uppercase tracking-wide border ${cfg.colorClass}`}>
      {cfg.label}
    </span>
  );
}

// Genre pill - labels non-play/musical performance types (dance/magic/comedy/
// cabaret/concert/circus) that keep their critic score but live on the Off-West
// End hub. Amber outline, distinct from the format-pill purple/blue/indigo and
// the score-tier reds. See src/lib/genre.ts for the policy.
const GENRE_PILL_CONFIG: Record<string, string> = {
  dance: 'DANCE',
  magic: 'MAGIC',
  comedy: 'COMEDY',
  cabaret: 'CABARET',
  concert: 'CONCERT',
  circus: 'CIRCUS',
};

export function GenrePill({ genre }: { genre?: string }) {
  if (!genre) return null;
  const label = GENRE_PILL_CONFIG[genre];
  if (!label) return null;
  return (
    <span className="inline-flex items-center px-2.5 py-1 rounded-full text-[10px] leading-none font-semibold uppercase tracking-wide border border-amber-500/50 text-amber-400">
      {label}
    </span>
  );
}

// Audience grade chip - small pill shown below critic score in critics mode
export function AudienceChip({ grade }: { grade: { grade: string; color: string; tooltip: string } }) {
  return (
    <div
      className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] leading-none font-bold"
      style={{ backgroundColor: `${grade.color}20`, color: grade.color }}
      title={grade.tooltip}
    >
      <span className="opacity-60">Audience:</span>
      <span>{grade.grade}</span>
    </div>
  );
}

// Category badge - for Off-Broadway and West End shows.
// Opera shows (Met Opera) suppress the badge since FormatPill already says "OPERA".
export function CategoryBadge({ category, isOpera = false }: { category?: string; isOpera?: boolean }) {
  if (isOpera) return null;
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
    'off-west-end': {
      label: 'Off-WE',
      colorClass: 'bg-white/5 text-gray-400 border border-white/10',
    },
    'regional': {
      label: 'REGIONAL',
      colorClass: 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30',
    },
  };

  const cfg = config[category];
  if (!cfg) return null;

  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[10px] leading-none font-semibold uppercase tracking-wide ${cfg.colorClass}`}>
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
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[10px] leading-none font-semibold uppercase tracking-wide ${colorClass}`}>
      {label}
    </span>
  );
}
