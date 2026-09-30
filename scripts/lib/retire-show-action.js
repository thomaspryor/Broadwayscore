/**
 * retire-show — the "delete one junk shows.json entry" action for
 * execute-approved-fix.js (BRO-4398).
 *
 * Cloud sessions cannot push the private core-data repo, and until now no
 * plan action could remove a row: the 2026-09-30 Off-West End promotion
 * wrote Kiln cinema screenings and a one-off concert that only a Mac session
 * could take out. A plan may now carry
 *   { type: 'retire-show', id, expectTitle, reason, blockTitleVenue? }
 * and CI applies it. Pure apart from the injected `retire` (default:
 * lib/retired-show-ids.js retireId, which appends the registry entry and
 * archives the full row in data/deleted-shows.json, so discovery, the
 * push-core-data reconciliation and validate-data all keep it out).
 *
 * Guardrails:
 *   - `expectTitle` must equal the row's title (compare-and-set: a wrong id
 *     in a plan refuses instead of deleting another show);
 *   - only a `provisional: true` row (an automated, not-yet-corroborated
 *     add) can be retired this way; anything else stays a local-session call;
 *   - `reason` is required (the registry breadcrumb);
 *   - `blockTitleVenue: true` for junk that must never return under any id;
 *     leave it off for a duplicate (the kept row shares title+venue).
 * The registry entry is written before the row is spliced out, so a failure
 * part-way leaves the row in place (validate-data warns) rather than a
 * deleted row the next push could resurrect.
 */

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function applyRetireShow(shows, action, { retire, now } = {}) {
  const a = action || {};
  if (typeof a.id !== 'string' || !ID_RE.test(a.id)) return { ok: false, reason: 'retire-show: id must be a lowercase-kebab show id' };
  if (typeof a.reason !== 'string' || !a.reason.trim()) return { ok: false, reason: `retire-show ${a.id}: a reason is required` };
  if (typeof a.expectTitle !== 'string' || !a.expectTitle) return { ok: false, reason: `retire-show ${a.id}: expectTitle is required (compare-and-set)` };
  if (a.blockTitleVenue !== undefined && typeof a.blockTitleVenue !== 'boolean') return { ok: false, reason: `retire-show ${a.id}: blockTitleVenue must be a boolean` };
  const idx = shows.findIndex(s => s && s.id === a.id);
  if (idx === -1) return { ok: false, reason: `retire-show: no show with id "${a.id}"` };
  const row = shows[idx];
  if (row.title !== a.expectTitle) return { ok: false, reason: `retire-show ${a.id}: title is "${row.title}", plan expected "${a.expectTitle}" — refused` };
  if (row.provisional !== true) return { ok: false, reason: `retire-show ${a.id}: only provisional (automated, uncorroborated) rows can be retired by a plan — this one needs a local session` };
  const doRetire = typeof retire === 'function' ? retire : require('./retired-show-ids').retireId;
  try {
    doRetire(a.id, { reason: a.reason.trim(), archivedRow: row, blockTitleVenue: a.blockTitleVenue === true, ...(now ? { now } : {}) });
  } catch (e) {
    return { ok: false, reason: `retire-show ${a.id}: ${e.message}` };
  }
  shows.splice(idx, 1);
  return { ok: true, msg: `retired ${a.id} ("${row.title}" @ ${row.venue})${a.blockTitleVenue ? ' — title+venue blocked' : ''}` };
}

module.exports = { applyRetireShow };
