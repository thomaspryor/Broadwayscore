/**
 * Shared helpers for normalizing commercial.json `sources[]` entries.
 *
 * Background: The LLM research scripts (deep-research-commercial.js,
 * batch-commercial-research.js, etc.) routinely emit source types that
 * the validator rejects (e.g., "other", "venue", "website"). They also
 * emit `date: null` for venue/listing pages that genuinely lack a
 * publish date.
 *
 * This module is the single place to coerce those outputs into a
 * validator-compatible shape BEFORE they land in commercial.json.
 *
 * Use it from every code path that writes `sources` to commercial.json.
 */

const VALID_SOURCE_TYPES = ['trade', 'reddit', 'sec', 'manual'];
const SOURCE_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Map unknown LLM-generated source types to the closest valid type.
 * Default is 'manual' (the catch-all for curated/researched references).
 */
const TYPE_COERCIONS = {
  other: 'manual',
  website: 'manual',
  venue: 'manual',
  press: 'trade',
  article: 'trade',
  news: 'trade',
  blog: 'trade',
  filing: 'sec',
  'sec-filing': 'sec',
  forum: 'reddit',
  social: 'reddit',
};

/**
 * Normalize a single source entry. Returns null if the entry is
 * unsalvageable (no URL).
 */
function normalizeSource(src) {
  if (!src || typeof src !== 'object') return null;
  const url = typeof src.url === 'string' ? src.url.trim() : '';
  if (!url) return null;

  // Coerce type
  let type = typeof src.type === 'string' ? src.type.toLowerCase().trim() : '';
  if (!VALID_SOURCE_TYPES.includes(type)) {
    type = TYPE_COERCIONS[type] || 'manual';
  }

  // Coerce date — keep null if invalid, preserve YYYY-MM-DD if valid.
  // Try to extract YYYY-MM-DD from longer ISO strings (e.g. "2026-04-10T09:44:10.451Z").
  let date = null;
  if (typeof src.date === 'string' && src.date.trim()) {
    const trimmed = src.date.trim();
    if (SOURCE_DATE_REGEX.test(trimmed)) {
      date = trimmed;
    } else {
      const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
      if (match) date = match[1];
    }
  }

  const normalized = { type, url, date };
  // Preserve optional excerpt if present
  if (typeof src.excerpt === 'string' && src.excerpt.trim()) {
    normalized.excerpt = src.excerpt.trim();
  }
  return normalized;
}

/**
 * Normalize an array of sources. Drops unsalvageable entries.
 */
function normalizeSources(sources) {
  if (!Array.isArray(sources)) return [];
  return sources.map(normalizeSource).filter(Boolean);
}

/**
 * Why a source URL cites nothing, or null (BRO-5264, BRO-5268):
 *   'own-site'  this site (any broadwayscorecard.com host), which republishes
 *               commercial.json, so citing it is circular;
 *   'wikipedia' a pointer to sources, not one (mirrors like wikiwand too);
 *   'homepage'  a site's front page: no path beyond /, /index.*, no query.
 * One predicate for the record check (commercial-record-checks.js) and the
 * automated-writer gate (commercial-apply-gate.js) so they cannot drift.
 */
function placeholderSourceKind(rawUrl) {
  const { isSelfUrl } = require('./commercial-self-cite');
  const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!url) return null;
  let u;
  try { u = new URL(url); } catch { return isSelfUrl(url) ? 'own-site' : null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (isSelfUrl(url)) return 'own-site';
  if (/(^|\.)(wikipedia\.org|wikiwand\.com)$/i.test(u.hostname)) return 'wikipedia';
  const bareQuery = u.search === '' || u.search === '?';
  if (bareQuery && /^\/?(index\.(html?|php|aspx?))?$/i.test(u.pathname)) return 'homepage';
  return null;
}

/**
 * Placeholder links a write ADDS: [{ idx, kind, url }] for entries of
 * `sources` whose url is a placeholder and is not already on `priorSources`.
 * Counted per trimmed URL, so a second entry reusing an old placeholder link
 * (a new claim on it) counts as added, and a whitespace change does not.
 * Shared by the record check and the automated-writer gate so the two agree.
 */
function addedPlaceholderSources(sources, priorSources) {
  const left = new Map();
  for (const s of priorSources || []) {
    if (s && typeof s.url === 'string') left.set(s.url.trim(), (left.get(s.url.trim()) || 0) + 1);
  }
  const out = [];
  (sources || []).forEach((src, idx) => {
    if (!src || typeof src.url !== 'string') return;
    const url = src.url.trim();
    const n = left.get(url) || 0;
    if (n > 0) { left.set(url, n - 1); return; }
    const kind = placeholderSourceKind(url);
    if (kind) out.push({ idx, kind, url: src.url });
  });
  return out;
}

module.exports = {
  placeholderSourceKind,
  addedPlaceholderSources,
  VALID_SOURCE_TYPES,
  SOURCE_DATE_REGEX,
  normalizeSource,
  normalizeSources,
};
