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
 *   - or the old title is an in-order subsequence of the new one and every
 *     inserted word is a function word ("Murder Cathedral" -> "Murder in the
 *     Cathedral": a slug that dropped its stopwords, BRO-5110). A content word
 *     in the insertion ("... Under the Sky") is a different title and refuses;
 *     that case belongs to the venue promoter's dated-listing completion.
 *   - or the old title is the new one plus a trailing " on Broadway" market tag (no other row has the bare title);
 *   - id and slug never change, so no redirect is needed.
 */

const { foldDiacritics } = require('./title-match');

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function words(s) {
  return foldDiacritics(String(s)).toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

// Words a venue slug drops. Deliberately short: anything with meaning is a content word.
const FUNCTION_WORDS = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'at', 'as', 'and', 'or', 'to', 'for', 'from', 'with', 'by',
  'is', 'are', 'was', 'were', 'be', 'been', 'am', 'do', 'does', 'did', 'it', 'its', 'they', 'we', 'you', 'he', 'she',
  'his', 'her', 'their', 'my', 'your', 'our', 'not', 'no', 'but']);

/** True when every old word appears in the new title in order and the extra words are all function words. */
function onlyFunctionWordsInserted(oldWords, newWords) {
  const o = oldWords.split(' ');
  const n = newWords.split(' ');
  if (n.length <= o.length) return false;
  let i = 0;
  const inserted = [];
  for (const w of n) {
    if (i < o.length && w === o[i]) i++;
    else inserted.push(w);
  }
  return i === o.length && inserted.length > 0 && inserted.every(w => FUNCTION_WORDS.has(w));
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
  // A trailing " on Broadway" is a market tag a feed appended, not part of the name
  // ("10 Things I Hate About You on Broadway"); drop it only when the rest is not
  // already another row's title. Some real titles end this way ("Oh, Hello on
  // Broadway"), so this only clears the cosmetic check: the plan still has to carry
  // expectTitle (compare-and-set) and a reason that says why the tag is not the name.
  if (o.endsWith(' on broadway') && o.slice(0, -' on broadway'.length) === n && n.split(' ').length >= 2
      && !otherTitles.some(t => words(t) === n)) return null;
  // Restoring dropped function words must not land on a title another row already holds
  // (that is a duplicate row, not a typo).
  if (o.split(' ').length >= 2 && onlyFunctionWordsInserted(o, n) && !otherTitles.some(t => words(t) === n)) return null;
  return `"${newTitle}" is not a cosmetic repair of "${oldTitle}" (only case, punctuation, a trailing slug counter, a trailing ' on Broadway' tag or dropped function words may change)`;
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
