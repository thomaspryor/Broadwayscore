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
    name: 'Fizzle',
    color: 'text-orange-400',
    description: 'Closed without recouping (~30%+ back)',
  },
  {
    name: 'Flop',
    color: 'text-red-400',
    description: 'Closed without recouping (<30% back)',
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
