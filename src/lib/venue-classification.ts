// Official West End theatres (SOLT members / Theatreland).
// Anything NOT on this list is classified as Off-West End.
// Single source of truth: data/west-end-venues.json
import venueList from '../../data/west-end-venues.json';

const WEST_END_VENUES = new Set(venueList as string[]);

export function isOffWestEndVenue(venue?: string): boolean {
  if (!venue || venue === 'TBA') return false;
  const v = venue.trim().toLowerCase()
    .replace(/\s*\(.*\)$/, '')
    .replace(/ theatre$| theater$/, '');
  return !WEST_END_VENUES.has(v);
}
