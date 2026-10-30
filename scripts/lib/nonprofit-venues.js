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

// Fold the ways shows.json spells one building ('New York City Center – Stage I',
// 'New York City Center/Stage II') so they compare equal word by word.
function normBuilding(s) {
  return String(s || '').toLowerCase().replace(/[\u2010-\u2015\-\/@]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Companies with a house in this venue's building (BRO-6640). Looser than
 * nonprofitForVenue: a bare building name ('New York City Center') matches a
 * house inside it ('New York City Center Stage I'), so a review that names the
 * company ("Manhattan Theatre Club's production") can be recognised as the same
 * building. Prompt context only; never use it to decide whose show this is.
 * @returns {{ org: string, house: string }[]}
 */
function companiesInBuilding(venue) {
  const v = normBuilding(venue);
  if (!v) return [];
  const out = [];
  for (const [org, houses] of Object.entries(NP_VENUES)) {
    const house = houses.find(h => {
      const n = normBuilding(h);
      // a stage inside the named building, or the house with a company suffix
      return n === v || (n.startsWith(v + ' ') && /^stage\b/.test(n.slice(v.length + 1))) || v.startsWith(n + ' ');
    });
    if (house) out.push({ org, house });
  }
  return out;
}

module.exports = { NP_VENUES, venueMatches, nonprofitForVenue, companiesInBuilding };
