/**
 * BRO-6923: pick the wrongProduction-flagged review files worth re-verifying
 * because the show is filed at a stage INSIDE a bigger building and the flag's
 * own reason names that building ("at the Young Vic", "National Theatre").
 * Pure: no I/O. The re-check itself is scripts/reverify-parent-building-wrongprod.js.
 */
const { parentBuildingOf } = require('./venue-aliases');
const { WRONG_PRODUCTION_CLEAR_MARKERS } = require('./review-write-guard');

function _reasonText(d) {
  const cv = (d && d.contentVerification) || {};
  return [d && d.wrongProductionReason, d && d.wrongProductionNote, cv.reasoning, cv.wrongProductionReason]
    .filter((x) => typeof x === 'string').join(' \n ');
}

function _mentions(text, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z])${esc}(?!\\s+of\\s)([^A-Za-z]|$)`, 'i').test(text);
}

/**
 * @param {object} show    shows.json entry (venue, category)
 * @param {object} record  review-texts file contents
 * @returns {{ candidate: boolean, parent?: string, why?: string }}
 */
function parentBuildingFlagCandidate(show, record) {
  const p = show && parentBuildingOf(show.venue, show.category);
  if (!p) return { candidate: false, why: 'venue is not a stage inside a bigger building' };
  if (!record || record.wrongProduction !== true) return { candidate: false, why: 'not flagged wrongProduction' };
  if (WRONG_PRODUCTION_CLEAR_MARKERS.some((k) => record[k] != null && record[k] !== false && record[k] !== '')
      || typeof record.humanReviewedWrongProduction === 'boolean') return { candidate: false, why: 'already cleared or a human reviewed the flag' };
  const text = _reasonText(record);
  const hit = p.parentNames.find((n) => _mentions(text, n));
  if (!hit) return { candidate: false, why: 'flag reason does not name the parent building' };
  return { candidate: true, parent: p.parent };
}

const DAY = 86400000;
const PRE_DAYS = 7;   // press can run ahead of the first preview
const POST_DAYS = 14; // late reviews after closing
// Reason wording saying the review is of a DIFFERENT production, not just a
// building-name mismatch. Metadata alone cannot overrule these.
const OTHER_PRODUCTION_RE = /\b(tour|touring|revival|previous|earlier|prior|original|film|movie|different|another|fiasco|anticipatory|gielgud)(?![a-z])/i;

function _ms(s) {
  const t = typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s) ? Date.parse(s.slice(0, 10)) : NaN;
  return Number.isFinite(t) ? t : NaN;
}

/**
 * BRO-6946: triage a candidate whose stored text is too short for the content
 * verifier. Metadata can NOT clear a flag (a building name in the reason is
 * often not the real defect: wrong show, TV interview, other venue), so this
 * only picks which candidates are worth fetching the full text for. 'hold' =
 * the metadata already points at a different production; leave flagged.
 * @returns {{ decision: 'fetch'|'hold', why: string }}
 */
function shortCandidateDecision(show, record) {
  if (!record || typeof record.url !== 'string' || !/^https?:\/\//.test(record.url)) return { decision: 'hold', why: 'no url to fetch' };
  const start = _ms(show && (show.previewsStartDate || show.openingDate));
  const close = _ms(show && show.closingDate);
  const pub = _ms(record.publishDate);
  if (!Number.isNaN(pub) && !Number.isNaN(start) && !Number.isNaN(close)
      && (pub < start - PRE_DAYS * DAY || pub > close + POST_DAYS * DAY)) return { decision: 'hold', why: 'publishDate outside production window' };
  const reason = _reasonText(record);
  if (OTHER_PRODUCTION_RE.test(reason)) return { decision: 'hold', why: 'flag reason describes a different production' };
  const years = (reason.match(/\b(?:19|20)\d\d\b/g) || []).map(Number);
  if (!Number.isNaN(start) && !Number.isNaN(close)) {
    const y0 = new Date(start).getUTCFullYear();
    const y1 = new Date(close).getUTCFullYear();
    if (years.some((y) => y < y0 || y > y1)) return { decision: 'hold', why: 'flag reason cites a year outside the run' };
  }
  return { decision: 'fetch', why: 'publishDate not contradicting the run; reason names only the building' };
}

module.exports = { parentBuildingFlagCandidate, shortCandidateDecision };
