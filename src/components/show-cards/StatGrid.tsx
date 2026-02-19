interface Stat {
  label: string;
  value: string | number;
  color?: string;
  dimmed?: boolean;
  subtitle?: string;
}

export function StatGrid({ stats, className }: { stats: Stat[]; className?: string }) {
  return (
    <div className={`grid grid-cols-2 sm:grid-cols-4 gap-3${className ? ` ${className}` : ''}`}>
      {stats.map(stat => (
        <div key={stat.label} className="card p-4 text-center">
          <p className="text-gray-500 text-xs uppercase tracking-wider mb-2">{stat.label}</p>
          <p
            className={`text-2xl font-bold ${stat.dimmed ? 'text-gray-500' : 'text-white'}`}
            style={stat.color ? { color: stat.color } : undefined}
          >
            {stat.value}
          </p>
          {stat.subtitle && (
            <p className="text-[10px] text-gray-500 truncate mt-1">{stat.subtitle}</p>
          )}
        </div>
      ))}
    </div>
  );
}
