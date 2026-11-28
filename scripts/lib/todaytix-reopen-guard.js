/**
 * todaytix-reopen-guard.js
 *
 * Decides whether a TodayTix `/api/v2/shows` listing is positive evidence
 * that a show is actually bookable — not just present-with-matching-title in
 * the bulk feed.
 *
 * Why this exists (BRO-4286): update-show-status.js's "wrongly-closed show"
 * self-heal reopened my-joy-is-heavy-off-broadway-2025 on 2026-09-06 because
 * TodayTix's bulk feed still listed its todaytixId+title 16 hours after we'd
 * correctly closed it. TodayTix kept a stale, unpurged "ghost listing" in its
 * catalog for ~15 days post-closing (closingDatetime:null, empty showtimes) —
 * presence alone is not proof of an active run.
 */

/**
 * @param {object} ttShow - a show object from TodayTix's /api/v2/shows feed
 * @param {Date} [now] - reference date for bookingEndDate comparisons (testability)
 * @returns {boolean} true if ttShow carries positive evidence of bookability
 */
function hasBookableEvidence(ttShow, now = new Date()) {
  if (!ttShow) return false;

  if (ttShow.areRegularTicketsAvailable === true) return true;

  // Check both arrays independently — `a || b` would pick a present-but-empty
  // filteredShowtimeMaps over a non-empty showtimes, silently discarding it.
  const showtimeArrays = [ttShow.filteredShowtimeMaps, ttShow.showtimes].filter(Array.isArray);
  if (showtimeArrays.some(arr => arr.length > 0)) return true;

  // Compare as 'YYYY-MM-DD' strings (TodayTix's native format) rather than
  // Date objects — parsing a date-only string as UTC then truncating with
  // local setHours() shifts the result a day in negative-UTC-offset zones.
  if (typeof ttShow.bookingEndDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(ttShow.bookingEndDate)) {
    const todayStr = now.toISOString().slice(0, 10);
    if (ttShow.bookingEndDate.slice(0, 10) >= todayStr) return true;
  }

  return false;
}

/**
 * The fields hasBookableEvidence() reads. This is an INFERRED allowlist: it was
 * built from one observed ghost-listing shape (my-joy-is-heavy, BRO-4286), not
 * from TodayTix documentation. If TodayTix signals bookability through another
 * field (lottery-only, rush-only, a renamed field) the guard returns a false
 * negative and a genuinely reopened show stays closed (BRO-4524). Blocked
 * reopens therefore record any other bookability-looking field they carry.
 */
const KNOWN_BOOKABILITY_FIELDS = ['areRegularTicketsAvailable', 'filteredShowtimeMaps', 'showtimes', 'bookingEndDate'];
const BOOKABILITY_LIKE = /avail|book|ticket|lottery|rush|showtime|perform|onsale|on_sale/i;

/**
 * Keys on a TodayTix show that look like bookability signals but are not read
 * by hasBookableEvidence(), with their values (truncated), so a human or audit
 * can tell whether the allowlist is missing a real signal.
 * @returns {Object<string, string>}
 */
function unrecognizedBookabilityFields(ttShow) {
  const out = {};
  if (!ttShow || typeof ttShow !== 'object') return out;
  for (const key of Object.keys(ttShow)) {
    if (KNOWN_BOOKABILITY_FIELDS.includes(key) || !BOOKABILITY_LIKE.test(key)) continue;
    const v = ttShow[key];
    if (v === null || v === undefined || v === false || v === 0 || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    let str;
    try { str = JSON.stringify(v); } catch (e) { str = String(v); }
    out[key] = String(str).slice(0, 80);
  }
  return out;
}

/**
 * One record per blocked TodayTix reopen, so it surfaces in the run summary and
 * GitHub outputs instead of only a console.log (BRO-4524).
 * @param {object} closedShow - our shows.json entry
 * @param {object} ttShow - TodayTix feed show
 * @param {'no-bookable-evidence'|'human-corrected-closing-date'} reason
 */
function buildBlockedReopenRecord(closedShow, ttShow, reason) {
  return {
    id: closedShow.id,
    title: closedShow.title,
    todaytixId: ttShow.id,
    reason,
    areRegularTicketsAvailable: ttShow.areRegularTicketsAvailable,
    bookingEndDate: ttShow.bookingEndDate || null,
    unrecognizedBookabilityFields: unrecognizedBookabilityFields(ttShow),
  };
}

/** Markdown for $GITHUB_STEP_SUMMARY; '' when nothing was blocked. */
function formatBlockedReopensSummary(records) {
  if (!records || records.length === 0) return '';
  const lines = ['### TodayTix blocked reopens', '',
    'TodayTix lists these closed shows but the reopen guard kept them closed. If a show is really running, check the unrecognized fields column (the guard allowlist is inferred, BRO-4524).', '',
    '| Show | Reason | Unrecognized bookability fields |', '|---|---|---|'];
  for (const r of records) {
    const extra = Object.entries(r.unrecognizedBookabilityFields).map(([k, v]) => `${k}=${v}`).join('; ') || 'none';
    lines.push(`| ${r.id} | ${r.reason} | ${extra.replace(/\|/g, '/')} |`);
  }
  return lines.join('\n') + '\n';
}

module.exports = {
  hasBookableEvidence, unrecognizedBookabilityFields, buildBlockedReopenRecord,
  formatBlockedReopensSummary, KNOWN_BOOKABILITY_FIELDS,
};
