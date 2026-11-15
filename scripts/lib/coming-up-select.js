/**
 * Which rows the weekly newsletter's "Coming Up" card shows.
 *
 * Owner rule (2026-11-15): Coming Up always includes ALL Broadway shows that
 * open in the coming week. The card used to take the 4 nearest items across
 * every market, so Off-Broadway previews pushed three Broadway openings
 * (Blue Man Group, It's a Wonderful Life, Much Ado About Nothing) off the card.
 *
 * Broadway openings dated within 7 days after the issue's week are mandatory
 * and are never cut. Everything else fills the card up to `cap` rows in date
 * order. The result is always date-sorted.
 */
const { isBroadwayCategory } = require('./venue-classification');

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * @param {Array<{show:{category:string}, eventDate:string, isPreview:boolean}>} items
 * @param {{weekEndStr:string, cap?:number}} opts
 */
function selectComingUp(items, { weekEndStr, cap = 4 }) {
  const horizon = addDays(weekEndStr, 7);
  const byDate = [...items].sort((a, b) => a.eventDate.localeCompare(b.eventDate));
  const mandatory = new Set(byDate.filter(it =>
    isBroadwayCategory(it.show) && !it.isPreview && it.eventDate > weekEndStr && it.eventDate <= horizon));
  const picked = new Set(mandatory);
  for (const it of byDate) {
    if (picked.size >= cap) break;
    picked.add(it);
  }
  return byDate.filter(it => picked.has(it));
}

module.exports = { selectComingUp };
