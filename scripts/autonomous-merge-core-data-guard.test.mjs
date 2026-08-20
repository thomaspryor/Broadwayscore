/**
 * autonomous-merge-core-data-guard.test.mjs — keeps the ONLY path to main open.
 *
 * WHAT BROKE (run 32086045215, 2026-08-17): the CI job runs
 * .github/actions/checkout-core-data before scripts/autonomous-merge.js, and that
 * action ends with `cp -f /tmp/core-data-checkout/*.json data/`. One shipped file,
 * data/outlet-registry.json, is TRACKED in this repo, so the copy left the working
 * tree dirty for a tracked path and the very next `git checkout -B auto-merge-work`
 * aborted:
 *
 *   error: Your local changes to the following files would be overwritten by
 *   checkout: data/outlet-registry.json
 *
 * Because autonomous-merge.yml is documented as "the ONLY place a branch reaches
 * main", that one dirty file blocked EVERY agent PR, not one. Four green PRs sat
 * unmerged for a day and nothing reported it — the merge failed while the board
 * still showed the work as finished.
 *
 * There is a SECOND instance of the same failure, one step later: the re-verify
 * runs `next build`, whose `prebuild` regenerates seven more tracked files
 * (data/slug-redirects.json, data/gold-lists-computed.json,
 * data/blog-reviews-for-scoring.json, public/data/mobile-shows.json,
 * public/data/search-shows.json, src/config/outlet-logos-generated.json,
 * public/brand-tokens.json). The first outage died before reaching it, so a fix
 * scoped to core data alone would have moved the outage rather than ended it
 * (adversarial review, 2026-08-17). Hence one mechanism — a forced checkout —
 * rather than a per-file allow-list that has to be kept in sync with two
 * generators.
 *
 * The regression that would silently undo this is somebody adding a HEAD-moving
 * git call directly instead of via gitCheckout(). No behavioural test can catch
 * that, because the new call site is simply never exercised — so the invariant is
 * asserted on the SOURCE TEXT, the same technique autonomous-merge-parity.test.mjs
 * uses, and for the same reason.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const merge = require('./autonomous-merge.js');
const src = fs.readFileSync(new URL('./autonomous-merge.js', import.meta.url), 'utf8');

test('structure: no HEAD-moving git command bypasses gitCheckout()', () => {
  // An earlier version of this check matched only single-quoted
  // `git(['checkout'…])`, so `git(["checkout"…])` or `git(['switch'…])` would
  // sail past while reintroducing the outage (adversarial review, 2026-08-17).
  // Every git subcommand that moves HEAD or refuses on a dirty tracked file is
  // matched here, in any quoting style.
  const HEAD_MOVING = ['checkout', 'switch', 'restore'];
  const offenders = [];
  src.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (line.startsWith('*') || line.startsWith('//')) return; // prose, not code
    const m = line.match(/\bgit\(\s*\[\s*(['"`])([a-z-]+)\1/);
    if (!m || !HEAD_MOVING.includes(m[2])) return;
    offenders.push({ n: i + 1, line });
  });

  // Exactly one bare checkout is legitimate: gitCheckout's own delegation.
  const allowed = [
    // gitCheckout's own delegation for this repo.
    "return git(['checkout', ...(force ? ['-f'] : []), ...args], opts);",
    // …and its plain delegation for a private data-repo clone, which must NOT force.
    "if (target !== path.resolve(REPO)) return git(['checkout', ...args], opts);",
  ];
  const unexpected = offenders.filter((l) => !allowed.includes(l.line));

  assert.deepEqual(
    unexpected.map((l) => `${l.n}: ${l.line}`),
    [],
    'every HEAD-moving git call must go through gitCheckout() — a bare one aborts in CI '
      + 'when checkout-core-data or prebuild has dirtied a tracked file, which silently blocks ALL merges'
  );

  // Guard the guard. Without this, reformatting the allow-listed line would leave
  // the matcher finding nothing, and an empty offender list reads as success.
  const seen = new Set(offenders.map((l) => l.line));
  assert.deepEqual(allowed.filter((a) => !seen.has(a)), [],
    'the allow-listed bare git call no longer appears in the source — re-derive this test '
      + 'against the current file rather than leaving a stale allow-list that asserts nothing');
});

test('structure: the private-repo clone path is discriminated by repo IDENTITY, not by "was a cwd passed"', () => {
  // approveDataCard() works in a flat mkdtemp clone of a private data repo. It has
  // no data/ directory, checkout-core-data never touched it, and forcing there
  // could discard the very rebased data being merged.
  //
  // Keying that off the mere presence of opts.cwd is a footgun: a future caller
  // passing `{ cwd: REPO }` for good reasons would silently lose the guard and
  // reintroduce the outage. Asserted on source text because the failure it
  // prevents is a refactor, which no test on the current call sites can reach.
  assert.match(src, /const target = path\.resolve\(opts\.cwd \|\| REPO\);/,
    'gitCheckout must resolve the target repo path');
  assert.match(src, /if \(target !== path\.resolve\(REPO\)\) return git\(\['checkout', \.\.\.args\], opts\);/,
    'a target other than this repo must get a plain, unforced checkout');
  assert.ok(!/if \(!opts\.cwd\)/.test(src),
    'the superseded presence-of-cwd discriminator must not come back');
});

/** A throwaway repo with one tracked file and one untracked file under data/. */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amcd-'));
  const g = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  g(['init', '-q']);
  g(['config', 'user.email', 't@e.st']);
  g(['config', 'user.name', 'test']);
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'data/outlet-registry.json'), '{"committed":true}\n');
  g(['add', 'data/outlet-registry.json']);
  g(['commit', '-qm', 'base']);
  fs.writeFileSync(path.join(dir, 'data/shows.json'), '{"untracked":true}\n');
  // init.defaultBranch varies by git config (master vs main), so never hardcode it.
  const base = g(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  return { dir, g, base };
}

test('dirtyTrackedPaths: reports modified TRACKED files and ignores untracked ones', () => {
  const { dir } = makeRepo();
  try {
    assert.deepEqual(merge.dirtyTrackedPaths(dir), [],
      'a clean tree (untracked shows.json aside) must report nothing');

    // Simulate `cp -f /tmp/core-data-checkout/*.json data/`.
    fs.writeFileSync(path.join(dir, 'data/outlet-registry.json'), '{"from":"private-repo"}\n');

    assert.deepEqual(merge.dirtyTrackedPaths(dir), ['data/outlet-registry.json'],
      'the tracked core-data copy is what aborts the checkout, so it must be reported');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the real failure: a plain checkout ABORTS on the dirty tracked file, a forced one succeeds', () => {
  // This is the actual CI failure, reproduced end to end rather than asserted
  // about. If this test ever stops failing on the plain path, the premise of the
  // whole fix has changed and the fix should be re-derived.
  const { dir, g, base } = makeRepo();
  try {
    // The target branch must carry a DIFFERENT version of the file, which is the
    // real situation: the branch being merged has its own committed copy. With an
    // identical copy git simply carries the local change across and never aborts —
    // getting this wrong made an earlier draft of this test pass vacuously.
    g(['checkout', '-q', '-b', 'target']);
    fs.writeFileSync(path.join(dir, 'data/outlet-registry.json'), '{"committed":"on-target"}\n');
    g(['add', 'data/outlet-registry.json']);
    g(['commit', '-qm', 'target version']);
    g(['checkout', '-q', base]);

    // Now simulate `cp -f /tmp/core-data-checkout/*.json data/` dirtying the tree.
    fs.writeFileSync(path.join(dir, 'data/outlet-registry.json'), '{"from":"private-repo"}\n');

    assert.throws(() => g(['checkout', 'target']), /would be overwritten by checkout|local changes/i,
      'precondition: this is exactly how run 32086045215 died');

    // The forced form is what gitCheckout issues in CI.
    g(['checkout', '-f', 'target']);
    assert.equal(fs.readFileSync(path.join(dir, 'data/outlet-registry.json'), 'utf8'), '{"committed":"on-target"}\n',
      'the forced checkout proceeds and leaves the TARGET branch content in place');
    assert.equal(fs.readFileSync(path.join(dir, 'data/shows.json'), 'utf8'), '{"untracked":true}\n',
      'UNTRACKED core data must survive — the re-verify still needs the private shows.json/reviews.json');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gitCheckout refuses to force outside CI, so a developer never loses real work', () => {
  // In CI the checkout is disposable. On a working machine `-f` would destroy
  // uncommitted edits, so the force is gated on GITHUB_ACTIONS rather than on
  // trusting that nobody runs this script by hand.
  assert.match(src, /if \(!process\.env\.GITHUB_ACTIONS\) \{[\s\S]{0,400}?throw new Error\(/,
    'a dirty tracked tree outside GITHUB_ACTIONS must throw rather than force');
  assert.match(src, /AUTONOMOUS_MERGE_FORCE_CHECKOUT_DISABLED/,
    'there must be a kill switch — this sits on the only path to main');
  assert.match(src, /console\.error\(`\[merge\] discarding \$\{dirty\.length\}/,
    'the discard must be logged, never silent');
});
