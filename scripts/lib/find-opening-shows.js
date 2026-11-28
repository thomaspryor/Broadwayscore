/**
 * Shows the opening-night status email should track: opened within the
 * lookback window, or still in previews with an opening date that has
 * already passed. Previews shows that open in the future are NOT included
 * (they have no reviews yet and made the status email page [CRITICAL]).
 */
function findOpeningShows(shows, lookbackDays, showIdFilter, now = new Date()) {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - lookbackDays);
  cutoff.setHours(0, 0, 0, 0);

  return shows.filter(s => {
    if (showIdFilter && s.id !== showIdFilter) return false;
    if (!s.openingDate) return false;
    const d = new Date(s.openingDate);
    d.setHours(0, 0, 0, 0);
    if (d < cutoff) return false;
    if (d > now) return false;
    if (s.status === 'closed') return false;
    return true;
  }).sort((a, b) => new Date(b.openingDate) - new Date(a.openingDate));
}

module.exports = { findOpeningShows };
