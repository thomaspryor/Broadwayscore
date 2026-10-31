'use strict';

const { createHash } = require('node:crypto');
const { PARKED_SENTINEL_RE } = require('./headless-dispatchability.js');

const MARKER = '<!-- digest-dispatch-freshness:';
const TITLE_PREFIX = 'BSC Daily: ';

// The description is historical evidence. Put current evidence in both the
// launch prompt and a comment, without rewriting acceptance criteria or parks.
async function refreshDigestDispatchBrief(issue, { probeRow, createComment, log = console.warn }) {
  if (!String(issue.title || '').startsWith(TITLE_PREFIX) || !PARKED_SENTINEL_RE.test(issue.description || '')) return '';
  const rowName = issue.title.slice(TITLE_PREFIX.length).trim();
  if (!rowName) return '';

  let probe;
  try {
    probe = await probeRow(rowName);
  } catch {
    // Exception text can contain credential-bearing requests.
    probe = { verdict: 'unknown', matched: null };
  }
  const matched = probe.matched;
  const message = matched && String(matched.message || '').trim();
  const evidence = probe.verdict === 'unknown'
    ? `Cannot verify the current row in this environment.${message ? ` Check output: ${message}` : ''}`
    : `Live verdict: ${probe.verdict}; status: ${matched.status}.\nCurrent message: ${message}`;
  const marker = `${MARKER}${createHash('sha256').update(evidence).digest('hex').slice(0, 16)} -->`;
  const brief = [
    marker,
    '## Dispatch-time health evidence',
    `Checked at ${probe.generatedAt || new Date().toISOString()} for "${rowName}".`,
    evidence,
    'Use this measurement when assessing the original Problem section. That section records the filing-time state and may describe an obsolete failure mode. An unverifiable row is not proof of either failure or recovery. Preserve the existing acceptance criteria.',
  ].join('\n\n');

  const comments = ((issue.comments && issue.comments.nodes) || [])
    .filter(c => c && String(c.body || '').startsWith(MARKER))
    .slice().sort((a, b) => {
      const left = String(a.createdAt || '');
      const right = String(b.createdAt || '');
      return left < right ? -1 : left > right ? 1 : 0;
    });
  const latest = comments.at(-1);
  const unchanged = latest
    ? latest.body.startsWith(marker)
    : probe.verdict === 'present' && message && String(issue.description || '').includes(message);
  if (!unchanged) {
    try {
      await createComment(issue.id, brief);
    } catch {
      log(`[digest-dispatch-freshness] ${issue.identifier}: could not post health evidence; it is included in the worker prompt.`);
    }
  }
  return brief;
}

module.exports = { refreshDigestDispatchBrief };
