/**
 * Public Off-Broadway inventory, shared by the server query and closed archive.
 * Opera keeps its off-broadway category for routing but has its own /opera hub.
 * @param {{ category?: string, type?: string }} show
 */
function belongsOnOffBroadwayListing(show) {
  return show.category === 'off-broadway' && show.type !== 'opera';
}

module.exports = { belongsOnOffBroadwayListing };
