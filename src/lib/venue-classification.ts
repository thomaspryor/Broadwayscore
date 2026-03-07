// Official West End theatres (SOLT members / Theatreland).
// Anything NOT on this list is classified as Off-West End.
const WEST_END_VENUES = new Set([
  'adelphi', 'aldwych', 'ambassadors', 'apollo', 'apollo victoria',
  'cambridge', 'coliseum', 'london coliseum', 'criterion', 'dominion',
  'duchess', "duke of york's", 'fortune', 'garrick', 'gielgud',
  'harold pinter', "his majesty's", "her majesty's", 'lyceum', 'lyric',
  'london palladium', "noel coward", "noël coward", 'novello', 'palace',
  'peacock', 'phoenix', 'piccadilly', 'playhouse', 'prince edward',
  'prince of wales', "queen's", 'savoy', 'shaftesbury', "st martin's",
  "st. martin's", 'sondheim', 'soho place', 'theatre royal drury lane',
  'theatre royal haymarket', 'trafalgar', 'vaudeville', 'victoria palace',
  "wyndham's", 'wyndhams', 'gillian lynne', 'london hippodrome',
  'the old vic', 'old vic',
]);

export function isOffWestEndVenue(venue?: string): boolean {
  if (!venue || venue === 'TBA') return false;
  const v = venue.trim().toLowerCase()
    .replace(/\s*\(.*\)$/, '')
    .replace(/ theatre$| theater$/, '');
  return !WEST_END_VENUES.has(v);
}
