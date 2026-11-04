#!/usr/bin/env node
'use strict';
/**
 * Modify/delete conflict resolution for review-text rebases (BRO-6941).
 *
 * Incident (broadway-review-texts b3ea46464 -> cf36f9a5a, 2026-11-03): an
 * Execute Approved Fix run deleted three tosca-english-national-opera-west-end-2026
 * review files. Five minutes later a Rebuild Reviews (Fast) job whose checkout
 * predated that push rewrote the same files (no real change, just its stale
 * copy) and pushed through .github/actions/push-review-texts. The rebase hit a
 * modify/delete conflict; the resolver compared fullText length against the
 * deleted side's empty content, so "ours" always won and the deleted files
 * came back (and one was LLM-scored into the live composite).
 *
 * Rule: when upstream deleted a file this workflow modified, the deletion
 * stands unless the workflow made a real content change, meaning its fullText
 * differs from the base copy it started from and is non-empty. A stale rewrite
 * (same text, reclassified or re-stamped metadata) is not a reason to
 * resurrect a deliberate deletion.
 *
 * CLI (inside the data repo, mid-rebase): for every unmerged path with no
 * stage 2 (upstream deleted it) but stages 1 and 3, apply the decision
 * (`git rm` or keep this workflow's copy and `git add`). Prints each path as
 * `<path>\tdelete|keep`.
 *   node resolve-modify-delete.js
 */

const { execFileSync } = require('child_process');

function _fullText(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  try {
    const d = JSON.parse(raw);
    return d && typeof d.fullText === 'string' ? d.fullText : '';
  } catch { return ''; }
}

/**
 * @param {{baseRaw: string|null, oursRaw: string|null}} p raw file contents
 *   (null when absent) of the common base and this workflow's modified copy
 * @returns {'delete'|'keep'}
 */
function resolveModifyDelete({ baseRaw, oursRaw }) {
  const ours = _fullText(oursRaw);
  if (!ours) return 'delete';
  if (ours === _fullText(baseRaw)) return 'delete';
  return 'keep';
}

function _git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...opts });
}
function _stage(n, p) {
  try { return _git(['show', `:${n}:${p}`]); } catch { return null; }
}

function main() {
  const out = _git(['ls-files', '-u', '-z']);
  const stages = new Map();
  for (const rec of out.split('\0').filter(Boolean)) {
    const tab = rec.indexOf('\t');
    const [, , stage] = rec.slice(0, tab).split(' ');
    const p = rec.slice(tab + 1);
    if (!stages.has(p)) stages.set(p, new Set());
    stages.get(p).add(stage);
  }
  for (const [p, s] of stages) {
    if (s.has('2') || !s.has('1') || !s.has('3')) continue;
    const decision = resolveModifyDelete({ baseRaw: _stage(1, p), oursRaw: _stage(3, p) });
    if (decision === 'delete') {
      _git(['rm', '-q', '-f', '--', p]);
    } else {
      _git(['add', '--', p]);
    }
    process.stdout.write(`${p}\t${decision}\n`);
  }
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(`resolve-modify-delete: ${e.message}`); process.exit(1); }
}

module.exports = { resolveModifyDelete };
