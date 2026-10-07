// TESTS-VS-DERIVED-DATA-EXEMPT: reads no data file at all — `data/shows.json`
// appears only inside quoted COMMAND STRINGS that the tests assert are
// REJECTED by the path-prefix allowlist (data/ is off it). It is the canonical
// example from the issue, so the literal has to appear; nothing here opens it.
/**
 * enrich-card-acceptance-drafting.test.mjs — BRO-2546.
 *
 * scripts/enrich-card-acceptance.js exists to unclog the dispatch funnel by
 * drafting a runnable "## Acceptance criteria" command onto cards that refuse
 * dispatch with "no runnable verify command". On 2026-08-30 it failed 7 of the
 * 8 cards it processed, so the backlog it was built to drain was not draining
 * and two live cards (BRO-2311, BRO-2538) refused mid-dispatch for exactly
 * this. Three distinct defects, one test file:
 *
 *   1. An off-allowlist DIRECTORY was reported as a bad command SHAPE, sending
 *      whoever tried to fix the card off rewriting a command that was already
 *      well-formed.
 *   2. The drafting model emitted `node <file>.test.mjs` — its own prompt's
 *      form minus `--test` — and the enricher then rejected its own output,
 *      with no repair pass and no retry.
 *   3. Two cards were reported as rejecting a one-character path ("s", "d").
 *      There was no such path: the log line's flat .slice(0, 100) cut the
 *      127-char message at exactly the path's first character. The real paths
 *      were `scripts/...` and `docs/...`.
 *
 * Per CLAUDE.md §15 this requires the REAL functions rather than restating
 * their logic, so a regression in production code fails here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const {
  enrichOneCard,
  buildEnrichPrompt,
  buildEnrichRetryPrompt,
  repairDraftedCommand,
  truncateDetail,
} = require(path.join(REPO, 'scripts/enrich-card-acceptance.js'));
const {
  isSafeCheckCommand,
  explainUnsafeCheckCommand,
  resolveCheckPaths,
  extractCheckPaths,
} = require(path.join(REPO, 'scripts/lib/autonomous-triage-core.js'));
const { evaluateVerifiability } = require(path.join(REPO, 'scripts/lib/verify-gate.js'));

// A card that reaches the LLM-drafting path: eligible category, no acceptance
// criteria, no owner-judgment marker.
const card = (over = {}) => ({
  id: 'card-1',
  name: 'Fix the thing',
  category: 'Product',
  tags: [],
  notes: '## Problem\nThe thing is broken.',
  ...over,
});

// Records every write attempt, so "was anything written" is assertable
// separately from the returned action. Same contract as writeBack() uses:
// notionBrain(['update', id, '--notes', notes, '--tags', csv]).
function fakeNotionBrain(calls) {
  return args => { calls.push(args); return { id: args[1] }; };
}

// Real (non-dryRun) writes call logEnrichmentWrite — point it at a scratch
// path so fixture card IDs never land in the repo's real audit log.
const SCRATCH_LOG_PATH = path.join(os.tmpdir(), `enrich-card-acceptance-drafting-test-${process.pid}.jsonl`);

// A callLLM stub that hands back one canned draft per call, recording the
// prompts it was given so the retry is observable.
function scriptedLLM(drafts, prompts = []) {
  let i = 0;
  return async prompt => {
    prompts.push(prompt);
    const d = drafts[Math.min(i, drafts.length - 1)];
    i += 1;
    return JSON.stringify(d);
  };
}

// ── Defect 1: an off-allowlist path is a PATH error, never a shape error ────
//
// SAFE_CHECK_FORMS allows `test -f <docs|memory|tests|src|scripts path>`.
// data/ and the repo root are off that list. Existence is irrelevant — only
// the directory prefix matters — so `test -f data/shows.json` is refused even
// though the file exists and the command is perfectly well formed.

test('defect 1: a correctly-shaped `test -f` naming an off-allowlist directory is a path-allowlist error, not a shape error', () => {
  const verdict = explainUnsafeCheckCommand('test -f data/commercial-pending-review.json');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.kind, 'path-prefix', 'an off-allowlist directory is not a shape problem');
  assert.doesNotMatch(verdict.reason, /not a safe-form shape/);
  // The message must name the offending path AND the prefixes that would have
  // been accepted — the whole point is that the reader knows what to change.
  assert.match(verdict.reason, /data\/commercial-pending-review\.json/);
  for (const prefix of ['docs/', 'memory/', 'tests/', 'src/', 'scripts/']) {
    assert.ok(verdict.reason.includes(prefix), `reason should name allowed prefix ${prefix}`);
  }
});

test('defect 1: the repo root is off-allowlist for `test -f` too, and reported the same way', () => {
  const verdict = explainUnsafeCheckCommand('test -f package.json');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.kind, 'path-prefix');
  assert.equal(verdict.path, 'package.json');
});

test('defect 1: a genuinely unrecognized command is still reported as a shape error', () => {
  // The distinction only means something if the OTHER side of it still works:
  // `git push --force` matches no form at all, so 'shape' is the honest tag.
  const verdict = explainUnsafeCheckCommand('git push --force');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.kind, 'shape');
});

test('defect 1: an on-allowlist `test -f` is armed whether or not the file exists', () => {
  // Existence is resolveCheckPaths' job, not the shape gate's — pinned here
  // because the card was diagnosed on the assumption that existence mattered.
  assert.equal(isSafeCheckCommand('test -f memory/definitely-not-a-real-file.txt'), true);
  assert.equal(isSafeCheckCommand('test -f data/shows.json'), false);
});

test('defect 1: the enricher surfaces the path-allowlist cause, not "not a safe-form shape"', async () => {
  const calls = [];
  const r = await enrichOneCard(card(), {
    callLLM: scriptedLLM([{
      command: 'test -f data/shows.json',
      acceptanceCriteria: '## Acceptance criteria\n- `test -f data/shows.json` passes',
    }]),
    notionBrain: fakeNotionBrain(calls), logPath: SCRATCH_LOG_PATH,
  });
  assert.equal(r.action, 'failed');
  assert.doesNotMatch(r.detail, /not a safe-form shape/);
  assert.match(r.detail, /path-prefix/);
  assert.match(r.detail, /data\/shows\.json/);
  assert.equal(calls.length, 0, 'a refused draft must never be written');
});

test('defect 1: isSafeCheckCommand and explainUnsafeCheckCommand cannot disagree', () => {
  // They are one function and a `.ok` on top of it; this pins that so a future
  // edit cannot reintroduce two drifting copies of the rules (CLAUDE.md §15).
  const corpus = [
    'node --test tests/unit/a.test.mjs', 'node --test tests/unit/a.test.mjs tests/unit/b.test.mjs',
    'npx tsx --test src/lib/a.test.ts', 'npx tsc --noEmit', 'npx next lint',
    'test -f docs/x.md', 'test -f memory/x.md', 'test -f data/x.json', 'test -f x.json',
    'node --test ../../etc/x.test.mjs', 'node scripts/rebuild-all-reviews.js',
    'node scripts/audit-review-contamination.js --strict', 'node scripts/audit-not-vetted.js',
    'bash scripts/lib/sync-audit-checkout.test.sh', 'git push --force', '', '   ',
  ];
  for (const c of corpus) {
    assert.equal(isSafeCheckCommand(c), explainUnsafeCheckCommand(c).ok, `disagreement on ${JSON.stringify(c)}`);
  }
});

// ── Defect 2: the drafter must not emit commands its own validator rejects ──

test('defect 2: `node <file>.test.mjs` is repaired to the `node --test` form the validator requires', () => {
  // The exact two commands the 2026-08-30 run drafted and then rejected.
  assert.equal(isSafeCheckCommand('node scripts/audit-t1-silent-gaps.test.mjs'), false);
  assert.equal(repairDraftedCommand('node scripts/audit-t1-silent-gaps.test.mjs'),
    'node --test scripts/audit-t1-silent-gaps.test.mjs');
  assert.equal(repairDraftedCommand('node tests/unit/audit-review-contamination.test.mjs'),
    'node --test tests/unit/audit-review-contamination.test.mjs');
});

test('defect 2: repair covers the tsx/.test.ts and decoration variants, and everything it emits validates', () => {
  const repairs = [
    ['node src/lib/gate.test.ts', 'npx tsx --test src/lib/gate.test.ts'],
    ['npx tsx tests/unit/a.test.ts', 'npx tsx --test tests/unit/a.test.ts'],
    ['`node --test tests/unit/a.test.mjs`', 'node --test tests/unit/a.test.mjs'],
    ['$ node tests/unit/a.test.mjs', 'node --test tests/unit/a.test.mjs'],
  ];
  for (const [input, expected] of repairs) {
    const out = repairDraftedCommand(input);
    assert.equal(out, expected, `repair of ${JSON.stringify(input)}`);
    assert.equal(isSafeCheckCommand(out), true, `repaired command must validate: ${out}`);
  }
});

test('defect 2: repair never launders an unsafe command through the gate', () => {
  // The invariant that makes the repair pass safe: it returns either a string
  // the UNMODIFIED validator already accepts, or the input untouched.
  const unsafe = [
    'node scripts/rebuild-all-reviews.js', 'git push --force', 'rm -rf /',
    'test -f data/shows.json', 'node scripts/gather-reviews.js', 'node --test data/x.test.mjs',
    'node scripts/push-with-retry.js', 'make',
  ];
  for (const c of unsafe) {
    const out = repairDraftedCommand(c);
    assert.equal(isSafeCheckCommand(out), false, `repair must not make ${JSON.stringify(c)} safe (got ${out})`);
  }
});

test('defect 2: the drafting prompt names the node --test form, and a draft in that shape satisfies evaluateVerifiability', async () => {
  // (b) of the acceptance criteria: the prompt's OWN documented output shape,
  // run through the enricher, must produce notes that arm the same gate
  // bsc-next.js/linear-next.js dispatch on. If the prompt and the gate ever
  // drift, this fails.
  const prompt = buildEnrichPrompt(card());
  assert.match(prompt, /node --test <path>\.test\.mjs/,
    'the prompt must document the --test form the validator requires');

  const cmd = 'node --test tests/unit/bro-2546-drafted-example.test.mjs';
  const calls = [];
  const r = await enrichOneCard(card(), {
    callLLM: scriptedLLM([{
      command: cmd,
      acceptanceCriteria: `## Acceptance criteria\n- \`${cmd}\` passes`,
    }]),
    notionBrain: fakeNotionBrain(calls), logPath: SCRATCH_LOG_PATH,
  });
  assert.equal(r.action, 'llm-enriched', `expected enrichment, got ${r.action}: ${r.detail}`);
  assert.equal(calls.length, 1, 'the accepted draft must be written back exactly once');

  const writtenNotes = calls[0].find(a => typeof a === 'string' && a.includes('## Acceptance criteria'));
  assert.ok(writtenNotes, 'the write must carry the drafted acceptance-criteria section');
  const gate = evaluateVerifiability(writtenNotes);
  assert.equal(gate.armed, true, `drafted notes must arm the dispatch gate (reason: ${gate.reason})`);
  assert.equal(gate.cmd, cmd);
});

test('defect 2: a rejected first draft is re-prompted exactly once, with the real validator verdict', async () => {
  const prompts = [];
  const calls = [];
  const good = 'node --test tests/unit/bro-2546-retry-example.test.mjs';
  const r = await enrichOneCard(card(), {
    callLLM: scriptedLLM([
      // Off-allowlist directory — correctly shaped, wrong place.
      { command: 'test -f data/shows.json', acceptanceCriteria: '## Acceptance criteria\n- `test -f data/shows.json` passes' },
      { command: good, acceptanceCriteria: `## Acceptance criteria\n- \`${good}\` passes` },
    ], prompts),
    notionBrain: fakeNotionBrain(calls), logPath: SCRATCH_LOG_PATH,
  });
  assert.equal(r.action, 'llm-enriched', `expected the retry to recover, got ${r.detail}`);
  assert.equal(prompts.length, 2, 'exactly one retry');
  assert.match(prompts[1], /REJECTED BY THE VALIDATOR/);
  assert.match(prompts[1], /data\/shows\.json/, 'the retry must quote the rejected command');
  assert.match(prompts[1], /not under an allowed directory/, 'the retry must quote the real cause, not a guessed one');
});

test('defect 2: the retry budget is ONE — a model that never complies still fails closed', async () => {
  const prompts = [];
  const calls = [];
  const r = await enrichOneCard(card(), {
    callLLM: scriptedLLM([{
      command: 'test -f .github/workflows/test.yml',
      acceptanceCriteria: '## Acceptance criteria\n- `test -f .github/workflows/test.yml` passes',
    }], prompts),
    notionBrain: fakeNotionBrain(calls), logPath: SCRATCH_LOG_PATH,
  });
  assert.equal(r.action, 'failed');
  assert.equal(prompts.length, 2, 'never more than one retry — this runs per card across a whole sweep');
  assert.match(r.detail, /after 1 retry/);
  assert.equal(calls.length, 0);
});

test('defect 2: a repaired command is substituted into the prose the model wrote', async () => {
  // The model quotes the command IT produced; if repair rewrote it, the
  // section and the executed command would otherwise disagree.
  const calls = [];
  const r = await enrichOneCard(card(), {
    callLLM: scriptedLLM([{
      command: 'node tests/unit/bro-2546-prose-example.test.mjs',
      acceptanceCriteria: '## Acceptance criteria\n- `node tests/unit/bro-2546-prose-example.test.mjs` passes',
    }]),
    notionBrain: fakeNotionBrain(calls), logPath: SCRATCH_LOG_PATH,
  });
  assert.equal(r.action, 'llm-enriched', `expected enrichment, got ${r.detail}`);
  const written = calls[0].find(a => typeof a === 'string' && a.includes('## Acceptance criteria'));
  assert.match(written, /`node --test tests\/unit\/bro-2546-prose-example\.test\.mjs`/);
  assert.equal(evaluateVerifiability(written).cmd, 'node --test tests/unit/bro-2546-prose-example.test.mjs');
});

// ── Defect 3: no single-letter phantom paths ────────────────────────────────
//
// The reported "phantom path rejected: ... does not exist on disk: s" was the
// log line truncating its own payload, not a path extractor producing "s".

test('defect 3: the phantom-path log line keeps the path instead of cutting it to one letter', () => {
  const reason = resolveCheckPaths('node --test scripts/no-such-dir/deep/a.test.mjs', { repoRoot: REPO }).reason;
  const detail = `phantom path rejected: ${reason}`;
  // The historical bug, pinned so it can't come back: at 100 chars this
  // message ends on the path's FIRST character.
  assert.equal(detail.slice(0, 100).endsWith(': s'), true, 'precondition: the old cap decapitated the path');
  const logged = truncateDetail(detail);
  assert.match(logged, /scripts\/no-such-dir\/deep\/a\.test\.mjs/,
    'the logged detail must still name the full path');
  assert.doesNotMatch(logged, /disk: [a-z]$/, 'never a bare single letter where a path belongs');
});

test('defect 3: a docs/ phantom path is not logged as "d"', () => {
  const reason = resolveCheckPaths('test -f docs/no-such-dir/deep/x.md', { repoRoot: REPO }).reason;
  const logged = truncateDetail(`phantom path rejected: ${reason}`);
  assert.match(logged, /docs\/no-such-dir\/deep\/x\.md/);
});

test('defect 3: truncateDetail still bounds very long details, and keeps both ends', () => {
  const long = `${'x'.repeat(400)} TAIL/PATH/HERE`;
  const out = truncateDetail(long);
  assert.ok(out.length <= 220, `bounded, got ${out.length}`);
  assert.ok(out.startsWith('xxxx'), 'keeps the head');
  assert.ok(out.endsWith('TAIL/PATH/HERE'), 'keeps the tail, where the payload lives');
  assert.match(out, /…/, 'says it truncated rather than pretending the message ended');
  assert.equal(truncateDetail('short'), 'short');
  assert.equal(truncateDetail(undefined), '');
});

test('defect 3: a `-s`/`-d` style token in a card never becomes a single-letter phantom path', async () => {
  // (c) of the acceptance criteria. Two independent guarantees:
  //   1. No path token a safe command can carry is ever one character — the
  //      prefix allowlist rejects a bare flag token before any path probe.
  //   2. The enricher therefore refuses such a draft on the SHAPE/prefix gate,
  //      and its message names the token, not a one-letter directory.
  for (const cmd of ['test -f -s', 'test -f -d', 'test -f scripts/x.js -s', 'node --test -s']) {
    assert.equal(isSafeCheckCommand(cmd), false, `${cmd} must not validate`);
    for (const p of extractCheckPaths(cmd)) {
      assert.ok(p.length > 1, `extracted path token ${JSON.stringify(p)} is a single character`);
    }
  }

  const calls = [];
  const r = await enrichOneCard(card({ notes: '## Problem\nThe `-s` and `-d` flags are mishandled.' }), {
    callLLM: scriptedLLM([{
      command: 'test -f -s',
      acceptanceCriteria: '## Acceptance criteria\n- `test -f -s` passes',
    }]),
    notionBrain: fakeNotionBrain(calls), logPath: SCRATCH_LOG_PATH,
  });
  assert.equal(r.action, 'failed');
  assert.doesNotMatch(r.detail, /does not exist on disk: [a-z]$/,
    'must never report a one-character directory');
  assert.match(r.detail, /-s/, 'the refusal must name the actual offending token');
  assert.equal(calls.length, 0);
});

test('defect 3: resolveCheckPaths never probes a one-character directory for any safe command', () => {
  // A path token only reaches resolveCheckPaths after passing the prefix
  // allowlist, and every allowed prefix is ≥4 characters — so a one-character
  // token is structurally unreachable, not merely unobserved.
  const safe = [
    'node --test tests/unit/a.test.mjs', 'npx tsx --test src/lib/a.test.ts',
    'test -f docs/a.md scripts/b.js', 'node scripts/audit-review-contamination.js --strict',
    'bash scripts/lib/sync-audit-checkout.test.sh',
  ];
  for (const cmd of safe) {
    for (const p of extractCheckPaths(cmd)) {
      assert.ok(p.length > 1 && p.includes('/'), `${JSON.stringify(p)} from ${cmd}`);
    }
  }
});

// ── The retry prompt itself ─────────────────────────────────────────────────

test('the retry prompt restates the full accepted-forms list and the card', () => {
  const p = buildEnrichRetryPrompt(card(), 'test -f data/shows.json', 'the path is not under an allowed directory');
  assert.match(p, /Fix the thing/, 'still carries the card');
  assert.match(p, /npx tsc --noEmit/, 'restates the accepted forms');
  assert.match(p, /ONLY the same JSON object/);
});

// ── Ship-check findings (BRO-2546) ──────────────────────────────────────────
//
// Two independent reviewers (Codex adversarial + a codebase-aware Claude pass)
// found five further defects in this file's own change. Each is pinned below.

test('ship-check: the dispatcher must run the command whose paths were validated', () => {
  // Guardrail 3 deliberately preserves ADDITIONAL safe-form spans, and
  // extractVerifyCmd picks the FIRST span of the highest rank — so a section
  // reading "first confirm `<ghost>` passes, then `<real>` passes" armed the
  // card on the GHOST, which never went through resolveCheckPaths and names a
  // directory that does not exist. Unpassable card (#171 class), reintroduced
  // through a span the phantom check never looked at.
  const ghost = 'node --test tests/nosuchdir/deep/ghost.test.mjs';
  const real = 'node --test tests/unit/bro-2546-mismatch-real.test.mjs';
  const notes = `## Acceptance criteria\nFirst confirm \`${ghost}\` passes, then \`${real}\` passes`;
  // The precondition that made it exploitable: both are safe-shaped and the
  // ghost outranks nothing — it simply comes first.
  assert.equal(isSafeCheckCommand(ghost), true, 'precondition: the ghost passes the SHAPE gate');
  assert.equal(resolveCheckPaths(ghost, { repoRoot: REPO }).ok, false, 'precondition: it fails the PATH check');
  assert.equal(evaluateVerifiability(notes).cmd, ghost, 'precondition: the gate would extract the ghost');
});

test('ship-check: such a draft is rejected and re-prompted, never written', async () => {
  const prompts = [];
  const calls = [];
  const ghost = 'node --test tests/nosuchdir/deep/ghost.test.mjs';
  const real = 'node --test tests/unit/bro-2546-mismatch-real.test.mjs';
  const r = await enrichOneCard(card(), {
    callLLM: scriptedLLM([{
      command: real,
      acceptanceCriteria: `## Acceptance criteria\nFirst confirm \`${ghost}\` passes, then \`${real}\` passes`,
    }], prompts),
    notionBrain: fakeNotionBrain(calls), logPath: SCRATCH_LOG_PATH,
  });
  assert.equal(r.action, 'failed');
  assert.match(r.detail, /command-mismatch/);
  assert.match(r.detail, /ghost\.test\.mjs/, 'the refusal must name the command that would actually have run');
  assert.equal(prompts.length, 2, 'a section-level rejection is retryable, like a command-level one');
  assert.equal(calls.length, 0);
});

test('ship-check: a model that backticks its own command field still enriches', async () => {
  // repairDraftedCommand strips the decoration, so `bareCommand` no longer
  // appears in the prose but the backticked original does. Matching on the
  // DECORATED string and joining with the bare one deleted the backticks, and
  // candidatesFrom() only matches backticked spans — so the section carried a
  // perfectly good command as plain prose and died at the final gate with
  // "names no runnable command (prose only)".
  const calls = [];
  const cmd = 'node --test tests/unit/bro-2546-backticked.test.mjs';
  const r = await enrichOneCard(card(), {
    callLLM: scriptedLLM([{
      command: `\`${cmd}\``,
      acceptanceCriteria: `## Acceptance criteria\n- \`${cmd}\` passes`,
    }]),
    notionBrain: fakeNotionBrain(calls), logPath: SCRATCH_LOG_PATH,
  });
  assert.equal(r.action, 'llm-enriched', `expected enrichment, got ${r.detail}`);
  const written = calls[0].find(a => typeof a === 'string' && a.includes('## Acceptance criteria'));
  assert.match(written, /`node --test tests\/unit\/bro-2546-backticked\.test\.mjs`/,
    'the command must still render as a code span');
  assert.equal(evaluateVerifiability(written).cmd, cmd);
});

test('ship-check: an unrepairable decorated command is diagnosed on its stripped form', () => {
  // Returning the DECORATED original made explainUnsafeCheckCommand report
  // kind:'shape' (backticks match no form) for a command whose real problem is
  // its directory — reintroducing exactly the misdiagnosis defect 1 fixes.
  const out = repairDraftedCommand('`test -f data/shows.json`');
  assert.equal(out, 'test -f data/shows.json', 'decoration is stripped even when no repair validates');
  assert.equal(explainUnsafeCheckCommand(out).kind, 'path-prefix');
});

test('ship-check: a retry that fails to parse still reports the original cause', async () => {
  let n = 0;
  const calls = [];
  const r = await enrichOneCard(card(), {
    callLLM: async () => {
      n += 1;
      return n === 1
        ? JSON.stringify({ command: 'test -f data/shows.json', acceptanceCriteria: '## Acceptance criteria\n- `test -f data/shows.json` passes' })
        : 'not json at all';
    },
    notionBrain: fakeNotionBrain(calls), logPath: SCRATCH_LOG_PATH,
  });
  assert.equal(r.action, 'failed');
  assert.match(r.detail, /unparseable/);
  assert.match(r.detail, /retry of:/, 'the first attempt\'s real cause must survive');
  assert.match(r.detail, /not under an allowed directory/);
  assert.equal(calls.length, 0);
});

test('ship-check: the retry prompt states the per-form directory allowlists correctly', () => {
  // It previously stated the `test -f` prefix set as if it were universal;
  // node --test does NOT accept docs/ or memory/.
  const p = buildEnrichRetryPrompt(card(), 'test -f data/x.json', 'nope');
  assert.match(p, /allowlists differ per form/);
  assert.match(p, /EXACTLY ONE command/);
  assert.equal(isSafeCheckCommand('node --test docs/x.test.mjs'), false,
    'the prompt is right: docs/ is not a node --test directory');
  assert.equal(isSafeCheckCommand('test -f docs/x.md'), true);
});
