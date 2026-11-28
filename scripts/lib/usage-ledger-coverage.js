/**
 * Pure check (BRO-7521): a workflow that holds a model API secret must save
 * the LLM usage ledger, else the rows die with the runner (BRO-7517: eight
 * busy workflows showed zero rows in 24 days). Used by
 * scripts/tests/usage-ledger-coverage.test.mjs.
 */
'use strict';

const SECRET_RE = /secrets\.(GEMINI|OPENAI|ANTHROPIC)_API_KEY/;
const SAVE_RE = /commit-scraper-spend-ledger/;
const EXEMPT_RE = /^# ledger-exempt: \S.{14,}$/m;

/** -> list of problem strings for one workflow file's text. */
function ledgerProblems(src) {
  if (!SECRET_RE.test(src) || EXEMPT_RE.test(src)) return [];
  const lines = src.split('\n');
  const ji = lines.findIndex((l) => l === 'jobs:');
  if (ji === -1) return [];
  const readOnly = /^permissions:\s*\n(?:  .*\n)*?  contents: read\b/m.test(src) && !/contents: write/.test(src);
  const top = SECRET_RE.test(lines.slice(0, ji).join('\n'));
  const starts = [];
  for (let k = ji + 1; k < lines.length; k++) if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[k])) starts.push(k);
  const problems = [];
  starts.forEach((a, i) => {
    const block = lines.slice(a, starts[i + 1] || lines.length).join('\n');
    if (/^    uses:/m.test(block)) return; // reusable-workflow call: no steps here
    if (!(top || SECRET_RE.test(block))) return;
    if (!/actions\/checkout/.test(block)) return; // nothing to commit from
    if (readOnly) { problems.push(`job ${lines[a].trim().replace(/:$/, '')} has a model secret but the workflow token is contents: read, so the ledger cannot be pushed (grant contents: write or add '# ledger-exempt: <reason>')`); return; }
    if (!SAVE_RE.test(block)) problems.push(`job ${lines[a].trim().replace(/:$/, '')} has a model secret but no commit-scraper-spend-ledger step`);
  });
  return problems;
}

module.exports = { ledgerProblems };
