'use strict';
// BRO-5307: separate evidence from scoring-delta, using its session stamp store.
const fs = require('fs');
const path = require('path');
const { readStamps } = require('./scoring-watchlists');

const REGEX_AUDIT_MAX_HITS = 5;

function checkRegexAudit({ repoRoot, sessionId, editedAt }) {
  if (editedAt === null) return null; // no content-quality edit in this session
  const command = 'node scripts/audit-regex-patterns.js --full';
  try {
    if (!fs.statSync(path.join(repoRoot, 'data/review-texts')).isDirectory()) throw new Error('not a directory');
  } catch (error) {
    if (error.code === 'ENOENT' || error.message === 'not a directory') {
      return { blocked: false, message: `WARN: data/review-texts is absent; ${command} is still required when the corpus is available (CLAUDE.md §12.8).` };
    }
    return { blocked: true, message: `BLOCKED: cannot read data/review-texts. Restore corpus access and run ${command}.` };
  }
  const runs = readStamps(sessionId, 'regex-audit').filter(r =>
    Number.isFinite(Date.parse(editedAt)) && Number.isFinite(Date.parse(r.started)) &&
    Date.parse(r.started) > Date.parse(editedAt) && Date.parse(r.ts) >= Date.parse(r.started));
  const last = runs.at(-1);
  if (last && (last.exitCode === 0 || last.exitCode === 1) && last.full === true && last.maxHits === REGEX_AUDIT_MAX_HITS && last.scanned > 0) {
    if (last.exitCode === 0) return null;
    const names = last.violationNames?.length ? ` (${last.violationNames.join(', ')})` : '';
    return { blocked: false, message: `WARN: scripts/lib/content-quality.js audit completed with ${last.violations ?? 'unknown'} threshold violation(s)${names}; review the ${command} report (CLAUDE.md §12.8).` };
  }
  return { blocked: true, message: `BLOCKED: content-quality.js edit needs a completed ${command} after the latest edit, using the default threshold and a nonempty corpus (CLAUDE.md §12.8).` };
}

module.exports = { REGEX_AUDIT_MAX_HITS, checkRegexAudit };
