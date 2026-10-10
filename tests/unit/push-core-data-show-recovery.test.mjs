// Guards against silent SHOW LOSS in the core-data push (2026-08-05).
//
// `git pull --rebase -X ours` makes our shows.json win outright, so the
// reconciliation that runs after it is the ONLY thing that can preserve a show
// a concurrent job added. It used to `continue` past any id we did not have —
// so a show another workflow had just created was erased. Observed live: two
// add-requested-show runs 20 seconds apart each promoted a show, both logged
// "Core data pushed successfully", and only the later one survived. A green run
// that deletes data is the worst failure mode this repo has.
//
// The logic under test used to be embedded in a github-script block inside
// .github/actions/push-core-data/action.yml, and this test extracted it from
// the YAML and ran it for real (extracting rather than duplicating: a copy
// would drift, and the copy passing would prove nothing about the action).
//
// Task #1817: that inline block was itself extracted into a real module,
// scripts/lib/reconcile-shows-fields.js (colocated test:
// scripts/lib/reconcile-shows-fields.test.mjs), because the YAML text had a
// bug (restored a field from remote whenever local was null, with no way to
// tell "never had it" from "just deliberately cleared it") that needed a
// baseline-aware fix and real unit coverage. This test now imports that real
// module directly — same "test the real code, not a copy" principle, just
// via require() instead of YAML-text surgery + eval.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACTION = path.join(__dirname, '../../.github/actions/push-core-data/action.yml');
const { reconcileShowsJson } = nodeRequire('../../scripts/lib/reconcile-shows-fields.js');

function reconcile({ local, remote, base }) {
  const logs = [];
  const { readded, baseAvailable } = reconcileShowsJson(local, remote, base);
  if (!baseAvailable) {
    const localIds = new Set((local.shows || []).map((s) => s && s.id).filter(Boolean));
    const remoteOnly = (remote.shows || []).filter((rs) => rs && rs.id && !localIds.has(rs.id)).length;
    if (remoteOnly > 0 && readded === 0) logs.push(`::warning::${remoteOnly} show(s) exist on remote but not locally and no merge base was readable`);
  }
  return { shows: local.shows, logs };
}

const S = (id, extra = {}) => ({ id, title: id, ...extra });

test('a show a concurrent job added is NOT erased by our -X ours rebase', () => {
  // Exactly what happened: run A pushed "outsiders" first; run B (this one)
  // added "two-strangers" from the same base and never saw A's show.
  const { shows } = reconcile({
    base:   { shows: [S('hamilton')] },
    remote: { shows: [S('hamilton'), S('outsiders-regional-2023')] },
    local:  { shows: [S('hamilton'), S('two-strangers-regional-2025')] },
  });
  const ids = shows.map((s) => s.id);
  assert.ok(ids.includes('two-strangers-regional-2025'), 'our own new show must survive');
  assert.ok(ids.includes('outsiders-regional-2023'), 'the concurrent job\'s show must survive too');
});

test('a deliberate deletion is honoured, not resurrected', () => {
  // The counterweight: if we could not tell add from delete, every legitimate
  // removal would come back on the next concurrent push.
  const { shows } = reconcile({
    base:   { shows: [S('hamilton'), S('bad-dupe')] },
    remote: { shows: [S('hamilton'), S('bad-dupe')] },
    local:  { shows: [S('hamilton')] },
  });
  assert.deepEqual(shows.map((s) => s.id), ['hamilton']);
});

test('with no readable merge base it stays conservative and says so', () => {
  const { shows, logs } = reconcile({
    base: null,
    remote: { shows: [S('hamilton'), S('mystery')] },
    local:  { shows: [S('hamilton')] },
  });
  assert.deepEqual(shows.map((s) => s.id), ['hamilton'],
    'without a base, add and delete are indistinguishable — never guess');
  assert.ok(logs.some((l) => l.includes('::warning::')),
    'an unrecoverable show must be reported, never silently skipped');
});

test('field-level reconciliation still works', () => {
  const { shows } = reconcile({
    base:   { shows: [S('hamilton')] },
    remote: { shows: [S('hamilton', { venue: 'Richard Rodgers' })] },
    local:  { shows: [S('hamilton', { venue: null })] },
  });
  assert.equal(shows[0].venue, 'Richard Rodgers');
});

// The recovery above is only as good as its BASE. If the base never resolves,
// the code takes its conservative branch and the fix silently disables itself —
// in exactly the concurrent case it exists for. checkout-core-data clones with
// `--depth 1`, so `git merge-base HEAD origin/main` frequently resolves to
// nothing; the base must therefore come from the checkout SNAPSHOT, which needs
// no git history at all.
test('the base comes from the checkout snapshot, not from git history', () => {
  const yaml = fs.readFileSync(ACTION, 'utf8');
  // Strip comment lines first — this must assert what the shell RUNS, not what
  // the prose around it says. (First cut of this test matched the word
  // "merge-base" inside the explanatory comment and failed on correct code.)
  const capture = yaml
    .slice(
      yaml.indexOf('# ...and the BASE we started from'),
      yaml.indexOf('# Save remote\'s commercial.json')
    )
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');
  assert.ok(capture.includes('/tmp/core-data-snapshot/shows.json'),
    'must read the pristine checkout snapshot as the primary base');
  const snapAt = capture.indexOf('/tmp/core-data-snapshot/shows.json');
  const mergeBaseAt = capture.indexOf('git merge-base');
  assert.ok(mergeBaseAt === -1 || snapAt < mergeBaseAt,
    'merge-base may only be a FALLBACK — it returns nothing in a --depth 1 clone');
  // A failed fallback must leave NO stale base file behind: a leftover base from
  // an earlier run would misclassify this run's adds and deletes.
  assert.ok(/rm -f \/tmp\/base-shows\.json/.test(capture),
    'an unresolvable base must remove the file, not leave a stale one');
});

test('checkout-core-data really does snapshot shows.json', () => {
  // The base capture above depends on this. If the snapshot step ever narrows
  // its file list, the recovery silently loses its base — so assert the link
  // rather than trusting it.
  const checkout = fs.readFileSync(
    path.join(__dirname, '../../.github/actions/checkout-core-data/action.yml'), 'utf8');
  assert.ok(checkout.includes('/tmp/core-data-snapshot'), 'snapshot dir must exist');
  assert.ok(/for f in \/tmp\/core-data-checkout\/\*\.json/.test(checkout),
    'snapshot must cover every top-level JSON, which is what includes shows.json');
});
