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

module.exports = {
  VALID_SOURCE_TYPES,
  SOURCE_DATE_REGEX,
  normalizeSource,
  normalizeSources,
};
