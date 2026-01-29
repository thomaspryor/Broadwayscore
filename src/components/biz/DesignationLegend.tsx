/**
 * DesignationLegend - Visual legend explaining commercial designations
 * Reads from centralized config - auto-updates when designations change
 */

import { getLegendDesignations } from '@/config/commercial';

export default function DesignationLegend() {
  const designations = getLegendDesignations();

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
