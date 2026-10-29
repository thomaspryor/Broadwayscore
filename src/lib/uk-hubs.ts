// UK regional city hubs (BRO-6516) for the Beyond London city filter. Hubs and
// metros come from data/venue-metros.json, the same table that stamps `city`
// on each regional show (scripts/lib/venue-metro.js, BRO-6515).
import venueMetros from '../../data/venue-metros.json';

type Metro = { name: string; country: string; hub?: string };
const METROS = venueMetros.metros as Record<string, Metro>;
const HUBS = venueMetros.hubs as Record<string, { name: string; country: string }>;

/** Shows whose metro has no UK hub yet (Edinburgh, Birmingham, ...). */
export const OTHER_UK_HUB = 'other';

export function ukHubForCity(city?: string | null): string {
  const hub = city ? METROS[city]?.hub : undefined;
  return hub && HUBS[hub]?.country === 'UK' ? hub : OTHER_UK_HUB;
}

/** Filter pills for the hubs present, in table order, "Elsewhere" last. */
export function ukHubFilterOptions(present: Iterable<string>): { value: string; label: string }[] {
  const have = new Set(present);
  const opts = Object.entries(HUBS)
    .filter(([key, h]) => h.country === 'UK' && have.has(key))
    .map(([key, h]) => ({ value: key, label: h.name }));
  if (have.has(OTHER_UK_HUB)) opts.push({ value: OTHER_UK_HUB, label: 'Elsewhere' });
  return opts;
}
