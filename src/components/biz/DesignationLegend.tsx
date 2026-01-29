/**
 * DesignationLegend - Visual legend explaining commercial designations
 * Sprint 2, Task 2.7
 */

const designations = [
  {
    name: 'Miracle',
    color: 'text-yellow-400',
    description: 'Long-running mega-hit, extraordinary returns',
  },
  {
    name: 'Windfall',
    color: 'text-emerald-400',
    description: 'Solid hit, recouped and profitable',
  },
  {
    name: 'Easy Winner',
    color: 'text-lime-400',
    description: 'Limited run that recouped quickly',
  },
  {
    name: 'Trickle',
    color: 'text-cyan-400',
    description: 'Broke even or modest profit',
  },
  {
    name: 'Fizzle',
    color: 'text-orange-400',
    description: 'Closed without recouping (~30%+ back)',
  },
  {
    name: 'Flop',
    color: 'text-red-400',
    description: 'Closed without recouping (<30% back)',
  },
  {
    name: 'Nonprofit',
    color: 'text-blue-400',
    description: 'Nonprofit production (LCT, Roundabout, etc.)',
  },
  {
    name: 'Tour Stop',
    color: 'text-slate-400',
    description: 'National tour engagement on Broadway',
  },
];

export default function DesignationLegend() {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {designations.map((designation) => (
        <div key={designation.name} className="card p-3">
          <span className={`font-semibold ${designation.color}`}>
            {designation.name}
          </span>
          <p className="text-xs text-gray-500 mt-1">{designation.description}</p>
        </div>
      ))}
    </div>
  );
}
