'use strict';

function isAnnouncedPastRunCandidate(show, reviews) {
  const year = String(show?.id || '').match(/-(\d{4})$/)?.[1];
  return !!year && show.category === 'off-broadway' && show.status === 'announced' &&
    !show.previewsStartDate && !show.openingDate && !show.closingDate &&
    reviews.some(r => r.showId === show.id && !r.wrongShow && !r.wrongProduction &&
      !r.isRoundupArticle && (!r.publishDate || String(r.publishDate).slice(0, 4) === year));
}

function pastRunChanges(show, entry, today) {
  const year = String(show?.id || '').match(/-(\d{4})$/)?.[1];
  const validDate = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) &&
    !Number.isNaN(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d;
  if (!year || !entry || entry.source !== 'playbill-production-page' ||
      !validDate(today) || !validDate(entry.opening) || !validDate(entry.closing) ||
      entry.opening.slice(0, 4) !== year || entry.opening >= today || entry.closing >= today ||
      entry.closing < entry.opening || (entry.firstPreview &&
      (!validDate(entry.firstPreview) || entry.firstPreview > entry.opening))) return null;
  return [
    { field: 'openingDate', old: show.openingDate, new: entry.opening },
    { field: 'closingDate', old: show.closingDate, new: entry.closing },
    { field: 'previewsStartDate', old: show.previewsStartDate, new: entry.firstPreview || null },
    { field: 'status', old: show.status, new: 'closed' },
    { field: 'openingDateSource', old: show.openingDateSource, new: 'playbill-production-page:announced-past-run' },
  ];
}
module.exports = { isAnnouncedPastRunCandidate, pastRunChanges };
