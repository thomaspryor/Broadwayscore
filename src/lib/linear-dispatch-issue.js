/**
 * Pure helpers for the morning digest's signed "Fix this" tap
 * (src/app/api/autonomous-action/route.ts, action=dispatch), which files a
 * LINEAR issue (BRO-4718). It used to create a Notion card for
 * scripts/notion-action-poll.js, whose launchd job was disabled 2026-08-30,
 * so a tap silently did nothing.
 *
 * Kept dependency-free and side-effect-free so it is unit-testable without
 * LINEAR_API_KEY (CLAUDE.md rule 15); the route does the network calls.
 *
 * WHY THE DUPLICATION BELOW: the route is bundled by Next and cannot require
 * CommonJS files under scripts/. The issue body therefore re-states two
 * contracts owned by scripts/lib:
 *   - the `[conditionKey:<key>]` anchor that owner-alert-router.js writes and
 *     its findLinearDuplicate() searches for, so a tap and the automatic
 *     router land on the SAME open issue instead of filing twins;
 *   - the safe-form acceptance command from scripts/lib/health-row-check-cmd.js
 *     (rowAbsentCheckCmd / alertAbsentCheckCmd), which linear-next.js and the
 *     cloud worker need before they will dispatch a card (BRO-3881).
 * tests/unit/linear-dispatch-issue.test.mjs require()s BOTH implementations
 * and fails if they drift.
 */

const TEAM_KEY = 'BRO'; // scripts/lib/linear-client.js TEAM_KEY
const TERMINAL_STATE_TYPES = ['completed', 'canceled', 'duplicate']; // scripts/lib/linear-state-types.js
const DISPATCH_PRIORITY = 2; // Linear "High": the owner asked for this fix by tapping
const HEALTH_CHECK_PREFIX = 'health-check:';
const ROW_NAME_MATCH_LIMIT = 120;
const SAFE_TOKEN_MAX_CHARS = 200;

function rowMatchKey(name) {
  let key = String(name == null ? '' : name).trim().slice(0, ROW_NAME_MATCH_LIMIT);
  while (key && Buffer.from(key, 'utf8').toString('base64url').length > SAFE_TOKEN_MAX_CHARS) {
    key = key.slice(0, -1);
  }
  return key;
}

function b64(s) {
  return Buffer.from(rowMatchKey(s), 'utf8').toString('base64url');
}

/** Same command owner-alert-router.js puts on the issue it files for this conditionKey. */
function acceptanceCommand(conditionKey) {
  const key = String(conditionKey || '');
  if (key.startsWith(HEALTH_CHECK_PREFIX)) {
    const name = key.slice(HEALTH_CHECK_PREFIX.length).trim();
    if (name) return `node scripts/check-health-row-absent.js --row-b64 ${b64(name)}`;
  }
  return `node scripts/check-alert-condition-absent.js --key-b64 ${b64(key)}`;
}

function conditionAnchor(conditionKey) {
  return `[conditionKey:${conditionKey}]`;
}

/** Strip text that would forge a markdown heading or an acceptance VERIFY line. */
function sanitizeText(s) {
  return String(s || '')
    .replace(/`/g, "'")
    .replace(/^#+\s/gm, '')
    .replace(/VERIFY\s*:/gi, 'VERIFY -');
}

/**
 * The Linear issue a tap files. `title` and `description` come from the
 * signed link (HMAC-verified by the route), so they are the digest's own text.
 */
function buildDispatchIssue({ conditionKey, title, description }) {
  const cleanTitle = sanitizeText(title).replace(/\s+/g, ' ').trim();
  const issueTitle = (/^(fix|bsc daily)\b/i.test(cleanTitle) ? cleanTitle : `Fix: ${cleanTitle}`).slice(0, 200);
  const body = [
    '## Problem',
    'Filed by the owner tapping "Fix this" in the morning digest email.',
    '',
    `- **Title:** ${sanitizeText(title)}`,
    description ? `- **Detail:** ${sanitizeText(description)}` : null,
    '',
    '## Suggested approach',
    'Investigate the condition named above and fix the root cause.',
    '',
    '## Acceptance criteria',
    `\`${acceptanceCommand(conditionKey)}\` passes, i.e. the condition no longer fires.`,
    `Condition "${sanitizeText(conditionKey)}" no longer fires on the next check.`,
    '',
    conditionAnchor(conditionKey),
  ].filter((l) => l !== null).join('\n');
  return { title: issueTitle, description: body, priority: DISPATCH_PRIORITY };
}

/**
 * Of the open issues carrying this condition's anchor, the one every racing
 * request agrees on: earliest createdAt, then smallest id as a tie-break, so
 * the choice depends only on the candidate SET, never on result order.
 */
function pickCanonicalIssue(candidates) {
  const open = (candidates || []).filter((c) => c && c.id && !TERMINAL_STATE_TYPES.includes(c.stateType));
  if (!open.length) return null;
  return open.reduce((best, c) => {
    if (c.createdAt !== best.createdAt) return c.createdAt < best.createdAt ? c : best;
    return c.id < best.id ? c : best;
  });
}

/** The team's Todo state (type 'unstarted'), where the dispatchers look for work. */
function pickTodoState(states) {
  const list = Array.isArray(states) ? states : [];
  return list.find((s) => s && s.type === 'unstarted' && s.name === 'Todo') ||
    list.find((s) => s && s.type === 'unstarted') || null;
}

module.exports = {
  TEAM_KEY,
  TERMINAL_STATE_TYPES,
  DISPATCH_PRIORITY,
  rowMatchKey,
  acceptanceCommand,
  conditionAnchor,
  sanitizeText,
  buildDispatchIssue,
  pickCanonicalIssue,
  pickTodoState,
};
