/**
 * retitle-show — cosmetic title repair for one shows.json row, for
 * execute-approved-fix.js (BRO-4505).
 *
 * `title` is an identity field and stays out of FEEDBACK_EDITABLE_FIELDS, so
 * slug-derived titles from the pre-Spektrix venue readers ("Richard Ii",
 * "King Lear 2" from a WordPress duplicate-slug URL) had no plan path. A plan
 * may now carry
 *   { type: 'retitle-show', id, expectTitle, newTitle, reason }
 * Guardrails:
 *   - `expectTitle` must equal the current title (compare-and-set);
 *   - the change is cosmetic only: same words ignoring case, accents and punctuation,
 *     or the old title minus one trailing single digit 2-9 (a URL-slug
 *     counter), allowed only when another row already has the bare title. A
 *     different show name refuses: that is a wrong row, not a typo;
 *   - id and slug never change, so no redirect is needed.
 */

const { foldDiacritics } = require('./title-match');

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function words(s) {
  return foldDiacritics(String(s)).toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Why oldTitle -> newTitle is not a cosmetic repair, or null when it is. */
function retitleProblem(oldTitle, newTitle, otherTitles = []) {
  if (typeof newTitle !== 'string' || !newTitle.trim() || newTitle !== newTitle.trim()) return 'newTitle must be a non-empty trimmed string';
  if (newTitle.length > 200) return 'newTitle is longer than 200 characters';
  if (newTitle === oldTitle) return 'newTitle equals the current title';
  const o = words(oldTitle);
  const n = words(newTitle);
  if (!n) return 'newTitle has no letters or digits';
  if (o === n) return null;
  // A slug counter is a single digit 2-9 ("King Lear 2") and only exists
  // because another row already had the bare title. A number that is part of
  // the name ("Cloud 9", "Room 101", "A Doll's House, Part 2") has no such
  // twin, so it is never dropped this way.
  if (/ [2-9]$/.test(o) && o.slice(0, -2) === n
      && !/ (part|chapter|act|vol|volume|book|series|season)$/.test(n)
      && otherTitles.some(t => words(t) === n)) return null;
  return `"${newTitle}" is not a cosmetic repair of "${oldTitle}" (only case, punctuation or a trailing slug counter may change)`;
}

function applyRetitleShow(shows, action) {
  const a = action || {};
  if (typeof a.id !== 'string' || !ID_RE.test(a.id)) return { ok: false, reason: 'retitle-show: id must be a lowercase-kebab show id' };
  if (typeof a.reason !== 'string' || !a.reason.trim()) return { ok: false, reason: `retitle-show ${a.id}: a reason is required` };
  if (typeof a.expectTitle !== 'string' || !a.expectTitle) return { ok: false, reason: `retitle-show ${a.id}: expectTitle is required (compare-and-set)` };
  const row = shows.find(s => s && s.id === a.id);
  if (!row) return { ok: false, reason: `retitle-show: no show with id "${a.id}"` };
  if (row.title !== a.expectTitle) return { ok: false, reason: `retitle-show ${a.id}: title is "${row.title}", plan expected "${a.expectTitle}" — refused` };
  const others = shows.filter(s => s && s.id !== row.id).map(s => s.title);
  const why = retitleProblem(row.title, a.newTitle, others);
  if (why) return { ok: false, reason: `retitle-show ${a.id}: ${why}` };
  row.title = a.newTitle;
  return { ok: true, msg: `retitled ${a.id}: "${a.expectTitle}" -> "${a.newTitle}"` };
}

module.exports = { applyRetitleShow, retitleProblem };
