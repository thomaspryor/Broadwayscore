import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXEMPT_LEDGERS,
  isExemptLedgerPath,
  findLedgersMissingUnionOrExemption,
  findExemptLedgersWronglyUnioned,
  VERIFIED_UNION_LEDGERS,
  isVerifiedUnionPath,
  findUnverifiedUnionLedgers,
  perFileUnionDeclarations,
  findStaleVerifiedUnionPatterns,
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
    // BRO-2497: repo-wide, so any repo-relative *.jsonl path (no leading
    // slash, no `..`), not just data/audit/.
    assert.match(entry.file, /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\s]+\.jsonl$/, `exemption path looks wrong: ${entry.file}`);
    assert.ok(entry.reason && entry.reason.length > 40, `exemption reason too thin for ${entry.file}`);
  }
});

// BRO-3868 what-else sweep: scraper-spend-daily-agg.jsonl was listed TWICE
// (BRO-3202 and BRO-3092, added independently the same day) — harmless to
// isExemptLedgerPath's Set-backed lookup, but dead documentation weight and a
// sign two sessions duplicated each other's checked work. Nothing else here
// would have caught it: "well-formed" only checks each entry in isolation.
test('EXEMPT_LEDGERS has no duplicate file entries', () => {
  const files = EXEMPT_LEDGERS.map((e) => e.file);
  const seen = new Set();
  const dupes = files.filter((f) => (seen.has(f) ? true : (seen.add(f), false)));
  assert.deepEqual(dupes, [], `duplicate EXEMPT_LEDGERS entry(ies): ${JSON.stringify(dupes)}`);
});

test('findUnverifiedUnionLedgers flags a union *.jsonl outside data/audit with no VERIFIED_UNION_LEDGERS entry', () => {
  const gaps = findUnverifiedUnionLedgers(
    ['data/new-thing/log.jsonl', 'data/audit/stage-latency.jsonl', 'data/opening-night-timeline/x.jsonl', 'data/plain.jsonl'],
    (f) => (f === 'data/plain.jsonl' ? 'unspecified' : 'union'),
    new Set(['data/audit/stage-latency.jsonl'])
  );
  // data/audit/ union files were reviewed by BRO-2493; the opening-night
  // timeline is verified; a non-union file is the coverage check's job.
  assert.deepEqual(gaps, [{ file: 'data/new-thing/log.jsonl' }]);
});

test('isVerifiedUnionPath: `*` matches one path segment only', () => {
  assert.equal(isVerifiedUnionPath('data/opening-night-timeline/beaches-2026.jsonl'), true);
  assert.equal(isVerifiedUnionPath('data/opening-night-timeline/nested/beaches-2026.jsonl'), false);
  assert.equal(isVerifiedUnionPath('data/opening-night-timeline/beaches-2026.json'), false);
});

test('a data/audit union ledger declared only by a glob still needs a VERIFIED entry (BRO-5261)', () => {
  const attrs = 'data/audit/a.jsonl merge=union\ndata/audit/g/*.jsonl merge=union\n# data/audit/c.jsonl merge=union\n';
  const perFile = perFileUnionDeclarations(attrs);
  assert.deepEqual([...perFile], ['data/audit/a.jsonl']);
  const gaps = findUnverifiedUnionLedgers(['data/audit/a.jsonl', 'data/audit/g/x.jsonl'], () => 'union', perFile);
  assert.deepEqual(gaps, [{ file: 'data/audit/g/x.jsonl' }]);
});

test('findStaleVerifiedUnionPatterns flags a pattern matching no tracked file', () => {
  assert.deepEqual(findStaleVerifiedUnionPatterns([]), VERIFIED_UNION_LEDGERS.map((e) => e.pattern));
  assert.deepEqual(findStaleVerifiedUnionPatterns(['data/opening-night-timeline/x.jsonl', 'data/audit/fact-check/x.jsonl']), []);
});

test('VERIFIED_UNION_LEDGERS entries are well-formed', () => {
  for (const entry of VERIFIED_UNION_LEDGERS) {
    assert.match(entry.pattern, /\.jsonl$/, `pattern must target *.jsonl: ${entry.pattern}`);
    assert.ok(entry.reason && entry.reason.length > 40, `verified-union reason too thin for ${entry.pattern}`);
  }
});

// Discovery is every tracked *.jsonl in the repo (BRO-2497), not just
// `git ls-files data/audit` (BRO-2493): sync-audit-checkout.sh's union-recovery
// stage has no path filter, and unionLedgerCandidates() keys on `*.jsonl` +
// merge=union regardless of directory. Non-.jsonl union files (today only
// tests/unit-test-manifest.txt) are refused by that predicate, so they are out
// of scope — see the module header.
function listTrackedJsonl() {
  return git(['ls-files', '-z', '--', '*.jsonl'])
    .split('\0')
    .filter(Boolean)
    .filter((f) => f.endsWith('.jsonl'));
}

test('REGRESSION: every real tracked *.jsonl (repo-wide) is either merge=union or a documented exemption', () => {
  const tracked = listTrackedJsonl();
  assert.ok(
    tracked.filter((f) => f.startsWith('data/audit/')).length > 5,
    'sanity: found a plausible number of tracked data/audit/*.jsonl ledgers'
  );
  assert.ok(
    tracked.some((f) => !f.startsWith('data/audit/')),
    'sanity: discovery reaches *.jsonl outside data/audit/ (BRO-2497 widening)'
  );

  // -z on both ends: a path git would C-quote (non-ASCII) must still match
  // its ls-files spelling. Output is NUL-separated <path> <attr> <value> triples.
  const attrOut = execFileSync('git', ['check-attr', '-z', 'merge', '--stdin'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    input: tracked.join('\0') + '\0',
  });
  const mergeAttrByFile = new Map();
  const parts = attrOut.split('\0');
  for (let i = 0; i + 2 < parts.length; i += 3) mergeAttrByFile.set(parts[i], parts[i + 2]);

  const attrOf = (f) => mergeAttrByFile.get(f) || null;

  const gaps = findLedgersMissingUnionOrExemption(tracked, attrOf);
  assert.deepEqual(
    gaps,
    [],
    `tracked *.jsonl file(s) with neither merge=union in .gitattributes nor an EXEMPT_LEDGERS entry (scripts/lib/audit-ledger-merge-attrs.js): ${JSON.stringify(gaps)}`
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

  const perFile = perFileUnionDeclarations(fs.readFileSync(path.join(REPO_ROOT, '.gitattributes'), 'utf8'));
  const unverified = findUnverifiedUnionLedgers(tracked, attrOf, perFile);
  assert.deepEqual(
    unverified,
    [],
    `merge=union *.jsonl not reviewed per file (outside data/audit/, or glob-declared inside it) with no VERIFIED_UNION_LEDGERS entry (check its readers for order/duplicate sensitivity, then add one or exempt it): ${JSON.stringify(unverified)}`
  );

  const stalePatterns = findStaleVerifiedUnionPatterns(tracked);
  assert.deepEqual(stalePatterns, [], `VERIFIED_UNION_LEDGERS pattern(s) matching no tracked file: ${JSON.stringify(stalePatterns)}`);

  // Every EXEMPT_LEDGERS entry should name a file that still actually exists
  // and is still tracked — a stale entry for a deleted/renamed file silently
  // stops meaning anything and should be pruned, not left to rot.
  const trackedSet = new Set(tracked);
  const staleExemptions = EXEMPT_LEDGERS.filter((e) => !trackedSet.has(e.file)).map((e) => e.file);
  assert.deepEqual(staleExemptions, [], `EXEMPT_LEDGERS names untracked/nonexistent path(s): ${JSON.stringify(staleExemptions)}`);
});
