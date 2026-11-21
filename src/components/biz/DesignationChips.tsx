/**
 * DesignationChips - the headline verdicts as a row of colored chips near the
 * top of /biz, mirroring the /biz share card. Styles come from the central
 * designation config; each chip jumps to the full Designation Guide.
 */

import { DESIGNATION_MAP } from '@/config/commercial';

const HEADLINE_DESIGNATIONS = ['Miracle', 'Windfall', 'Easy Winner', 'Trickle', 'Fizzle', 'Flop'] as const; // recouped-list-ok: headline chips, not a recouped test

export const DESIGNATION_GUIDE_ID = 'designation-guide';

export default function DesignationChips() {
  return (
    <ul role="list" className="flex flex-wrap gap-2 mt-5 max-w-3xl" aria-label="Show verdicts" data-testid="biz-designation-chips">
      {HEADLINE_DESIGNATIONS.map((name) => {
        const config = DESIGNATION_MAP[name];
        if (!config) return null;
        return (
          <li key={name}>
            <a
              href={`#${DESIGNATION_GUIDE_ID}`}
              title={config.description}
              aria-label={`${name}: see the Designation Guide`}
              className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold ${config.bgClass} ${config.borderClass} ${config.color} hover:brightness-125 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70 transition`}
            >
              <span aria-hidden="true" className="h-2 w-2 rounded-full bg-current" />
              {name}
            </a>
          </li>
        );
      })}
    </ul>
  );
}
