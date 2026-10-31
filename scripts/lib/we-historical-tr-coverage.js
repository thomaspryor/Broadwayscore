/**
 * BRO-6097: per-show Theatre Record coverage for the West End historical
 * shows. Pure: shows + reviews + the extractor's probe file -> report.
 *
 * Per show: `listed` (reviews TR carries for the picked production, after the
 * extractor's guards), `held` (of those, already in our review texts) and
 * `counted` (scored reviews in reviews.json). A show with no TR match carries
 * the reason. Only gaps with no reason are "unexplained".
 */
const { WE_HISTORICAL_DISCOVERY_SOURCES } = require('./we-historical-corroboration.js');
const SCANNED_ONLY_CHARS = 200; // pdftotext yield below this = image-only issue

// "2016-17", "2016-2017" and "2016-17..2021-22" -> inclusive start-year range
function parseSeasonRange(spec) {
  const m = String(spec || '').match(/^(\d{4})-(?:\d{2}|\d{4})(?:\.\.(\d{4})-(?:\d{2}|\d{4}))?$/);
  if (!m) return null;
  return { from: Number(m[1]), to: Number(m[2] || m[1]) };
}

function seasonStartYear(season) {
  const m = String(season || '').match(/^(\d{4})-/);
  return m ? Number(m[1]) : null;
}

const isScored = r => typeof r.assignedScore === 'number' && Number.isFinite(r.assignedScore);

/** Why a show has no usable TR match, or null when TR produced a production. */
function noMatchReason(p) {
  if (p.outcome === 'not-in-shows-json') return 'not-in-shows-json';
  if (p.outcome === 'search-miss') return 'search-miss';
  if (p.outcome === 'title-mismatch') return 'title-mismatch';
  if (p.outcome === 'no-production-in-window') return 'tour-or-regional-only';
  return null;
}

function classifyShow(show, probe, counted) {
  const base = { id: show.id, season: show.season, counted, listed: null, held: null };
  const p = probe && probe.shows && probe.shows[show.id];
  if (!p) return { ...base, status: 'unexplained', reason: 'not-probed' };

  const miss = noMatchReason(p);
  if (miss) return { ...base, status: 'explained', reason: miss };
  if (p.outcome === 'error') return { ...base, status: 'unexplained', reason: `error: ${p.error || 'unknown'}` };

  if (p.pdf && p.pdf.failed) return { ...base, status: 'unexplained', reason: `pdf-${p.pdf.failed}` };
  if (p.pdf && typeof p.pdf.layoutChars === 'number' && p.pdf.layoutChars <= SCANNED_ONLY_CHARS) {
    return { ...base, status: 'explained', reason: 'scanned-only' };
  }
  if (p.outcome !== 'picked') return { ...base, status: 'unexplained', reason: `outcome:${p.outcome || 'none'}` };

  const listed = Number.isFinite(p.listed) ? p.listed : 0;
  const held = Number.isFinite(p.skippedExisting) ? p.skippedExisting : 0;
  const row = { ...base, listed, held };
  if (listed === 0) {
    // PDF text came through but no review did, or the page was not a PDF and
    // listed nothing: either way TR has content we did not read.
    return { ...row, status: 'unexplained', reason: p.pdf ? 'parser-yielded-zero' : 'listed-zero' };
  }
  const missing = Number.isFinite(p.saved) ? p.saved : Math.max(listed - held, 0);
  if (missing > 0) return { ...row, status: 'unexplained', reason: `${missing}-listed-not-held` };
  return { ...row, status: 'ok', reason: null };
}

function buildCoverage({ shows, reviews, probe, range }) {
  const byShow = new Map();
  for (const r of reviews) if (isScored(r)) byShow.set(r.showId, (byShow.get(r.showId) || 0) + 1);
  const rows = shows
    .filter(s => WE_HISTORICAL_DISCOVERY_SOURCES.has(s.discoverySource))
    .filter(s => {
      const y = seasonStartYear(s.season);
      return y !== null && (!range || (y >= range.from && y <= range.to));
    })
    .map(s => classifyShow(s, probe, byShow.get(s.id) || 0));
  const unexplained = rows.filter(r => r.status === 'unexplained');
  return { rows, unexplained, ok: unexplained.length === 0 };
}

module.exports = { parseSeasonRange, seasonStartYear, classifyShow, buildCoverage, WE_HISTORICAL_DISCOVERY_SOURCES, SCANNED_ONLY_CHARS };
