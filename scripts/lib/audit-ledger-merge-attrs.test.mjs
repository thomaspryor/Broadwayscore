import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXEMPT_LEDGERS,
  isExemptLedgerPath,
  findLedgersMissingUnionOrExemption,
  findExemptLedgersWronglyUnioned,
} from './audit-ledger-merge-attrs.js';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
}

test('findLedgersMissingUnionOrExemption flags a file with neither union nor an exemption', () => {
  const gaps = findLedgersMissingUnionOrExemption(
    ['data/audit/a.jsonl', 'data/audit/b.jsonl'],
    (f) => (f === 'data/audit/a.jsonl' ? 'union' : 'unspecified')
  );
  assert.deepEqual(gaps, [{ file: 'data/audit/b.jsonl' }]);
});

test('findLedgersMissingUnionOrExemption clears a file declared merge=union', () => {
  const gaps = findLedgersMissingUnionOrExemption(['data/audit/a.jsonl'], () => 'union');
  assert.deepEqual(gaps, []);
});

test('findLedgersMissingUnionOrExemption clears a file in EXEMPT_LEDGERS even with no driver', () => {
  const file = EXEMPT_LEDGERS[0].file;
  const gaps = findLedgersMissingUnionOrExemption([file], () => 'unspecified');
  assert.deepEqual(gaps, []);
});

test('findLedgersMissingUnionOrExemption still flags an exempt path if mergeAttrOf never sees it queried wrongly', () => {
  // A file NOT in EXEMPT_LEDGERS and NOT union is the real gap this gate exists
  // to catch — regression guard against a future 18th ledger arriving silently.
  const gaps = findLedgersMissingUnionOrExemption(['data/audit/brand-new-ledger.jsonl'], () => 'unspecified');
  assert.deepEqual(gaps, [{ file: 'data/audit/brand-new-ledger.jsonl' }]);
});

test('findExemptLedgersWronglyUnioned flags an exempt file that is ALSO declared merge=union', () => {
  const file = EXEMPT_LEDGERS[0].file;
  const violations = findExemptLedgersWronglyUnioned((f) => (f === file ? 'union' : 'unspecified'));
  assert.deepEqual(violations, [{ file }]);
});

test('findExemptLedgersWronglyUnioned is clean when no exempt file carries merge=union', () => {
  const violations = findExemptLedgersWronglyUnioned(() => 'unspecified');
  assert.deepEqual(violations, []);
});

test('isExemptLedgerPath is true only for a listed path', () => {
  assert.equal(isExemptLedgerPath(EXEMPT_LEDGERS[0].file), true);
  assert.equal(isExemptLedgerPath('data/audit/not-a-real-file.jsonl'), false);
});

test('EXEMPT_LEDGERS entries are well-formed', () => {
  assert.ok(EXEMPT_LEDGERS.length > 0, 'sanity: exemption list is non-empty');
  for (const entry of EXEMPT_LEDGERS) {
    assert.match(entry.file, /^data\/audit\/[^/]+\.jsonl$/, `exemption path looks wrong: ${entry.file}`);
    assert.ok(entry.reason && entry.reason.length > 40, `exemption reason too thin for ${entry.file}`);
  }
});

test('REGRESSION: every real tracked data/audit/*.jsonl ledger is either merge=union or a documented exemption', () => {
  const tracked = git(['ls-files', 'data/audit'])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((f) => f.endsWith('.jsonl'));
  assert.ok(tracked.length > 5, 'sanity: found a plausible number of tracked data/audit/*.jsonl ledgers');

  const attrOut = execFileSync('git', ['check-attr', 'merge', '--stdin'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    input: tracked.join('\n') + '\n',
  });
  const mergeAttrByFile = new Map();
  for (const line of attrOut.split('\n')) {
    // "<path>: merge: <value>" — split on the LAST two ": " so a path
    // containing ": " (none today) would still parse correctly.
    const m = line.match(/^(.*): merge: (.*)$/);
    if (!m) continue;
    mergeAttrByFile.set(m[1], m[2]);
  }

  const attrOf = (f) => mergeAttrByFile.get(f) || null;

  const gaps = findLedgersMissingUnionOrExemption(tracked, attrOf);
  assert.deepEqual(
    gaps,
    [],
    `data/audit/*.jsonl ledger(s) with neither merge=union in .gitattributes nor an EXEMPT_LEDGERS entry (scripts/lib/audit-ledger-merge-attrs.js): ${JSON.stringify(gaps)}`
  );

  // A file listed in EXEMPT_LEDGERS for a checked, reasoned disqualifier must
  // never ALSO be declared merge=union — that silently overrides the
  // exemption and reintroduces the exact corruption its reason documents.
  const contradictions = findExemptLedgersWronglyUnioned(attrOf);
  assert.deepEqual(
    contradictions,
    [],
    `EXEMPT_LEDGERS entry(ies) that are ALSO declared merge=union in .gitattributes — remove the union declaration or remove the exemption: ${JSON.stringify(contradictions)}`
  );

  // Every EXEMPT_LEDGERS entry should name a file that still actually exists
  // and is still tracked — a stale entry for a deleted/renamed file silently
  // stops meaning anything and should be pruned, not left to rot.
  const trackedSet = new Set(tracked);
  const staleExemptions = EXEMPT_LEDGERS.filter((e) => !trackedSet.has(e.file)).map((e) => e.file);
  assert.deepEqual(staleExemptions, [], `EXEMPT_LEDGERS names untracked/nonexistent path(s): ${JSON.stringify(staleExemptions)}`);
});
