/**
 * tm-ob-fill.js (BRO-4384): fill closingDate and runtime on an EXISTING
 * Off-Broadway show from the TheaterMania row it was matched to. Discovery used
 * TM only to add new shows, so running shows kept no closingDate/runtime.
 *
 * Rules: only a null field is filled (never overwritten); closingDate goes
 * through writeClosingDate (honours humanCorrectedClosingDate) with source
 * 'theatermania'; only a live off-broadway row, and only a closing date that
 * is today or later and not before the show's opening. The caller passes only
 * high-confidence matches.
 */
const { writeClosingDate } = require('./closing-date-guard');

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function clamp(n) { return n >= 20 && n <= 400 ? n : null; }

/** acf.run_duration (number or "90", "90 minutes", "1h 30m") to minutes, or null. */
function parseRunMinutes(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? clamp(Math.round(raw)) : null;
  const s = String(raw).toLowerCase();
  const hm = s.trim().match(/^(\d+)\s*(?:h|hr|hrs|hour|hours)\b(?:\s*(?:and\s*)?(\d+)\s*(?:m|min|mins|minute|minutes)?)?$/);
  if (hm) return clamp(Number(hm[1]) * 60 + Number(hm[2] || 0));
  // Plain "90" / "90 min(ute)s" only: ranges and "2x45" are ambiguous, so skip them.
  const m = s.trim().match(/^(\d+)\s*(?:m|min|mins|minute|minutes)?$/);
  return m ? clamp(Number(m[1])) : null;
}

/** 80 to "1h 20m", 45 to "45m", 120 to "2h" (shows.json runtime style). */
function formatRuntime(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** @returns {{closingDate?: string, runtime?: string}} fields that would be filled */
function computeTmFill(existing, candidate, today = new Date().toISOString().slice(0, 10)) {
  const out = {};
  if (!existing || !candidate) return out;
  if (existing.category !== 'off-broadway') return out;
  if (!['open', 'previews', 'upcoming'].includes(existing.status)) return out;
  const cd = candidate.closingDate;
  if (!existing.closingDate && typeof cd === 'string' && ISO.test(cd) && cd >= today &&
      !(existing.openingDate && cd < existing.openingDate)) {
    out.closingDate = cd;
  }
  const mins = parseRunMinutes(candidate.runtimeMinutes);
  if (!existing.runtime && mins) out.runtime = formatRuntime(mins);
  return out;
}

/** Applies computeTmFill to `existing` in place. Returns the fields written. */
function applyTmFill(existing, candidate, opts = {}) {
  const fill = computeTmFill(existing, candidate, opts.today);
  const written = {};
  if (fill.closingDate &&
      writeClosingDate(existing, fill.closingDate, 'theatermania', { log: opts.log, todayStr: opts.today })) {
    written.closingDate = fill.closingDate;
  }
  if (fill.runtime) { existing.runtime = fill.runtime; written.runtime = fill.runtime; }
  return written;
}

module.exports = { parseRunMinutes, formatRuntime, computeTmFill, applyTmFill };
