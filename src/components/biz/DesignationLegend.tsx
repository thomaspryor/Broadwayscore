/**
 * DesignationLegend - Visual legend explaining commercial designations
 * Reads from centralized config - auto-updates when designations change.
 * Includes the display-only "Undisclosed" label (closed TBD shows).
 */

import { getLegendEntries } from '@/config/commercial';

export default function DesignationLegend() {
  const entries = getLegendEntries();

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {entries.map((entry) => (
        <div key={entry.name} className="card p-3">
          <span className={`font-semibold ${entry.color}`}>
            {entry.name}
          </span>
          <p className="text-xs text-gray-500 mt-1">{entry.description}</p>
        </div>
      ))}
    </div>
  );
}
