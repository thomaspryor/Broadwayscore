'use client';

import { useRouter } from 'next/navigation';

export function SeasonSelect({
  listType,
  seasons,
  currentSeason,
}: {
  listType: string;
  seasons: string[];
  currentSeason: string;
}) {
  const router = useRouter();

  return (
    <select
      value={currentSeason}
      onChange={(e) => {
        if (e.target.value) router.push(`/lists/${listType}/${e.target.value}`);
      }}
      aria-label="Select season"
      className={`bg-surface-overlay border border-white/10 text-sm rounded-lg px-3 py-1.5 font-medium appearance-none cursor-pointer hover:border-white/20 transition-colors focus:outline-none focus:ring-1 focus:ring-white/20 ${currentSeason ? 'text-white' : 'text-gray-400'}`}
      style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%239ca3af' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 8px center', paddingRight: '28px' }}
    >
      {!currentSeason && <option value="">By Season</option>}
      {seasons.map(s => (
        <option key={s} value={s}>{s}</option>
      ))}
    </select>
  );
}
