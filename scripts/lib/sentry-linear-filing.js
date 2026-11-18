'use strict';
/**
 * Files a real Sentry error as a Linear card (BRO-5593). Sentry triage used to
 * file GitHub issues, where nobody looks: #1026 sat open 8 days until the owner
 * forwarded the weekly digest. The board is Linear, so findings go there,
 * through the one creation chokepoint (linear-issue-create.js).
 *
 * Dedupe: every card carries a `sentry-issue: sentry-<id>` line. A card with
 * that line in ANY state (closed and archived too, as the old GitHub search
 * did) means the Sentry issue is already tracked, so it is never refiled every
 * 6 hours. Exception (BRO-7722): when every matching card is closed and Sentry
 * has seen the error AFTER the last one closed, the fix did not hold, so one
 * new "regression" card is filed (it is then the open match). The lookup is fail-closed: a failed search throws, and the caller
 * skips filing rather than risk a duplicate (BRO-5565).
 */

const MARKER_PREFIX = 'sentry-issue: sentry-';
const LOOKUP_SINCE = '2020-01-01T00:00:00.000Z';
const SOURCE = 'sentry-triage';
// Storm guard: a Sentry burst (up to 100 issues per fetch) files at most this
// many new cards per 6-hour run; the rest are filed on later runs.
const MAX_NEW_CARDS_PER_RUN = 5;

function markerLine(sentryId) {
  return `${MARKER_PREFIX}${sentryId}`;
}

// Exact match: Linear's `contains` filter would let sentry-12 match sentry-123.
function hasMarker(description, sentryId) {
  const esc = String(sentryId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${MARKER_PREFIX}${esc}\\s*$`, 'm').test(String(description || ''));
}

// The regression test a worker writes for this card; also its VERIFY (BRO-7722:
// cards without a safe VERIFY are never picked by the cloud worker, so the
// first Sentry cards sat in Todo). Digits only: Sentry ids are numeric.
function regressionTestPath(sentryId) {
  const id = String(sentryId || '').replace(/\D/g, '');
  if (!id) throw new Error(`sentry-linear-filing: non-numeric Sentry id ${JSON.stringify(sentryId)}`);
  return `tests/unit/sentry-${id}.test.mjs`;
}

const LOW_FREQUENCY_PARK = 'Low-frequency Sentry error (1-2 events, 1 user): wait for it to recur before spending a worker session';

function buildSentryCard(issue, classification, org) {
  const sentryLink = issue.permalink || `https://sentry.io/organizations/${org}/issues/${issue.id}/`;
  const lowFrequency = !!(classification && classification.lowFrequency);
  const description = [
    `A real error reported by Sentry on the live site${lowFrequency ? ' (low frequency)' : ''}.`,
    '',
    `Error: ${issue.title}`,
    `Culprit: ${issue.culprit || 'Unknown'}`,
    `First seen: ${issue.firstSeen}`,
    `Events: ${issue.count} | Users affected: ${issue.userCount}`,
    `Sentry link: ${sentryLink}`,
    '',
    'What to do: open the Sentry link, find the cause in the code and fix it, then resolve the issue in Sentry. If it is noise (browser extension, injected script, bot), teach scripts/lib/sentry-triage-classify.js to ignore it instead.',
    '',
    '## Acceptance criteria',
    `- \`${regressionTestPath(issue.id)}\` exists and passes. It fails with the fix reverted: either it reproduces the error path and asserts the fixed behaviour, or (if this is noise) it feeds this issue's real event shape to classifyIssue() and asserts noise.`,
    '- The Sentry issue is resolved after the fix is live.',
    '',
    `VERIFY: node --test ${regressionTestPath(issue.id)}`,
    '',
    `Classification: ${(classification && classification.reason) || 'unknown'}`,
    markerLine(issue.id),
  ].join('\n');
  return {
    title: `Sentry error: ${String(issue.title || 'unknown error').substring(0, 80)}`,
    description,
    priority: lowFrequency ? 4 : 3,
  };
}

async function findSentryCards(sentryId, { listIssuesByProvenance }) {
  const found = await listIssuesByProvenance({ since: LOOKUP_SINCE, descriptionMarkers: [markerLine(sentryId)] });
  return (found || []).filter((i) => hasMarker(i.description, sentryId));
}

async function findExistingSentryCard(sentryId, deps) {
  return (await findSentryCards(sentryId, deps))[0] || null;
}

const CLOSED_TYPES = new Set(['completed', 'canceled']);
function closedAtMs(card) {
  const t = Date.parse(card.completedAt || card.canceledAt || '');
  return Number.isFinite(t) ? t : null;
}

// Pure: given the marker-matched cards and the Sentry issue, is this a
// regression (all closed, event seen after the latest close)? Returns the
// latest closed card, or null. A closed card with no close time never counts.
function regressionOf(cards, issue) {
  if (!cards.length) return null;
  if (cards.some((c) => !CLOSED_TYPES.has(c.state && c.state.type))) return null;
  const lastSeen = Date.parse(issue.lastSeen || '');
  if (!Number.isFinite(lastSeen)) return null;
  const closes = cards.map((c) => ({ c, t: closedAtMs(c) }));
  if (closes.some((x) => x.t == null)) return null;
  const latest = closes.reduce((a, b) => (b.t > a.t ? b : a));
  return lastSeen > latest.t ? latest.c : null;
}

/**
 * Returns { action: 'existing' | 'filed' | 'deferred' | 'skipped', card?, reason? }.
 * 'deferred' (canCreate false: the per-run cap is spent) is filed on a later run.
 * 'skipped' means the issue is NOT tracked (lookup or create failed); the
 * caller must treat it as a failure, never as success.
 */
async function fileSentryIssue({ issue, classification, org, canCreate = true }, { listIssuesByProvenance, createLinearIssue }) {
  let cards;
  try {
    cards = await findSentryCards(issue.id, { listIssuesByProvenance });
  } catch (e) {
    return { action: 'skipped', reason: `could not check for an existing Linear card (${e.message}); not filing a possible duplicate` };
  }
  const regressed = regressionOf(cards, issue);
  if (cards.length && !regressed) return { action: 'existing', card: cards[0] };
  if (!canCreate) return { action: 'deferred', reason: `per-run cap of ${MAX_NEW_CARDS_PER_RUN} new cards reached; filed on a later run` };
  const card = buildSentryCard(issue, classification, org);
  if (regressed) {
    card.title = `Sentry regression: ${String(issue.title || 'unknown error').substring(0, 75)}`;
    card.description = `REGRESSION: ${regressed.identifier} was closed but Sentry saw this error again at ${issue.lastSeen}. The earlier fix did not hold.\n\n${card.description}`;
  }
  try {
    // Dedupe is the marker lookup above; the title near-match rule is opted
    // out because distinct Sentry errors share most title words.
    const { issue: created } = await createLinearIssue({
      ...card,
      // One-off quirks (1-2 events, 1 user) go on the board parked, not
      // dispatched to a paid worker session (BRO-7722). createLinearIssue needs
      // exactly one of dispatch/park/self.
      ...(classification && classification.lowFrequency ? { park: LOW_FREQUENCY_PARK } : { dispatch: true }),
      source: SOURCE, dedupeOptOut: 'sentry-triage' });
    return { action: 'filed', card: created };
  } catch (e) {
    return { action: 'skipped', reason: `could not file the Linear card (${e && e.message})` };
  }
}

module.exports = { regressionOf, LOW_FREQUENCY_PARK, regressionTestPath, MAX_NEW_CARDS_PER_RUN, markerLine, hasMarker, buildSentryCard, findExistingSentryCard, fileSentryIssue, SOURCE };
