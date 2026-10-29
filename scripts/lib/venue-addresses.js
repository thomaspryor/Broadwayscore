/**
 * Theater Venue Address Lookup
 *
 * Canonical mapping of theater venues to their street addresses: the 43
 * Broadway houses, plus known UK regional feeder venues (data/uk-regional-
 * venues.json — RSC Stratford, Chichester Festival Theatre) so
 * generateShowSchema's schema.org output can emit a real UK address (and
 * therefore addressCountry: GB via toPostalAddress in src/lib/seo.ts,
 * card #1451) instead of falling back to no address at all.
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

  // UK regional feeder venues (data/uk-regional-venues.json). Two keys per
  // venue since show.venue's exact format varies by discovery source — the
  // bare name, and the "name, city" form already live in shows.json for
  // game-of-thrones-the-mad-king-regional-2026.
  'Royal Shakespeare Theatre': 'Royal Shakespeare Theatre, Waterside, Stratford-upon-Avon, Warwickshire CV37 6BB',
  'Royal Shakespeare Theatre, Stratford-upon-Avon': 'Royal Shakespeare Theatre, Waterside, Stratford-upon-Avon, Warwickshire CV37 6BB',
  'Chichester Festival Theatre': 'Chichester Festival Theatre, Oaklands Park, Chichester, West Sussex PO19 6AP',
  'Chichester Festival Theatre, Chichester': 'Chichester Festival Theatre, Oaklands Park, Chichester, West Sussex PO19 6AP',
  'Royal Exchange Theatre': 'Royal Exchange Theatre, St Ann\'s Square, Manchester M2 7DH',
  'Royal Exchange Theatre, Manchester': 'Royal Exchange Theatre, St Ann\'s Square, Manchester M2 7DH',
  'Crucible Theatre': 'Crucible Theatre, 55 Norfolk Street, Sheffield S1 1DA',
  'Crucible Theatre, Sheffield': 'Crucible Theatre, 55 Norfolk Street, Sheffield S1 1DA',
  'Leeds Playhouse': 'Leeds Playhouse, Playhouse Square, Quarry Hill, Leeds LS2 7UP',
  'Leeds Playhouse, Leeds': 'Leeds Playhouse, Playhouse Square, Quarry Hill, Leeds LS2 7UP',
  'Bristol Old Vic': 'Bristol Old Vic, King Street, Bristol BS1 4ED',
  'Bristol Old Vic, Bristol': 'Bristol Old Vic, King Street, Bristol BS1 4ED',
  'Birmingham Rep': 'Birmingham Rep, Centenary Square, Broad Street, Birmingham B1 2EP',
  'Birmingham Rep, Birmingham': 'Birmingham Rep, Centenary Square, Broad Street, Birmingham B1 2EP',
  'Nottingham Playhouse': 'Nottingham Playhouse, Wellington Circus, Nottingham NG1 5AF',
  'Nottingham Playhouse, Nottingham': 'Nottingham Playhouse, Wellington Circus, Nottingham NG1 5AF',
  'Liverpool Everyman': 'Liverpool Everyman, 5-9 Hope Street, Liverpool L1 9BH',
  'Liverpool Everyman, Liverpool': 'Liverpool Everyman, 5-9 Hope Street, Liverpool L1 9BH',
  'Royal Lyceum Theatre': 'Royal Lyceum Theatre, 30B Grindlay Street, Edinburgh EH3 9AX',
  'Royal Lyceum Theatre, Edinburgh': 'Royal Lyceum Theatre, 30B Grindlay Street, Edinburgh EH3 9AX',
  'Citizens Theatre': 'Citizens Theatre, 119 Gorbals Street, Glasgow G5 9DS',
  'Citizens Theatre, Glasgow': 'Citizens Theatre, 119 Gorbals Street, Glasgow G5 9DS',
  // BRO-6516 hub houses (addresses from each venue's own site; HOME and the
  // Lowry street lines from Wikipedia, postcode unconfirmed so omitted).
  'HOME Manchester': 'HOME, First Street, Manchester',
  'HOME Manchester, Manchester': 'HOME, First Street, Manchester',
  'The Lowry': 'The Lowry, Salford Quays, Salford',
  'The Lowry, Salford': 'The Lowry, Salford Quays, Salford',
  'Octagon Theatre Bolton': 'Octagon Theatre, Howell Croft South, Bolton BL1 1SB',
  'Octagon Theatre Bolton, Bolton': 'Octagon Theatre, Howell Croft South, Bolton BL1 1SB',
  'Hope Mill Theatre': 'Hope Mill Theatre, 113 Pollard Street, Manchester M4 7JA',
  'Hope Mill Theatre, Manchester': 'Hope Mill Theatre, 113 Pollard Street, Manchester M4 7JA',
  'Sheffield Lyceum Theatre': 'Lyceum Theatre, 55 Norfolk Street, Sheffield S1 1DA',
  'Sheffield Lyceum Theatre, Sheffield': 'Lyceum Theatre, 55 Norfolk Street, Sheffield S1 1DA',
  'Sheffield Playhouse': 'Sheffield Playhouse, 55 Norfolk Street, Sheffield S1 1DA',
  'Sheffield Playhouse, Sheffield': 'Sheffield Playhouse, 55 Norfolk Street, Sheffield S1 1DA',
  'York Theatre Royal': 'York Theatre Royal, St Leonard\'s Place, York YO1 7HD',
  'York Theatre Royal, York': 'York Theatre Royal, St Leonard\'s Place, York YO1 7HD',
  'Stephen Joseph Theatre': 'Stephen Joseph Theatre, Westborough, Scarborough, North Yorkshire YO11 1JW',
  'Stephen Joseph Theatre, Scarborough': 'Stephen Joseph Theatre, Westborough, Scarborough, North Yorkshire YO11 1JW',
  'Hull Truck Theatre': 'Hull Truck Theatre, 50 Ferensway, Hull HU2 8LB',
  'Hull Truck Theatre, Hull': 'Hull Truck Theatre, 50 Ferensway, Hull HU2 8LB',
  'Tobacco Factory Theatres': 'Tobacco Factory Theatres, Raleigh Road, Southville, Bristol BS3 1TF',
  'Tobacco Factory Theatres, Bristol': 'Tobacco Factory Theatres, Raleigh Road, Southville, Bristol BS3 1TF',
  'Theatre Royal Bath': 'Theatre Royal Bath, Sawclose, Bath BA1 1ET',
  'Theatre Royal Bath, Bath': 'Theatre Royal Bath, Sawclose, Bath BA1 1ET',
  'Tron Theatre': 'Tron Theatre, 63 Trongate, Glasgow G1 5HB',
  'Tron Theatre, Glasgow': 'Tron Theatre, 63 Trongate, Glasgow G1 5HB',
  'Aviva Studios': 'Aviva Studios, Water Street, Manchester M3 4JQ',
  'Aviva Studios, Manchester': 'Aviva Studios, Water Street, Manchester M3 4JQ',
  'Òran Mór': 'Òran Mór, 731-735 Great Western Road, Glasgow G12 8QX',
  'Òran Mór, Glasgow': 'Òran Mór, 731-735 Great Western Road, Glasgow G12 8QX',
  'Tramway': 'Tramway, 25 Albert Drive, Glasgow G41 2PE',
  'Tramway, Glasgow': 'Tramway, 25 Albert Drive, Glasgow G41 2PE',
  'The Wardrobe Theatre': 'The Wardrobe Theatre, The Old Market Assembly, 25 West Street, Old Market, Bristol BS2 0DF',
  'The Wardrobe Theatre, Bristol': 'The Wardrobe Theatre, The Old Market Assembly, 25 West Street, Old Market, Bristol BS2 0DF',
  'Wardrobe Theatre, Bristol': 'The Wardrobe Theatre, The Old Market Assembly, 25 West Street, Old Market, Bristol BS2 0DF',
  // Theatre Royal Bath's studios: the Ustinov's door is on Monmouth Street, the Egg's on St John's Place (theatreroyal.org.uk getting-here).
  'Ustinov, Bath': 'Ustinov Studio, Theatre Royal Bath, Monmouth Street, Bath BA1 1ET',
  'Egg Theatre, Bath': "The Egg, Theatre Royal Bath, St John's Place, Bath BA1 1ET",
  '53two': '53two, Arch 19, Watson Street, Manchester M3 4LP',
  '53two, Manchester': '53two, Arch 19, Watson Street, Manchester M3 4LP',
  'Dundee Rep': 'Dundee Rep, Tay Square, Dundee DD1 1PB',
  'Dundee Rep, Dundee': 'Dundee Rep, Tay Square, Dundee DD1 1PB',
  'Pitlochry Festival Theatre': 'Pitlochry Festival Theatre, Port-Na-Craig, Pitlochry PH16 5DR',
  'Pitlochry Festival Theatre, Pitlochry': 'Pitlochry Festival Theatre, Port-Na-Craig, Pitlochry PH16 5DR',
  'Liverpool Playhouse': 'Liverpool Playhouse, Williamson Square, Liverpool L1 1EL',
  'Liverpool Playhouse, Liverpool': 'Liverpool Playhouse, Williamson Square, Liverpool L1 1EL',
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
