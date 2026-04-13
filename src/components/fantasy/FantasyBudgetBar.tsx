'use client';

interface FantasyBudgetBarProps {
  spent: number;
  budget: number;
  picksCount: number;
  teamSize: number;
}

export default function FantasyBudgetBar({ spent, budget, picksCount, teamSize }: FantasyBudgetBarProps) {
  const remaining = budget - spent;
  const percentage = Math.min((spent / budget) * 100, 100);
  const isOverBudget = spent > budget;
  const isWarning = percentage >= 90;
  const isCaution = percentage >= 70;

  const barColor = isOverBudget
    ? 'bg-red-500'
    : isWarning
    ? 'bg-red-400'
    : isCaution
    ? 'bg-yellow-400'
    : 'bg-emerald-400';

  return (
    <div className="rounded-xl bg-surface-raised/80 border border-white/10 p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm text-gray-400">Budget</span>
        <span className="text-sm text-gray-400">{picksCount}/{teamSize} picks</span>
      </div>

      {/* Progress bar */}
      <div className="h-3 bg-surface-overlay rounded-full overflow-hidden mb-2">
        <div
          className={`h-full rounded-full transition-all duration-300 ${barColor}`}
          style={{ width: `${Math.min(percentage, 100)}%` }}
        />
      </div>

      <div className="flex items-center justify-between">
        <span className={`text-lg font-bold ${isOverBudget ? 'text-red-400' : 'text-white'}`}>
          ${spent} / ${budget}
        </span>
        <span className={`text-sm font-medium ${isOverBudget ? 'text-red-400' : remaining <= 10 ? 'text-yellow-400' : 'text-emerald-400'}`}>
          {isOverBudget ? `$${spent - budget} over!` : `$${remaining} left`}
        </span>
      </div>
    </div>
  );
}
