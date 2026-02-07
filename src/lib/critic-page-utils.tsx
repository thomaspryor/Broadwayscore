// Shared utilities for critic & outlet page client components
// Pure functions + small UI components — no server-only imports

export function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

export function ordinalSuffix(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function getScoreClass(score: number): string {
  const r = Math.round(score);
  if (r >= 85) return 'score-must-see';
  if (r >= 75) return 'score-great';
  if (r >= 65) return 'score-good';
  if (r >= 55) return 'score-tepid';
  return 'score-skip';
}

export function getScoreTextColor(score: number): string {
  const r = Math.round(score);
  if (r >= 85) return '#FFD700';
  if (r >= 75) return '#22c55e';
  if (r >= 65) return '#14b8a6';
  if (r >= 55) return '#f59e0b';
  return '#ef4444';
}

export function formatDate(parsedDate: number | null): string {
  if (!parsedDate) return '';
  return new Date(parsedDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function TierBadge({ tier }: { tier: 1 | 2 | 3 }) {
  const cls = tier === 1
    ? 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'
    : tier === 2
    ? 'bg-blue-500/20 text-blue-400 border-blue-500/30'
    : 'bg-gray-500/20 text-gray-400 border-gray-500/30';
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded border ${cls}`}>
      Tier {tier}
    </span>
  );
}

export function TierBadgeSmall({ tier }: { tier: 1 | 2 | 3 }) {
  const cls = tier === 1
    ? 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'
    : tier === 2
    ? 'bg-blue-500/20 text-blue-400 border-blue-500/30'
    : 'bg-gray-500/20 text-gray-400 border-gray-500/30';
  return (
    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${cls}`}>
      T{tier}
    </span>
  );
}
