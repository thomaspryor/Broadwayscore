/**
 * rage-click-summary.js — turns PostHog $rageclick rows into the RAGE CLICKS
 * section of the friction analyzer's prompt, and decides which rage-click
 * issues the model returns are backed by that data.
 *
 * Why (BRO-3657 cluster, 2026-10-12): the analyzer used to pass only
 * `page: Nx on "<el_text>"` with a ≥2-event floor. One visitor triple-clicking
 * the search box, or a lone fan on a working cast link, became a Linear card
 * that said "the specific element is not yet identified", and nobody could
 * act on it. Rows now carry the clicked tag, link and nearest id from
 * PostHog's elements_chain_* columns, and only elements rage-clicked by at
 * least MIN_RAGE_USERS distinct visitors reach the model.
 *
 * Row shape (getRageClickDetails in posthog-query.js):
 *   [page, elementText, tag, href, nearestId, count, users]
 */

const { foldDiacritics } = require('./title-match');

const MIN_RAGE_USERS = 2;

/** Dedup-key PAGE segment for a pathname, given to the model verbatim. */
function pageKeyForPath(pathname) {
  const p = String(pathname || '').split('?')[0].replace(/\/+$/, '');
  if (p === '') return 'homepage';
  if (/^\/show\/[^/]+$/.test(p)) return 'show-page';
  if (/^\/cast\/[^/]+$/.test(p)) return 'cast-page';
  return foldDiacritics(p).replace(/^\//, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
}

const clean = (v) => String(v ?? '').trim();

// A row names something when any of tag, text, link or id is non-blank. The
// filter and the description share it, so a row the filter keeps never renders
// as a bare "(unknown element)" (BRO-5261 retro-review: a link-only row did).
function hasNameableElement([, elementText, tag, href, nearestId]) {
  return [elementText, tag, href, nearestId].some((v) => clean(v) !== '');
}

function describeElement(tag, href, nearestId, elementText) {
  const [t, h, id, text] = [tag, href, nearestId, elementText].map(clean);
  const parts = [];
  if (t) parts.push(`<${t}${h ? ` href="${h}"` : ''}>`);
  else if (h) parts.push(`link to "${h}"`);
  else if (!text && !id) parts.push('(unknown element)');
  if (text) parts.push(`"${text}"`);
  if (id) parts.push(`near #${id}`);
  return parts.join(' ');
}

/**
 * Rows that clear the visitor floor, normalised to objects. Element-less rows
 * (no tag, text, link or id) are dropped: a card for "(unknown element)" names
 * nothing any session can act on (BRO-340; #229, #1203, #1204 were all this).
 */
function qualifyingRageRows(rows, minUsers = MIN_RAGE_USERS) {
  return (rows || [])
    .filter(hasNameableElement)
    .map(([page, elementText, tag, href, nearestId, n, users]) => ({
      page: page || '',
      pageKey: pageKeyForPath(page),
      element: describeElement(tag, href, nearestId, elementText),
      n: Number(n) || 0,
      users: Number(users) || 0,
    }))
    .filter((r) => r.users >= minUsers);
}

/** Prompt text for the RAGE CLICKS section, or '' when nothing qualifies. */
function summarizeRageClicks(rows, minUsers = MIN_RAGE_USERS) {
  return qualifyingRageRows(rows, minUsers)
    .map((r) => `  ${r.page} [page key: ${r.pageKey}]: ${r.n}x by ${r.users} visitors on ${r.element}`)
    .join('\n');
}

/**
 * A rage_click:* issue survives only when its evidence_key PAGE segment is the
 * page key of a qualifying row. Other issue types pass through untouched.
 */
function isBackedRageClickIssue(issue, rows, minUsers = MIN_RAGE_USERS) {
  const key = String((issue && issue.evidence_key) || '');
  if (!key.startsWith('rage_click:')) return true;
  const page = (key.split(':')[1] || '').trim().toLowerCase();
  return qualifyingRageRows(rows, minUsers).some((r) => r.pageKey === page);
}

module.exports = {
  MIN_RAGE_USERS,
  pageKeyForPath,
  describeElement,
  qualifyingRageRows,
  summarizeRageClicks,
  isBackedRageClickIssue,
};
