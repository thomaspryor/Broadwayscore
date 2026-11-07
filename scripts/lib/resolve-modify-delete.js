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
 * (`git rm` or keep this workflow's copy and `git add`); review *.json only. Prints each path as
 * `<path>\tdelete|keep`.
 *   node resolve-modify-delete.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function _parse(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const d = JSON.parse(raw);
    return d && typeof d === 'object' && !Array.isArray(d) ? d : null;
  } catch { return null; }
}
const _hasFullText = (d) => !!d && typeof d.fullText === 'string';
function _fullText(raw) {
  const d = _parse(raw);
  return _hasFullText(d) ? d.fullText.replace(/\s+/g, ' ').trim() : '';
}

/**
 * @param {{baseRaw: string|null, oursRaw: string|null}} p raw file contents
 *   (null when absent) of the common base and this workflow's modified copy
 * @returns {'delete'|'keep'|'skip'} 'skip' = not a review-text record (no
 *   fullText on either side); the action's own rules decide
 */
function resolveModifyDelete({ baseRaw, oursRaw }) {
  // execute-approved-fix stamps a deliberate delete-then-rewrite
  // `_recreatedAfterDelete` (rename-identity.js): never discard that.
  const o = _parse(oursRaw);
  if (o && o._recreatedAfterDelete) return 'keep';
  const ours = _fullText(oursRaw);
  if (!_hasFullText(o) && !_hasFullText(_parse(baseRaw))) return 'skip';
  if (!ours) return 'delete';
  if (ours === _fullText(baseRaw)) return 'delete';
  return 'keep';
}

// Review-text JSON only: sidecars (_blocklist.json, failed-fetches.json, ...)
// keep their own merge rules in the action.
const { isReviewTextFile } = require('./review-text-sidecars');
const isReviewJson = (p) => isReviewTextFile(path.basename(p));

function _git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...opts });
}
// The stage exists (ls-files said so): a read failure is an error, never "absent".
function _stage(n, p) {
  return _git(['show', `:${n}:${p}`]);
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
    if (s.has('2') || !s.has('1') || !s.has('3') || !isReviewJson(p)) continue;
    try {
      const oursRaw = _stage(3, p);
      const decision = resolveModifyDelete({ baseRaw: _stage(1, p), oursRaw });
      if (decision === 'skip') continue;
      if (decision === 'delete') {
        _git(['rm', '-q', '-f', '--', p]);
        process.stderr.write(`::notice::resolve-modify-delete: ${p} deleted upstream, stale rewrite dropped\n`);
      } else {
        // Write the workflow's (stage 3) copy explicitly; the work tree may have
        // been touched by an earlier step.
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, oursRaw);
        _git(['add', '--', p]);
      }
      process.stdout.write(`${p}\t${decision}\n`);
    } catch (e) {
      // One bad path must not abort the rest; it stays unmerged for the caller's fallback.
      process.stderr.write(`::warning::resolve-modify-delete: ${p} left unresolved: ${e.message}\n`);
    }
  }
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(`resolve-modify-delete: ${e.message}`); process.exit(1); }
}

module.exports = { resolveModifyDelete };
