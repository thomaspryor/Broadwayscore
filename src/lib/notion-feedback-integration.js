/**
 * Pure mapping/validation functions for wiring the site feedback form
 * (src/components/FeedbackForm.tsx, /api/feedback) to the BWSC Roadmap
 * Notion database. Kept dependency-free and side-effect-free so it can be
 * unit-tested without a NOTION_API_KEY (Test Extraction Pattern, CLAUDE.md
 * rule 15) — src/app/api/feedback/route.ts requires this module and does
 * the actual network call via src/lib/notion-api.ts.
 */

const CATEGORY_LABELS = {
  bug: 'Bug Report',
  feature: 'Feature Request',
  'content-error': 'Content Error',
  praise: 'Praise',
  other: 'Other',
};

// Maps the form's feedback category to the Roadmap DB's Type select. Praise
// and Other don't correspond to actionable work types, so they're left
// unmapped (the property is simply omitted on the created page).
const CATEGORY_TO_TYPE = {
  bug: 'Fix',
  feature: 'New Feature',
  'content-error': 'Data Quality',
};

function truncate(str, maxLen) {
  const s = String(str || '');
  return s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s;
}

function categoryLabel(category) {
  return CATEGORY_LABELS[category] || 'Feedback';
}

function mapCategoryToType(category) {
  return CATEGORY_TO_TYPE[category] || null;
}

/** True when `body` isn't a plausible feedback payload at all (wrong shape, not a malformed field). */
function isMalformedFeedbackPayload(body) {
  return body === null || body === undefined || typeof body !== 'object' || Array.isArray(body);
}

function buildFeedbackTitle({ category, show, message }) {
  const label = categoryLabel(category);
  const showPart = show && String(show).trim() ? ` — ${truncate(show, 60)}` : '';
  const excerpt = truncate(message, 80);
  return truncate(`[${label}]${showPart} ${excerpt}`, 200);
}

function buildFeedbackNotes({ name, email, show, message, submittedAt }) {
  const lines = [
    '### Message',
    String(message || '').trim() || '_No message_',
    '',
    `### Submitted`,
    submittedAt || '_Unknown_',
  ];
  if (name && String(name).trim()) lines.push('', '### Name', String(name).trim());
  if (email && String(email).trim()) lines.push('', '### Email', String(email).trim());
  if (show && String(show).trim()) lines.push('', '### Show', String(show).trim());
  lines.push('', '---', '*Submitted via broadwayscorecard.com/feedback*');
  return lines.join('\n');
}

/**
 * Builds the Notion `properties` payload for a feedback submission page in
 * the BWSC Roadmap database (scripts/lib/notion-constants.js's
 * BRAIN_DATABASE_ID). Caller is responsible for validating required fields
 * first (see src/lib/feedback-form-validation.js's getFirstInvalidField).
 */
function buildFeedbackNotionProperties({ name, email, category, show, message, submittedAt }) {
  const properties = {
    Name: { title: [{ text: { content: buildFeedbackTitle({ category, show, message }) } }] },
    Status: { status: { name: 'Not started' } },
    Category: { select: { name: 'Product' } },
    Priority: { select: { name: 'P2 Later' } },
    Tags: { multi_select: [{ name: 'user-feedback' }] },
    Notes: { rich_text: [{ text: { content: truncate(buildFeedbackNotes({ name, email, show, message, submittedAt }), 2000) } }] },
  };
  const type = mapCategoryToType(category);
  if (type) properties.Type = { select: { name: type } };
  return properties;
}

module.exports = {
  CATEGORY_LABELS,
  CATEGORY_TO_TYPE,
  categoryLabel,
  mapCategoryToType,
  isMalformedFeedbackPayload,
  buildFeedbackTitle,
  buildFeedbackNotes,
  buildFeedbackNotionProperties,
  truncate,
};
