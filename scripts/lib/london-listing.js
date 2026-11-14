// London archive membership, the script-side mirror of belongsOnWestEndListing()
// and belongsOnOffWestEndHub() in src/lib/genre.ts. Opera (ENO, Royal Opera
// House) is never West End or Off-West End theatre: it has its own section and
// /opera, as Met opera is kept off Off-Broadway (scripts/lib/off-broadway-listing.js).
const { isNonTheatricalGenre } = require('./genre-classification');

function isLondonCategory(category) {
  return category === 'west-end' || category === 'off-west-end';
}

/** @param {{ category?: string, type?: string, genre?: string|null }} show */
function belongsOnWestEndArchive(show) {
  return show.type !== 'opera' && isLondonCategory(show.category) && !isNonTheatricalGenre(show.genre);
}

/** @param {{ category?: string, type?: string, genre?: string|null }} show */
function belongsOnOffWestEndArchive(show) {
  return show.type !== 'opera' && (show.category === 'off-west-end' ||
    (isNonTheatricalGenre(show.genre) && isLondonCategory(show.category)));
}

module.exports = { belongsOnWestEndArchive, belongsOnOffWestEndArchive, isLondonCategory };
