'use strict';

/**
 * Houses each nonprofit uses (BRO-5776). One map for the record check
 * (commercial-record-checks.js) and stub enrollment (commercial-enrollment.js)
 * so advice the enrollment prints can never fail validation. shows.json spells
 * some venues two ways ('Hayes Theater', 'Vivian Beaumont Theater - Lincoln
 * Center Theater'), so matching also accepts a '<house> - <company>' suffix.
 */
const NP_VENUES = {
  'Lincoln Center Theater': ['Vivian Beaumont Theater', 'Mitzi E. Newhouse Theater', 'Claire Tow Theater'],
  'Manhattan Theatre Club': ['Samuel J. Friedman Theatre', 'New York City Center Stage I', 'New York City Center Stage II'],
  'Roundabout Theatre Company': ['Todd Haimes Theatre', 'American Airlines Theatre', 'Stephen Sondheim Theatre', 'Studio 54', 'Laura Pels Theatre', 'Harold and Miriam Steinberg Center for Theatre'],
  'Second Stage Theater': ['Helen Hayes Theater', 'Hayes Theater', 'Tony Kiser Theater'],
  // 'The Public Theater' venue field is the building name; specific room names
  // (Newman/Anspacher/Martinson/LuEsther/Shiva) appear in title metadata but
  // not as venue strings in shows.json.
  'The Public Theater': ['The Public Theater', 'Newman Theater', 'Anspacher Theater', 'Martinson Hall', 'LuEsther Hall', 'Shiva Theater'],
  // Off-Broadway nonprofit venues added 2026-05-24 backfill.
  'New York Theatre Workshop': ['New York Theatre Workshop'],
  'Atlantic Theater Company': ['Atlantic Theater Company', 'Linda Gross Theater', 'Atlantic Stage 2'],
  'MCC Theater': ['MCC Theater', 'Newman Mills Theater', 'The Lucille Lortel Theatre'],
  'Vineyard Theatre': ['Vineyard Theatre'],
  'Signature Theatre': ['Signature Theatre', 'Romulus Linney Courtyard Theatre', 'Irene Diamond Stage', 'Alice Griffin Jewel Box Theatre'],
  'Playwrights Horizons': ['Playwrights Horizons', 'Mainstage Theater', 'Peter Jay Sharp Theater'],
};

function venueMatches(allowed, venue) {
  return !!venue && allowed.some(v => venue === v || venue.startsWith(v + ' - '));
}

/** The nonprofit whose house this venue is, or null. */
function nonprofitForVenue(venue) {
  for (const [org, houses] of Object.entries(NP_VENUES)) if (venueMatches(houses, venue)) return org;
  return null;
}

module.exports = { NP_VENUES, venueMatches, nonprofitForVenue };
