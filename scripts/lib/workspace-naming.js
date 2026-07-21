/**
 * workspace-naming — cmux workspace title convention for bsc-next-launched
 * (auto-dispatched) sessions: "🤖 <Project>·<subject>". The 🤖 glyph marks
 * "safe to ignore, reports via cards+email"; the project prefix lets the
 * owner scan the cmux sidebar at a glance instead of opening every tab
 * (owner scope-add, card #168, 2026-07-14: "I can't see Sprint 3 anywhere").
 *
 * Project inference is a best-effort heuristic over card tags/category —
 * there's no dedicated "Project" field in the Notion schema. Tune
 * PROJECT_RULES as real tag vocabulary drifts (grounded against the live
 * backlog's actual tags at write time, not guessed). Unmatched cards fall
 * back to a category default, then 'Data' (the largest single bucket).
 */

const AUTO_GLYPH = '🤖';
const PROJECTS = ['Loop', 'Biz', 'Data', 'Site', 'Infra'];

// Each rule scores independently against each individual tag (not one
// joined haystack) — a card with tags "commercial, ci-infrastructure" should
// score Biz=1/Infra=1, not have the first regex to fire anywhere in a merged
// string win outright. Ties break by array order below (a judgment call:
// Infra ranked above Biz/Data since CI/pipeline incidents that happen to
// touch commercial or review data are still infra work first).
const PROJECT_RULES = [
  { project: 'Loop', re: /\b(autonomous|nightly[- ]loop|triage[- ]queue|autonomous[- ]loop)\b/ },
  { project: 'Infra', re: /\b(infra|ci[- ]infrastructure|ci[- ]blocker|\bci\b|test[- ]suite|deploy|tooling|cookies|paywall)\b/ },
  { project: 'Biz', re: /\b(commercial|\bbiz\b|partnerships?|todaytix|recoupment|grosses|marketing)\b/ },
  { project: 'Site', re: /\b(seo|friction|rage[- ]clicks?|homepage|frontend|design[- ]system|\bux\b|mobile[- ]gate)\b/ },
  { project: 'Data', re: /\b(data[- ]quality|data[- ]integrity|scraping|scraper|pipeline|review[- ]texts?|review[- ]guards?|review[- ]recovery|ingest|dtli|bww|rebuild|gather[- ]reviews|validation|aggregator|scoring)\b/ },
];

const CATEGORY_DEFAULT = { Admin: 'Infra', Marketing: 'Biz', Partnerships: 'Biz', Product: 'Data' };

function projectOf({ tags, category, subject } = {}) {
  const tagList = String(tags || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
  const subjectLower = String(subject || '').toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const { project, re } of PROJECT_RULES) {
    // Each matching tag scores a full point (explicit signal); the subject
    // line alone is weaker evidence, so it only scores a fraction — enough
    // to break a 0-0 tie (e.g. a native task with no tags at all) but never
    // enough to outweigh an actual tag match.
    let score = tagList.reduce((n, t) => n + (re.test(t) ? 1 : 0), 0);
    if (re.test(subjectLower)) score += 0.5;
    if (score > bestScore) { bestScore = score; best = project; }
  }
  if (best) return best;
  if (category && CATEGORY_DEFAULT[category]) return CATEGORY_DEFAULT[category];
  return 'Data';
}

// Model glyphs (owner request 2026-07-20: "I've accidentally used auto-spun-up
// sessions for hard work, only to realize they're on Sonnet" — the model must
// be visible in the cmux sidebar BEFORE opening the tab). Pure emoji ON
// PURPOSE: both title matchers (workspace-mark-done hook + the duplicate-
// dispatch guard) strip leading non-letter/non-digit chars before comparing,
// so emoji are invisible to them — a text tag like "[S]" would NOT be (their
// strip regex deliberately preserves '[').
const MODEL_GLYPHS = [
  { re: /fable|mythos/i, glyph: '🧠' },
  { re: /opus/i, glyph: '🔮' },
  { re: /sonnet/i, glyph: '⚡' },
  { re: /haiku/i, glyph: '🪶' },
];

function modelGlyph(model) {
  const hit = MODEL_GLYPHS.find(({ re }) => re.test(String(model || '')));
  return hit ? hit.glyph : '';
}

// Matches bsc-next.js's existing 50-char subject truncation. model is
// optional — omitted keeps the pre-glyph title shape byte-for-byte.
function buildAutoTitle({ subject, project, model }) {
  return `${AUTO_GLYPH}${modelGlyph(model)} ${project}·${String(subject || '').slice(0, 50)}`;
}

// Strips a "<Project>·" prefix from an ALREADY glyph-cleaned title (i.e.
// after the generic leading-non-letter/non-digit strip both bsc-next.js's
// findLiveWorkspaceForTask and the workspace-mark-done hook already apply —
// that strip eats the 🤖 emoji itself, since it's not a letter/digit, so by
// the time this runs the title looks like "Data·Fix the thing", not
// "🤖 Data·Fix the thing"). Callers that haven't glyph-cleaned yet should do
// that first; this only knows about the project-prefix layer.
function stripAutoPrefix(cleanedTitle) {
  const m = new RegExp(`^(?:${PROJECTS.join('|')})·`).exec(cleanedTitle);
  return m ? cleanedTitle.slice(m[0].length) : cleanedTitle;
}

module.exports = { AUTO_GLYPH, PROJECTS, PROJECT_RULES, CATEGORY_DEFAULT, MODEL_GLYPHS, projectOf, modelGlyph, buildAutoTitle, stripAutoPrefix };
