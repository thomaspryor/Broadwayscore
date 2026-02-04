/**
 * Broadway Venue Address Lookup
 *
 * Canonical mapping of all 43 Broadway theater venues to their street addresses.
 * Used by discover-new-shows.js (auto-fill on discovery) and backfill scripts.
 *
 * Source of truth for theater addresses. When adding a new venue, add it here first.
 */

const VENUE_ADDRESSES = {
  'Al Hirschfeld Theatre': '302 W 45th St, New York, NY 10036',
  'Ambassador Theatre': '219 W 49th St, New York, NY 10019',
  'August Wilson Theatre': '245 W 52nd St, New York, NY 10019',
  'Belasco Theatre': '111 W 44th St, New York, NY 10036',
  'Bernard B. Jacobs Theatre': '242 W 45th St, New York, NY 10036',
  'Booth Theatre': '222 W 45th St, New York, NY 10036',
  'Broadhurst Theatre': '235 W 44th St, New York, NY 10036',
  'Broadway Theatre': '1681 Broadway, New York, NY 10019',
  'Brooks Atkinson Theatre': '256 W 47th St, New York, NY 10036',
  'Circle in the Square Theatre': '235 W 50th St, New York, NY 10019',
  'Ethel Barrymore Theatre': '243 W 47th St, New York, NY 10036',
  'Eugene O\'Neill Theatre': '230 W 49th St, New York, NY 10019',
  'Gerald Schoenfeld Theatre': '236 W 45th St, New York, NY 10036',
  'Gershwin Theatre': '222 W 51st St, New York, NY 10019',
  'Harold and Miriam Steinberg Center for Theatre': '111 W 46th St, New York, NY 10036',
  'Helen Hayes Theater': '240 W 44th St, New York, NY 10036',
  'Hudson Theatre': '141 W 44th St, New York, NY 10036',
  'Imperial Theatre': '249 W 45th St, New York, NY 10036',
  'James Earl Jones Theatre': '138 W 48th St, New York, NY 10036',
  'John Golden Theatre': '252 W 45th St, New York, NY 10036',
  'Lena Horne Theatre': '256 W 47th St, New York, NY 10036',
  'Longacre Theatre': '220 W 48th St, New York, NY 10036',
  'Lunt-Fontanne Theatre': '205 W 46th St, New York, NY 10036',
  'Lyceum Theatre': '149 W 45th St, New York, NY 10036',
  'Lyric Theatre': '214 W 43rd St, New York, NY 10036',
  'Majestic Theatre': '245 W 44th St, New York, NY 10036',
  'Marquis Theatre': '210 W 46th St, New York, NY 10036',
  'Minskoff Theatre': '200 W 45th St, New York, NY 10036',
  'Music Box Theatre': '239 W 45th St, New York, NY 10036',
  'Nederlander Theatre': '208 W 41st St, New York, NY 10036',
  'Neil Simon Theatre': '250 W 52nd St, New York, NY 10019',
  'New Amsterdam Theatre': '214 W 42nd St, New York, NY 10036',
  'Palace Theatre': '1568 Broadway, New York, NY 10036',
  'Richard Rodgers Theatre': '226 W 46th St, New York, NY 10036',
  'Samuel J. Friedman Theatre': '261 W 47th St, New York, NY 10036',
  'Shubert Theatre': '225 W 44th St, New York, NY 10036',
  'St. James Theatre': '246 W 44th St, New York, NY 10036',
  'Stephen Sondheim Theatre': '124 W 43rd St, New York, NY 10036',
  'Studio 54': '254 W 54th St, New York, NY 10019',
  'Todd Haimes Theatre': '227 W 42nd St, New York, NY 10036',
  'Vivian Beaumont Theater': '150 W 65th St, New York, NY 10023',
  'Walter Kerr Theatre': '219 W 48th St, New York, NY 10036',
  'Winter Garden Theatre': '1634 Broadway, New York, NY 10019',
};

/**
 * Look up the street address for a Broadway theater venue.
 *
 * @param {string} venueName - The venue name exactly as it appears in shows.json
 * @returns {string|null} The address, or null if the venue is not in the map
 */
function getTheaterAddress(venueName) {
  if (!venueName) return null;
  return VENUE_ADDRESSES[venueName] || null;
}

module.exports = { VENUE_ADDRESSES, getTheaterAddress };
