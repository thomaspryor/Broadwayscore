'use strict';

/**
 * Pure helpers for the scheduled-workflow coverage gate in
 * audit-cron-health-coverage.js.
 *
 * Every scheduled (cron) workflow must be EITHER monitored in check-cron-health.yml's
 * CRITICAL_CRONS (real-time paging) OR listed in .cron-health-exempt.txt (digest-only /
 * low-stakes). A scheduled workflow in NEITHER has zero monitoring and can die silently —
 * the gap that hid process-feedback.yml being disabled for 15 days (2026-06-11..26).
 */

// Does a workflow YAML body declare a scheduled (cron) trigger?
// Strips comment-only lines first so a commented `# - cron: ...` under a live `schedule:`
// key isn't mistaken for a trigger. Matches a list-item cron with ANY value (quoted OR
// unquoted) — an unquoted-but-valid cron (`cron: 30 5 1,15 * *`) must NOT evade the gate.
function isScheduledWorkflow(yamlText) {
  if (!yamlText) return false;
  const body = String(yamlText)
    .split('\n')
    .filter(line => !line.trim().startsWith('#'))
    .join('\n');
  return /^\s*schedule:/m.test(body) && /-\s*cron:\s*\S/.test(body);
}

// Parse a .cron-health-exempt.txt body into a Set of workflow filenames.
// One filename per line; `#` comments and blank lines ignored; trailing whitespace trimmed.
function parseExemptList(text) {
  const out = new Set();
  for (const raw of (text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    out.add(line);
  }
  return out;
}

/**
 * Scheduled workflows covered by neither CRITICAL_CRONS nor the exempt list.
 * @param {string[]} scheduled - filenames of workflows with a cron trigger
 * @param {Set<string>} covered - filenames present in CRITICAL_CRONS
 * @param {Set<string>} exempt  - filenames present in the exempt list
 * @returns {string[]} sorted uncovered filenames
 */
function findUncoveredScheduled(scheduled, covered, exempt) {
  return scheduled
    .filter(f => !covered.has(f) && !exempt.has(f))
    .sort();
}

/**
 * Exempt entries that are stale — listed but no longer a scheduled workflow (deleted
 * or de-scheduled), or also in CRITICAL_CRONS (double-listed). Keeps the allowlist honest.
 * @returns {{ notScheduled: string[], alsoCovered: string[] }}
 */
function findStaleExempt(exempt, scheduledSet, covered) {
  const notScheduled = [], alsoCovered = [];
  for (const f of exempt) {
    if (!scheduledSet.has(f)) notScheduled.push(f);
    else if (covered.has(f)) alsoCovered.push(f);
  }
  return { notScheduled: notScheduled.sort(), alsoCovered: alsoCovered.sort() };
}

/**
 * Parse .cron-health-exempt.txt keeping each entry's justification (BRO-2818).
 * The list was seeded 2026-06-28 with every then-uncovered workflow, so a bare
 * filename says nothing about WHY it is unmonitored. An entry's justification is
 * either an inline `file.yml  # reason` or the `#` comment block directly above it
 * (consumed by the next filename only; a blank line discards it).
 * A justification containing the token `[digest]` CLAIMS stale-run coverage by the
 * daily digest (health-check.js), which findFalseDigestClaims() verifies.
 * @returns {Map<string, { reason: string, claimsDigest: boolean }>}
 */
function parseExemptEntries(text) {
  const out = new Map();
  let block = [];
  for (const raw of (text || '').split('\n')) {
    const line = raw.trim();
    if (!line) { block = []; continue; }
    if (line.startsWith('#')) { block.push(line.replace(/^#\s?/, '')); continue; }
    const hash = line.indexOf('#');
    const file = (hash === -1 ? line : line.slice(0, hash)).trim();
    const inline = hash === -1 ? '' : line.slice(hash + 1).trim();
    if (!file) continue;
    const reason = [...block, inline].filter(Boolean).join(' ').trim();
    out.set(file, { reason, claimsDigest: /\[digest\]/i.test(reason) });
    block = [];
  }
  return out;
}

/** Exempt entries with no justification at all (sorted). */
function findUnjustifiedExempt(entries) {
  return [...entries].filter(([, v]) => !v.reason).map(([f]) => f).sort();
}

/** Entries that claim `[digest]` coverage but are absent from the digest list (sorted). */
function findFalseDigestClaims(entries, digestWorkflows) {
  const digest = new Set(digestWorkflows);
  return [...entries].filter(([f, v]) => v.claimsDigest && !digest.has(f)).map(([f]) => f).sort();
}

/**
 * Drift between the daily-digest cron list and the real-time paging list.
 * Every digest entry must be in the paging list with the same maxHours, unless
 * it is a documented digest-only entry. The two lists carried the comment "keep in
 * sync" with 30 entries of drift and no test (BRO-2818).
 * @param {{workflow:string,maxHours:number}[]} digest
 * @param {Map<string, number>} paging workflow -> maxHours from CRITICAL_CRONS
 * @param {Object<string,string>} digestOnly workflow -> reason
 * @returns {{ missingFromPaging: string[], hoursMismatch: string[], staleDigestOnly: string[] }}
 */
function findDigestDrift(digest, paging, digestOnly) {
  const missingFromPaging = [], hoursMismatch = [], staleDigestOnly = [];
  const inDigest = new Set(digest.map(d => d.workflow));
  for (const { workflow, maxHours } of digest) {
    if (!paging.has(workflow)) {
      if (!digestOnly[workflow]) missingFromPaging.push(workflow);
    } else if (paging.get(workflow) !== maxHours) {
      hoursMismatch.push(`${workflow} (digest ${maxHours}h vs paging ${paging.get(workflow)}h)`);
    }
  }
  for (const wf of Object.keys(digestOnly)) {
    if (!inDigest.has(wf)) staleDigestOnly.push(wf);
  }
  return { missingFromPaging: missingFromPaging.sort(), hoursMismatch: hoursMismatch.sort(), staleDigestOnly: staleDigestOnly.sort() };
}

module.exports = {
  isScheduledWorkflow, parseExemptList, findUncoveredScheduled, findStaleExempt,
  parseExemptEntries, findUnjustifiedExempt, findFalseDigestClaims, findDigestDrift,
};
