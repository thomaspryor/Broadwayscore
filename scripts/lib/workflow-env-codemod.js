/**
 * Pure text codemod: add `NAME: ${{ secrets.NAME }}` lines to one workflow
 * step's env: block (BRO-5151). Used by scripts/wire-workflow-secret-gaps.js
 * to wire the secrets audit-workflow-secret-gaps.js reports as missing,
 * without re-serialising the YAML (comments and formatting stay intact).
 *
 * Locates the step with the same block-YAML grouping the scanner uses
 * (workflow-secret-scan.js groupByMinIndent), so "the step the audit flagged"
 * and "the step this edits" are found the same way. Refuses (returns
 * { ok: false, reason }) instead of guessing: a job/step that is missing or
 * whose name is not unique in the job, or an env: written inline.
 */
'use strict';

const { groupByMinIndent, asMapping } = require('./workflow-secret-scan.js');

function toIndexedLines(raw) {
  return raw.split('\n').map((text, idx) => ({
    raw: text,
    idx,
    indent: text.match(/^(\s*)/)[1].length,
    trimmed: text.trim(),
  }));
}

function unquote(s) {
  const t = String(s).trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

/** Splits a `- key: v` sequence item into its field mappings, keeping line idx. */
function stepFields(stepChild) {
  const m = stepChild.keyLine.raw.match(/^(\s*)-(\s+)(.*)$/);
  if (!m) return null;
  const fieldIndent = m[1].length + 1 + m[2].length;
  const first = { raw: ' '.repeat(fieldIndent) + m[3], idx: stepChild.keyLine.idx, indent: fieldIndent, trimmed: m[3].trim() };
  const fields = groupByMinIndent([first, ...stepChild.bodyLines]).map(asMapping).filter(Boolean);
  return { fieldIndent, fields, firstIdx: stepChild.keyLine.idx, firstInline: m[3] };
}

function findStep(lines, jobName, stepName) {
  const root = groupByMinIndent(lines).map(asMapping).filter(Boolean);
  const jobs = root.find((f) => f.key === 'jobs');
  if (!jobs) return { reason: 'no jobs:' };
  const job = groupByMinIndent(jobs.bodyLines).map(asMapping).filter(Boolean).find((j) => j.key === jobName);
  if (!job) return { reason: `job ${jobName} not found` };
  const steps = groupByMinIndent(job.bodyLines).map(asMapping).filter(Boolean).find((f) => f.key === 'steps');
  if (!steps) return { reason: 'no steps:' };
  const hits = [];
  for (const child of groupByMinIndent(steps.bodyLines)) {
    const sf = stepFields(child);
    if (!sf) continue;
    const nameField = sf.fields.find((f) => f.key === 'name');
    const name = nameField ? unquote(nameField.inline) : '(unnamed step)';
    if (name === stepName || (nameField && nameField.inline === stepName)) hits.push({ child, sf });
  }
  if (hits.length !== 1) return { reason: `step "${stepName}" matched ${hits.length} times` };
  return hits[0];
}

/**
 * @param {string} raw workflow file text
 * @param {string} jobName job key
 * @param {string} stepName step name as the audit reports it
 * @param {string[]} names secrets to add
 * @returns {{ok: true, raw: string, added: string[]} | {ok: false, reason: string}}
 */
function addStepSecrets(raw, jobName, stepName, names) {
  const lines = toIndexedLines(raw);
  const found = findStep(lines, jobName, stepName);
  if (!found.sf) return { ok: false, reason: found.reason };
  const { sf, child } = found;
  const envField = sf.fields.find((f) => f.key === 'env');
  const text = lines.map((l) => l.raw);

  if (envField) {
    if (envField.inline !== '') return { ok: false, reason: 'env: is inline' };
    const entries = groupByMinIndent(envField.bodyLines).map(asMapping).filter(Boolean);
    if (!entries.length) return { ok: false, reason: 'env: block empty' };
    const have = new Set(entries.map((e) => e.key));
    const add = names.filter((n) => !have.has(n));
    if (!add.length) return { ok: true, raw, added: [] };
    const entryIndent = groupByMinIndent(envField.bodyLines)[0].keyLine.indent;
    // After the env block's last non-blank line.
    const body = envField.bodyLines.filter((l) => l.trimmed !== '');
    const lastIdx = body[body.length - 1].idx;
    const ins = add.map((n) => `${' '.repeat(entryIndent)}${n}: \${{ secrets.${n} }}`);
    text.splice(lastIdx + 1, 0, ...ins);
    return { ok: true, raw: text.join('\n'), added: add };
  }

  const block = [`${' '.repeat(sf.fieldIndent)}env:`, ...names.map((n) => `${' '.repeat(sf.fieldIndent + 2)}${n}: \${{ secrets.${n} }}`)];
  const nameField = sf.fields.find((f) => f.key === 'name');
  const nameIsOneLine = nameField && nameField.bodyLines.every((l) => l.trimmed === '') && !/^[|>]/.test(nameField.inline);
  let at;
  if (nameIsOneLine && nameField === sf.fields[0]) {
    at = sf.firstIdx + 1;
  } else {
    const body = [child.keyLine, ...child.bodyLines].filter((l) => l.trimmed !== '');
    at = body[body.length - 1].idx + 1;
  }
  text.splice(at, 0, ...block);
  return { ok: true, raw: text.join('\n'), added: names.slice() };
}

module.exports = { addStepSecrets };
