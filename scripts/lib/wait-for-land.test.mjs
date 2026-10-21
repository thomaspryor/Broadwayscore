// BRO-4671: the land waiter must report a refused land run, not just the ref
// disappearing. Each case below is a poll result seen during real landings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { landVerdict, prodPlan, prodVerdict, parseArgs, sitePathsIn } = require('./wait-for-land.js');

const TIP = '057156419a666b690b937354092729af67ceb092';
const NOW = Date.parse('2026-10-05T05:00:00Z');
const minsAgo = (m) => new Date(NOW - m * 60_000).toISOString();
const run = (over) => ({ id: 1, head_sha: TIP, status: 'completed', conclusion: 'success', updated_at: minsAgo(2), ...over });
const verdict = (args) => landVerdict({ nowMs: NOW, ...args });

test('ref gone after being seen means landed, unless its run went red', () => {
  assert.equal(verdict({ refSha: null, lastSha: TIP, run: run({ status: 'in_progress', conclusion: null }) }).verdict, 'landed');
  assert.equal(verdict({ refSha: null, lastSha: TIP, run: null }).verdict, 'landed');
  const byHand = verdict({ refSha: null, lastSha: TIP, run: run({ conclusion: 'failure' }) });
  assert.equal(byHand.verdict, 'unknown', 'deleted after a refusal is not a landing');
  const olderRed = verdict({ refSha: null, lastSha: TIP, run: run({ head_sha: 'f'.repeat(40), conclusion: 'failure' }) });
  assert.equal(olderRed.verdict, 'landed', 'a red run for an older tip says nothing about the tip that went');
});

test('a ref missing from the first poll needs a RECENT green run to count as landed', () => {
  assert.equal(verdict({ refSha: null, run: null }).verdict, 'unknown', 'typo');
  const before = verdict({ refSha: null, run: run() });
  assert.equal(before.verdict, 'landed');
  assert.equal(before.before, true);
  assert.equal(verdict({ refSha: null, run: run({ updated_at: minsAgo(60 * 24 * 7) }) }).verdict, 'unknown', 'reused name, weeks-old run');
  assert.equal(verdict({ refSha: null, run: run({ conclusion: 'failure' }) }).verdict, 'unknown', 'never pushed, last run red');
});

test('a red run for the current tip is a refusal (the case the ref-only loop missed for ~1h)', () => {
  for (const conclusion of ['failure', 'timed_out', 'startup_failure', 'action_required', 'stale']) {
    const v = verdict({ refSha: TIP, run: run({ conclusion }) });
    assert.equal(v.verdict, 'refused', conclusion);
    assert.match(v.why, new RegExp(conclusion));
  }
});

test('a cancelled run is an eviction: keep waiting, name the retry, flag it once stale', () => {
  const fresh = verdict({ refSha: TIP, run: run({ id: 37260205885, conclusion: 'cancelled' }) });
  assert.equal(fresh.verdict, 'waiting');
  assert.match(fresh.why, /land-retry-cancelled\.js --run=37260205885/);
  const stale = verdict({ refSha: TIP, run: run({ id: 37260205885, conclusion: 'cancelled', updated_at: minsAgo(45) }) });
  assert.equal(stale.verdict, 'waiting');
  assert.match(stale.why, /30\+ min ago and not re-run/);
});

test('a red run for an OLDER tip says nothing about a fresh push', () => {
  const v = verdict({ refSha: TIP, run: run({ head_sha: 'f'.repeat(40), conclusion: 'failure' }) });
  assert.equal(v.verdict, 'waiting');
});

test('queued, in-progress, missing and green-but-ref-still-there all keep waiting', () => {
  assert.equal(verdict({ refSha: TIP, run: run({ status: 'queued', conclusion: null }) }).verdict, 'waiting');
  assert.equal(verdict({ refSha: TIP, run: run({ status: 'in_progress', conclusion: null }) }).verdict, 'waiting');
  assert.equal(verdict({ refSha: TIP, run: null }).verdict, 'waiting');
  assert.equal(verdict({ refSha: TIP, run: run({ conclusion: 'success' }) }).verdict, 'waiting');
  assert.equal(verdict({ refSha: TIP, run: run({ conclusion: 'skipped' }) }).verdict, 'waiting', 'skipped/neutral wait out the timeout');
});

test('parseArgs takes a land/ ref and a positive whole-minute timeout', () => {
  assert.deepEqual(parseArgs(['land/bro-4619-welcome-onboarding']), { ref: 'land/bro-4619-welcome-onboarding', timeoutMin: 60, prodMin: null });
  assert.deepEqual(parseArgs(['land/job/linear-BRO-2067-muuqf9tn', '30']), { ref: 'land/job/linear-BRO-2067-muuqf9tn', timeoutMin: 30, prodMin: null });
  assert.equal(parseArgs([]), null);
  assert.equal(parseArgs(['bro-4619-welcome-onboarding']), null, 'bare branch name, the same mistake that broke a land.yml dispatch');
  assert.equal(parseArgs(['land/x', '0']), null);
  assert.equal(parseArgs(['land/x', '08']), null);
  assert.equal(parseArgs(['land/x;rm -rf /']), null);
});

// BRO-5836: --prod keeps waiting past LANDED until the change is live, so a
// session does not stop at LANDED and idle NOT SAFE TO EXIT for days.
test('parseArgs takes --prod anywhere, with an optional whole-minute budget', () => {
  assert.deepEqual(parseArgs(['land/x', '60', '--prod']), { ref: 'land/x', timeoutMin: 60, prodMin: 40 });
  assert.deepEqual(parseArgs(['--prod=25', 'land/x']), { ref: 'land/x', timeoutMin: 60, prodMin: 25 });
  assert.equal(parseArgs(['land/x', '--prod=0']), null);
  assert.equal(parseArgs(['land/x', '--prod=abc']), null);
  assert.equal(parseArgs(['land/x', '60', '30']), null, 'a stray positional is a typo, not ignored');
});

test('prodPlan skips the wait only when the branch provably changes no deploy-gate path', () => {
  const main = 'b'.repeat(40);
  const none = prodPlan({ mainSha: main, siteFiles: [] });
  assert.equal(none.watch, false);
  assert.equal(none.nothingToDeploy, true, 'a hooks/docs-only landing never deploys before the 6h backstop');
  assert.equal(prodPlan({ mainSha: main, siteFiles: ['src/app/page.tsx'] }).watch, true);
  assert.equal(prodPlan({ mainSha: main, siteFiles: null }).watch, true, 'ref never seen (landed before the wait) or diff failed: wait');
  const noMain = prodPlan({ mainSha: null, siteFiles: [] });
  assert.equal(noMain.watch, false);
  assert.notEqual(noMain.nothingToDeploy, true, 'no main tip is unchecked, never "nothing to deploy"');
});

test('prodVerdict: live, not yet, and can-not-tell are three different things', () => {
  const at = { nowMs: 0, deadlineMs: 1000 };
  assert.equal(prodVerdict({ checkExit: 0, errors: 0, ...at }).verdict, 'live');
  assert.equal(prodVerdict({ checkExit: 1, errors: 0, ...at }).verdict, 'waiting');
  assert.equal(prodVerdict({ checkExit: 2, errors: 1, ...at }).verdict, 'waiting', 'one failed check is retried');
  assert.equal(prodVerdict({ checkExit: 2, errors: 3, ...at }).verdict, 'gave-up', 'a 403 loop stops early instead of burning the budget');
  assert.equal(prodVerdict({ checkExit: -1, errors: 3, ...at }).verdict, 'gave-up', 'a killed check counts as can-not-tell');
  assert.equal(prodVerdict({ checkExit: 1, errors: 0, nowMs: 1000, deadlineMs: 1000 }).verdict, 'gave-up');
  assert.equal(prodVerdict({ checkExit: 0, errors: 0, nowMs: 5000, deadlineMs: 1000 }).verdict, 'live', 'live on the last check still counts');
});

test('sitePathsIn reads SITE_PATHS as git pathspecs and refuses a possibly-cut file list', () => {
  assert.deepEqual(sitePathsIn(['.claude/hooks/verify-edits.sh', 'docs/x.md', '.github/workflows/land.yml']), [], 'hooks/docs/workflows never deploy');
  assert.deepEqual(sitePathsIn(['src/app/page.tsx', 'docs/x.md']), ['src/app/page.tsx']);
  assert.deepEqual(sitePathsIn(['scripts/lib/wait-for-land.js']), ['scripts/lib/wait-for-land.js'], 'scripts/ is a deploy path (prebuild)');
  assert.deepEqual(sitePathsIn(['package.json', 'package.json.bak', 'srcs/x']), ['package.json'], 'files match exactly, directories by prefix');
  assert.equal(sitePathsIn(Array.from({ length: 300 }, (_, i) => `docs/${i}.md`)), null, 'the compare API caps files at 300');
  assert.equal(sitePathsIn(null), null);
});
