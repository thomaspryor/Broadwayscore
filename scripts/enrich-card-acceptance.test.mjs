import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  enrichOneCard, spliceNotes,
  selectRefusedLinearIdentifiers, normalizeLinearIssue, makeLinearWriteCard, linearIssueNumber,
  isLinearIssueTerminal, categoryOfLinearIssue,
} = require('./enrich-card-acceptance.js');
// Rule 15: assert against the REAL validator the production path uses, never a
// copy — if isSafeCheckCommand's notion of "safe" drifts, these tests move with
// it instead of silently pinning the old definition.
const { isSafeCheckCommand, evaluateVerifiability } = require('./lib/verify-gate.js');

function fakeNotionBrain(calls) {
  return (args) => { calls.push(args); return { id: args[1] }; };
}

// Real (non-dryRun) writes call logEnrichmentWrite — point it at a scratch
// path so fixture card IDs never land in the repo's real audit log.
const SCRATCH_LOG_PATH = path.join(os.tmpdir(), `enrich-card-acceptance-test-${process.pid}.jsonl`);

test('already-armed card is skipped with zero LLM calls and zero writes', async () => {
  const calls = [];
  let llmCalled = false;
  const card = {
    id: 'a1', name: 'Fix the thing', category: 'Product', tags: [],
    notes: '## Acceptance criteria\n`npx tsc --noEmit`',
  };
  const r = await enrichOneCard(card, {
    callLLM: async () => { llmCalled = true; return '{}'; },
    notionBrain: fakeNotionBrain(calls),
  });
  assert.equal(r.action, 'skipped');
  assert.equal(llmCalled, false);
  assert.equal(calls.length, 0);
});

test('already auto-enriched card is skipped unless --force', async () => {
  const calls = [];
  const card = {
    id: 'a2', name: 'Some prose card', category: 'Product', tags: ['auto-enriched'],
    notes: 'Just prose, no criteria.',
  };
  const r = await enrichOneCard(card, { callLLM: async () => '{}', notionBrain: fakeNotionBrain(calls) });
  assert.equal(r.action, 'skipped');
  assert.equal(calls.length, 0);
});

test('human-only card (marketing category) gets VERIFY: owner-judgment, no LLM call', async () => {
  const calls = [];
  let llmCalled = false;
  const card = {
    id: 'b1', name: 'Pitch kit for industry intros', category: 'Marketing', tags: [],
    notes: '## Problem\nNeed a forwardable blurb.',
  };
  const r = await enrichOneCard(card, {
    callLLM: async () => { llmCalled = true; return '{}'; },
    notionBrain: fakeNotionBrain(calls),
    logPath: SCRATCH_LOG_PATH,
  });
  assert.equal(r.action, 'owner-judgment');
  assert.equal(llmCalled, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'update');
  assert.equal(calls[0][1], 'b1');
  const notesIdx = calls[0].indexOf('--notes');
  assert.match(calls[0][notesIdx + 1], /VERIFY: owner-judgment/);
  const tagsIdx = calls[0].indexOf('--tags');
  assert.match(calls[0][tagsIdx + 1], /auto-enriched/);
});

test('human-action title with no category gets owner-judgment', async () => {
  const calls = [];
  const card = { id: 'b2', name: 'Email volunteers', category: '', tags: [], notes: 'Reach out.' };
  const r = await enrichOneCard(card, { callLLM: async () => '{}', notionBrain: fakeNotionBrain(calls), logPath: SCRATCH_LOG_PATH });
  assert.equal(r.action, 'owner-judgment');
});

// Task #1186: a technical deny-tag rejection (email/commercial/scoring/
// ios-app) is not owner-judgment — it must NOT get the hard-blocking bare
// marker, and must instead reach the same LLM-drafted path an eligible card
// would.
test('deny-tagged technical card (scoring) does NOT get owner-judgment — reaches the LLM path instead', async () => {
  const calls = [];
  let llmCalled = false;
  const card = {
    id: 'd1', name: 'Fix a scoring script bug', category: 'Product', tags: ['scoring'],
    notes: '## Problem\nSomething in the scoring pipeline is wrong.',
  };
  const r = await enrichOneCard(card, {
    callLLM: async () => { llmCalled = true; return JSON.stringify({ command: 'npx tsc --noEmit', acceptanceCriteria: '## Acceptance criteria\n`npx tsc --noEmit` is clean' }); },
    notionBrain: fakeNotionBrain(calls),
    logPath: SCRATCH_LOG_PATH,
  });
  assert.equal(r.action, 'llm-enriched');
  assert.equal(llmCalled, true);
  assert.equal(calls.length, 1);
  const notesIdx = calls[0].indexOf('--notes');
  assert.doesNotMatch(calls[0][notesIdx + 1], /VERIFY: owner-judgment/);
});

// 'owner-action' is the one DENY_TAGS entry that IS genuinely human-territory
// (autonomous-eligibility.js docstring: "cards that need the OWNER
// personally") — it must keep getting the marker, unlike the other deny-tags.
test('owner-action tagged card still gets owner-judgment, no LLM call', async () => {
  const calls = [];
  let llmCalled = false;
  const card = {
    id: 'd2', name: 'Reconnect App Store Connect', category: 'Product', tags: ['owner-action'],
    notes: 'Needs the owner to re-auth.',
  };
  const r = await enrichOneCard(card, {
    callLLM: async () => { llmCalled = true; return '{}'; },
    notionBrain: fakeNotionBrain(calls),
    logPath: SCRATCH_LOG_PATH,
  });
  assert.equal(r.action, 'owner-judgment');
  assert.equal(llmCalled, false);
  const notesIdx = calls[0].indexOf('--notes');
  assert.match(calls[0][notesIdx + 1], /VERIFY: owner-judgment/);
});

test('eligible card: LLM drafts a valid tsc command, notes are updated and re-verified armed', async () => {
  const calls = [];
  const card = {
    id: 'c1', name: 'Fix scoring bug', category: 'Product', tags: [],
    notes: '## Problem\nSomething scores wrong.',
  };
  const r = await enrichOneCard(card, {
    callLLM: async () => JSON.stringify({ command: 'npx tsc --noEmit', acceptanceCriteria: '## Acceptance criteria\n`npx tsc --noEmit` is clean' }),
    notionBrain: fakeNotionBrain(calls),
    logPath: SCRATCH_LOG_PATH,
  });
  assert.equal(r.action, 'llm-enriched');
  assert.equal(r.detail, 'npx tsc --noEmit');
  assert.equal(calls.length, 1);
  const notesIdx = calls[0].indexOf('--notes');
  assert.match(calls[0][notesIdx + 1], /Acceptance criteria/);
  assert.match(calls[0][notesIdx + 1], /npx tsc --noEmit/);
});

test('eligible card: LLM drafts a phantom test path with no real parent dir — rejected, zero writes', async () => {
  const calls = [];
  const card = {
    id: 'c2', name: 'Fix scoring bug', category: 'Product', tags: [],
    notes: '## Problem\nSomething scores wrong.',
  };
  const r = await enrichOneCard(card, {
    callLLM: async () => JSON.stringify({
      command: 'node --test tests/totally-made-up-dir/thing.test.mjs',
      acceptanceCriteria: '## Acceptance criteria\n`node --test tests/totally-made-up-dir/thing.test.mjs` passes',
    }),
    notionBrain: fakeNotionBrain(calls),
  });
  assert.equal(r.action, 'failed');
  assert.match(r.detail, /phantom path rejected/);
  assert.equal(calls.length, 0);
});

test('eligible card: LLM drafts a mutating command — rejected before ever writing', async () => {
  const calls = [];
  const card = {
    id: 'c3', name: 'Fix scoring bug', category: 'Product', tags: [],
    notes: '## Problem\nSomething scores wrong.',
  };
  const r = await enrichOneCard(card, {
    callLLM: async () => JSON.stringify({
      command: 'node scripts/rebuild-all-reviews.js',
      acceptanceCriteria: '## Acceptance criteria\nrun `node scripts/rebuild-all-reviews.js` and check the diff',
    }),
    notionBrain: fakeNotionBrain(calls),
  });
  assert.equal(r.action, 'failed');
  // BRO-2546: the refusal now names the CAUSE the validator actually gave.
  // `node scripts/rebuild-all-reviews.js` really is a shape refusal (it
  // matches no SAFE_CHECK_FORMS regex at all), so 'shape' is the honest tag
  // here — unlike `test -f data/shows.json`, which used to be reported the
  // same way and is not a shape problem. Covered in
  // tests/unit/enrich-card-acceptance-drafting.test.mjs.
  assert.match(r.detail, /draft rejected \(shape\)/);
  assert.match(r.detail, /rebuild-all-reviews\.js/);
  assert.equal(calls.length, 0);
});

// The invariant these two tests defend is "never write a card whose own notes
// document an unsanctioned command" — so they assert on the WRITTEN NOTES, not
// on the return code. Asserting action==='failed' only ever tested the
// response, and would have gone on passing if the demotion path leaked a
// backticked mutating command into the card.
function backtickedSpans(text) {
  return [...String(text || '').matchAll(/`([^`\n]+)`/g)].map(m => m[1].trim());
}

// notion-brain is invoked argv-style, so the written notes are the token AFTER
// '--notes'. Reading calls[0].notes would be undefined, and every regex
// assertion below would vacuously pass against undefined.
function writtenNotes(calls) {
  const idx = calls[0].indexOf('--notes');
  assert.notEqual(idx, -1, 'expected a --notes argument in the write call');
  return calls[0][idx + 1];
}

test('eligible card: a mutating command rides along in the prose — demoted out of command position, never written as a command', async () => {
  const calls = [];
  const card = {
    id: 'c3b', name: 'Fix scoring bug', category: 'Product', tags: [],
    notes: '## Problem\nSomething scores wrong.',
  };
  const r = await enrichOneCard(card, {
    callLLM: async () => JSON.stringify({
      command: 'npx tsc --noEmit',
      acceptanceCriteria: '## Acceptance criteria\nFirst run `node scripts/rebuild-all-reviews.js` to refresh, then verify with `npx tsc --noEmit`.',
    }),
    notionBrain: fakeNotionBrain(calls),
    logPath: SCRATCH_LOG_PATH,
  });
  assert.equal(r.action, 'llm-enriched');
  assert.equal(calls.length, 1);
  const written = writtenNotes(calls);
  // THE INVARIANT: every backticked span in what actually got written is a
  // sanctioned check command.
  const unsafeWritten = backtickedSpans(written).filter(c => !isSafeCheckCommand(c));
  assert.deepEqual(unsafeWritten, [], `unsanctioned command written as a command: ${unsafeWritten.join(', ')}`);
  // The mutating script survives only as prose, never in backticks.
  assert.ok(/rebuild-all-reviews/.test(written), 'prose context should be preserved, not discarded');
  assert.ok(!/`[^`\n]*rebuild-all-reviews[^`\n]*`/.test(written), 'rebuild-all-reviews must not remain backticked');
  assert.ok(r.demotedSpans.some(s => /rebuild-all-reviews/.test(s)), 'demotion should be reported in the result');
});

// task #1713: a narrower guardrail-3 filter (only flag backtick spans with
// whitespace or /) was tried to reduce false-positive rejections of bare
// identifiers like `wrongProduction`, then REVERTED after adversarial review
// pointed out a single PATH executable (e.g. `make`) is a valid unsafe
// command with neither. The DETECTOR still has to fire on `make` — that part
// of #1713 stands. What this test now pins is that firing means "demote it to
// prose", not "let it through backticked": the failure #1713 reintroduced was
// `make` reaching the card still in command position, and that must never
// happen whichever way the guardrail responds.
test('eligible card: an unsafe SINGLE-TOKEN command in backticks (`make`) is still detected and never written as a command', async () => {
  const calls = [];
  const card = {
    id: 'c7', name: 'Fix scoring bug', category: 'Product', tags: [],
    notes: '## Problem\nSomething scores wrong.',
  };
  const r = await enrichOneCard(card, {
    callLLM: async () => JSON.stringify({
      command: 'npx tsc --noEmit',
      acceptanceCriteria: '## Acceptance criteria\nRun `make` to rebuild first, then verify with `npx tsc --noEmit`.',
    }),
    notionBrain: fakeNotionBrain(calls),
    logPath: SCRATCH_LOG_PATH,
  });
  assert.equal(calls.length, 1);
  const written = writtenNotes(calls);
  const unsafeWritten = backtickedSpans(written).filter(c => !isSafeCheckCommand(c));
  assert.deepEqual(unsafeWritten, [], `unsanctioned command written as a command: ${unsafeWritten.join(', ')}`);
  assert.ok(!/`make`/.test(written), '`make` must not survive in backticks');
  assert.ok(r.demotedSpans.includes('make'), 'the detector must still have fired on `make`');
});

test('guardrail 3: a bare identifier the LLM backticked (wrongProduction) no longer costs the whole card', async () => {
  const calls = [];
  const card = {
    id: 'c7b', name: 'Fix stale flag', category: 'Product', tags: [],
    notes: '## Problem\nA flag goes stale.',
  };
  const r = await enrichOneCard(card, {
    callLLM: async () => JSON.stringify({
      command: 'npx tsc --noEmit',
      acceptanceCriteria: '## Acceptance criteria\nThe `wrongProduction` flag clears; verify with `npx tsc --noEmit`.',
    }),
    notionBrain: fakeNotionBrain(calls),
    logPath: SCRATCH_LOG_PATH,
  });
  assert.equal(r.action, 'llm-enriched');
  assert.equal(calls.length, 1);
  const unsafeWritten = backtickedSpans(writtenNotes(calls)).filter(c => !isSafeCheckCommand(c));
  assert.deepEqual(unsafeWritten, []);
  assert.ok(/wrongProduction/.test(writtenNotes(calls)), 'identifier should survive as prose');
});

// The demotion path's whole safety argument is "candidatesFrom() only matches
// backticked spans, so a demoted span is structurally no longer a candidate."
// The obvious attack on that argument is BACKTICK RE-PAIRING: if rewriting one
// span lets the surrounding backticks re-pair into a NEW span, an unsanctioned
// command could reappear in command position. These inputs attack exactly that
// (double backticks, odd counts, adjacent spans, fenced blocks, embedded
// quotes). The assertion is the invariant itself, not any particular verdict —
// a case may legitimately either write-with-only-sanctioned-spans OR fail
// closed with zero writes; what it may never do is write an unsanctioned
// command. Two of these (``make``, odd counts) do currently fail closed, and
// that is the recheck working, not a bug.
// Adversarial review (Codex, 2026-08-20) found this class, and it is the one
// the fuzz list below could NOT have caught, because that list reused the
// detector's own newline-excluding regex to check its results — a blind spot
// checking itself. CommonMark inline code may straddle a line ending, so
// `rm -rf /\n` renders as a command to a human but is invisible to
// candidatesFrom(). Measured against unmodified main: the no-decoy form was
// ALREADY written verbatim there, so this closes a pre-existing hole rather
// than one this change introduced.
//
// These assertions deliberately scan with a NEWLINE-TOLERANT regex — checking
// the written card the way Markdown renders it, not the way the detector
// happens to read it.
const renderedCodeSpans = (t) => [...String(t || '').matchAll(/`([^`]+)`/g)]
  .map(m => m[1].trim().replace(/\s+/g, ' '));

const MULTILINE_ATTACKS = [
  ['multiline span alone', '## Acceptance criteria\n`rm -rf /\n`\n`npx tsc --noEmit`'],
  ['multiline span behind a single-line decoy', '## Acceptance criteria\n`wrongProduction`\n`rm -rf /\n`\n`npx tsc --noEmit`'],
  ['multiline span wrapping a script', '## Acceptance criteria\n`node\nscripts/rebuild-all-reviews.js`\nthen `npx tsc --noEmit`'],
];

for (const [label, acceptanceCriteria] of MULTILINE_ATTACKS) {
  test(`guardrail 3: a code span straddling a newline never reaches the card as a command: ${label}`, async () => {
    const calls = [];
    await enrichOneCard(
      { id: `ml-${label}`, name: 'Fix thing', category: 'Product', tags: [], notes: '## Problem\nx.' },
      {
        callLLM: async () => JSON.stringify({ command: 'npx tsc --noEmit', acceptanceCriteria }),
        notionBrain: fakeNotionBrain(calls),
        logPath: SCRATCH_LOG_PATH,
      },
    );
    if (!calls.length) return; // failed closed — also acceptable
    const unsafeRendered = renderedCodeSpans(writtenNotes(calls)).filter(c => !isSafeCheckCommand(c));
    assert.deepEqual(unsafeRendered, [],
      `card renders an unsanctioned command as code: ${unsafeRendered.join(', ')}`);
  });
}

const REPAIRING_ATTACKS = [
  ['double backticks', '## Acceptance criteria\nRun ``make`` first, then `npx tsc --noEmit`.'],
  ['odd backtick count', '## Acceptance criteria\nRun `make` c ` d, then `npx tsc --noEmit`.'],
  ['two unsafe spans', '## Acceptance criteria\nRun `make` and `node scripts/push-x.js`, then `npx tsc --noEmit`.'],
  ['span containing a quote', "## Acceptance criteria\nRun `it's-a-script.sh`, then `npx tsc --noEmit`."],
  ['adjacent spans', '## Acceptance criteria\n`make``rm -rf /` then `npx tsc --noEmit`.'],
  ['fenced code block', '## Acceptance criteria\n```\nmake install\n```\nthen `npx tsc --noEmit`.'],
  ['backtick inside a span', '## Acceptance criteria\nRun `a`b`c` then `npx tsc --noEmit`.'],
  ['unsafe span after the command', '## Acceptance criteria\n`npx tsc --noEmit` then cleanup with `rm -rf node_modules`.'],
  ['nested quotes', "## Acceptance criteria\nRun `echo 'hi'` then `npx tsc --noEmit`."],
  ['only an unsafe span', '## Acceptance criteria\nJust run `make`.'],
];

for (const [label, acceptanceCriteria] of REPAIRING_ATTACKS) {
  test(`guardrail 3 invariant holds under backtick re-pairing: ${label}`, async () => {
    const calls = [];
    await enrichOneCard(
      { id: `adv-${label}`, name: 'Fix thing', category: 'Product', tags: [], notes: '## Problem\nx.' },
      {
        callLLM: async () => JSON.stringify({ command: 'npx tsc --noEmit', acceptanceCriteria }),
        notionBrain: fakeNotionBrain(calls),
        logPath: SCRATCH_LOG_PATH,
      },
    );
    if (!calls.length) return; // failed closed — also acceptable
    const unsafeWritten = backtickedSpans(writtenNotes(calls)).filter(c => !isSafeCheckCommand(c));
    assert.deepEqual(unsafeWritten, [],
      `wrote unsanctioned command(s) in command position: ${unsafeWritten.join(', ')}`);
  });
}

test('guardrail 3: demotions are recorded in the enrichment audit log, not just the truncated console line', async () => {
  const fs = require('node:fs');
  const logPath = path.join(os.tmpdir(), `enrich-demote-log-${process.pid}.jsonl`);
  try { fs.unlinkSync(logPath); } catch { /* first run */ }
  const calls = [];
  const card = {
    id: 'c7d', name: 'Fix scoring bug', category: 'Product', tags: [],
    notes: '## Problem\nSomething scores wrong.',
  };
  await enrichOneCard(card, {
    callLLM: async () => JSON.stringify({
      command: 'npx tsc --noEmit',
      acceptanceCriteria: '## Acceptance criteria\nFirst run `node scripts/rebuild-all-reviews.js`, then verify with `npx tsc --noEmit`.',
    }),
    notionBrain: fakeNotionBrain(calls),
    logPath,
  });
  const entry = JSON.parse(fs.readFileSync(logPath, 'utf8').trim().split('\n').pop());
  assert.ok(Array.isArray(entry.demotedSpans), 'audit entry must carry demotedSpans');
  assert.ok(entry.demotedSpans.some(s => /rebuild-all-reviews/.test(s)),
    'the full demoted span must survive in the log even though the console line truncates it');
  fs.unlinkSync(logPath);
});

// BRO-2546 narrowed this deliberately. The original decision — "an ADDITIONAL
// safe command keeps its backticks, no gratuitous behavior change" — was made
// without knowing that such a span can STEAL the arming slot: extractVerifyCmd
// picks the FIRST span of the highest rank, so the section below arms the card
// on `npx next lint` while the enricher validated, logged and audited
// `npx tsc --noEmit`. Harmless for two path-free repo-wide checks; the same
// shape with a `node --test` span names a test file whose paths were never
// resolved, and the card can never pass (the #171 unpassable-card class).
// So the invariant is now "the command the dispatcher extracts is the command
// whose paths were validated", and a section naming two competing commands is
// re-prompted rather than written. Measured cost on the live 8-card Linear
// sweep: none — still 7 enriched, 0 failed.
test('guardrail 3: a safe extra command that would outrank the validated one is re-prompted, never written', async () => {
  const calls = [];
  let llmCalls = 0;
  const card = {
    id: 'c7c', name: 'Fix types', category: 'Product', tags: [],
    notes: '## Problem\nTypes are wrong.',
  };
  const r = await enrichOneCard(card, {
    callLLM: async () => {
      llmCalls += 1;
      return JSON.stringify({
        command: 'npx tsc --noEmit',
        acceptanceCriteria: '## Acceptance criteria\nAlso `npx next lint` stays clean; verify with `npx tsc --noEmit`.',
      });
    },
    notionBrain: fakeNotionBrain(calls),
    logPath: SCRATCH_LOG_PATH,
  });
  assert.equal(r.action, 'failed');
  assert.match(r.detail, /command-mismatch/);
  assert.match(r.detail, /npx next lint/, 'the refusal must name the command that would actually have run');
  assert.equal(llmCalls, 2, 'a mismatch is retryable — the model gets told to name exactly one command');
  assert.equal(calls.length, 0);
});

test('guardrail 3: a safe extra command that does NOT outrank the validated one keeps its backticks', async () => {
  // The other half of the original decision still holds. `node --test` outranks
  // everything, so the validated command wins the arming slot and the extra
  // safe span is preserved as documentation, undemoted.
  const calls = [];
  const cmd = 'node --test tests/unit/bro-2546-rank.test.mjs';
  const r = await enrichOneCard({
    id: 'c7d', name: 'Fix types', category: 'Product', tags: [],
    notes: '## Problem\nTypes are wrong.',
  }, {
    callLLM: async () => JSON.stringify({
      command: cmd,
      acceptanceCriteria: `## Acceptance criteria\nAlso \`npx next lint\` stays clean; verify with \`${cmd}\`.`,
    }),
    notionBrain: fakeNotionBrain(calls),
    logPath: SCRATCH_LOG_PATH,
  });
  assert.equal(r.action, 'llm-enriched', r.detail);
  assert.ok(/`npx next lint`/.test(writtenNotes(calls)), 'a safe extra command must keep its backticks');
  assert.deepEqual(r.demotedSpans, [], 'nothing should be demoted when every span is safe');
});

// BRO-2232: spliceNotes() only ever rewrites the "## Acceptance criteria"
// section it finds, and the owner-judgment path only ever APPENDS — neither
// examines a VERIFY: line living anywhere else in the card's OWN
// pre-existing notes. But extractVerifyCmd() scopes its command search to
// exactly that section AND every VERIFY: line in the whole text, so a
// pre-existing unsanctioned VERIFY line rode through every write path
// unexamined. This is the exact repro from the Linear issue.
test('BRO-2232: a pre-existing unsanctioned VERIFY line in the card\'s own notes is never written back in command position', async () => {
  const calls = [];
  const card = {
    id: 'bro2232-a', name: 'Fix scoring bug', category: 'Product', tags: [],
    notes: '## Problem\nx.\nVERIFY: `rm -rf /`',
  };
  const r = await enrichOneCard(card, {
    callLLM: async () => JSON.stringify({
      command: 'npx tsc --noEmit',
      acceptanceCriteria: '## Acceptance criteria\n`npx tsc --noEmit` passes',
    }),
    notionBrain: fakeNotionBrain(calls),
    logPath: SCRATCH_LOG_PATH,
  });
  assert.equal(r.action, 'llm-enriched');
  assert.equal(calls.length, 1);
  const written = writtenNotes(calls);
  const unsafeWritten = backtickedSpans(written).filter(c => !isSafeCheckCommand(c));
  assert.deepEqual(unsafeWritten, [], `unsanctioned command written as a command: ${unsafeWritten.join(', ')}`);
  assert.ok(!/`rm -rf \/`/.test(written), 'rm -rf / must not remain backticked');
  assert.ok(r.demotedSpans.includes('rm -rf /'), 'the pre-existing unsafe VERIFY line should be reported as demoted');
});

test('BRO-2232: the owner-judgment write path also strips a pre-existing unsanctioned VERIFY line', async () => {
  const calls = [];
  const card = {
    id: 'bro2232-b', name: 'Pitch kit for industry intros', category: 'Marketing', tags: [],
    notes: '## Problem\nNeed a forwardable blurb.\nVERIFY: `rm -rf /`',
  };
  const r = await enrichOneCard(card, {
    callLLM: async () => { throw new Error('must not be called — human-territory cards skip the LLM'); },
    notionBrain: fakeNotionBrain(calls),
    logPath: SCRATCH_LOG_PATH,
  });
  assert.equal(r.action, 'owner-judgment');
  assert.equal(calls.length, 1);
  const written = writtenNotes(calls);
  const unsafeWritten = backtickedSpans(written).filter(c => !isSafeCheckCommand(c));
  assert.deepEqual(unsafeWritten, [], `unsanctioned command written as a command: ${unsafeWritten.join(', ')}`);
  assert.ok(!/`rm -rf \/`/.test(written), 'rm -rf / must not remain backticked');
});

// A first version of this fix scoped demotion to VERIFY_LINE_RE's single
// line and missed exactly the class of hole guardrail 3 was hardened
// against for the drafted section: CommonMark inline code can straddle a
// line ending within one paragraph, so a backtick opened on the VERIFY:
// line and closed on the NEXT line still renders as one intact command to a
// human/Notion/Linear reader. This must be caught the same as a same-line
// span.
test('BRO-2232: a pre-existing unsafe VERIFY line whose backtick span straddles a newline is still demoted', async () => {
  const calls = [];
  const card = {
    id: 'bro2232-e', name: 'Fix scoring bug', category: 'Product', tags: [],
    notes: '## Problem\nx.\nVERIFY: `rm -rf\n/tmp`',
  };
  const r = await enrichOneCard(card, {
    callLLM: async () => JSON.stringify({
      command: 'npx tsc --noEmit',
      acceptanceCriteria: '## Acceptance criteria\n`npx tsc --noEmit` passes',
    }),
    notionBrain: fakeNotionBrain(calls),
    logPath: SCRATCH_LOG_PATH,
  });
  assert.equal(r.action, 'llm-enriched');
  assert.equal(calls.length, 1);
  const written = writtenNotes(calls);
  const unsafeRendered = renderedCodeSpans(written).filter(c => !isSafeCheckCommand(c));
  assert.deepEqual(unsafeRendered, [], `card renders an unsanctioned command as code: ${unsafeRendered.join(', ')}`);
  assert.ok(r.demotedSpans.some(s => /rm -rf/.test(s)), 'the multiline span should be reported as demoted');
});

// BRO-2585 regression: extractVerifyCmd now also reads a VERIFY: line's raw,
// un-backticked remainder as a candidate. Demotion here only strips the
// span's BACKTICKS (`rm -rf /` -> 'rm -rf /'), so the demoted text still sits
// right after "VERIFY:" — confirm the raw-fallback candidate still can't arm
// the card on it: SAFE_CHECK_FORMS is an allowlist, not a denylist, so the
// demoted prose can never match it, and the write must still land on the
// LLM-validated command, not the demoted one.
test('BRO-2585: a demoted (backtick-stripped) unsafe VERIFY line does not arm via the raw-VERIFY-line candidate path', async () => {
  const calls = [];
  const card = {
    id: 'bro2585-a', name: 'Fix scoring bug', category: 'Product', tags: [],
    notes: '## Problem\nx.\nVERIFY: `rm -rf /`',
  };
  const r = await enrichOneCard(card, {
    callLLM: async () => JSON.stringify({
      command: 'npx tsc --noEmit',
      acceptanceCriteria: '## Acceptance criteria\n`npx tsc --noEmit` passes',
    }),
    notionBrain: fakeNotionBrain(calls),
    logPath: SCRATCH_LOG_PATH,
  });
  assert.equal(r.action, 'llm-enriched');
  const written = writtenNotes(calls);
  const gate = evaluateVerifiability(written);
  assert.equal(gate.armed, true);
  assert.equal(gate.cmd, 'npx tsc --noEmit', 'the armed command must be the validated one, never the demoted VERIFY line');
});

// Note: a card whose pre-existing notes already carry a SAFE VERIFY line
// can't reach either write path at all — evaluateVerifiability() sees that
// safe candidate and arms the card, so it's skipped before any write, same
// as before this change. Nothing to assert there.

// Option 3's scope is deliberately narrow: only VERIFY: lines, not arbitrary
// backticked prose elsewhere in the card. An unsafe-looking backtick span
// OUTSIDE a VERIFY: line is not part of extractVerifyCmd's scan surface at
// all, so it is left untouched rather than rewriting owner-authored text
// that was never going to be read as a command.
test('BRO-2232: a backticked span outside any VERIFY line is left untouched (narrow scope)', async () => {
  const calls = [];
  const card = {
    id: 'bro2232-d', name: 'Fix scoring bug', category: 'Product', tags: [],
    notes: '## Problem\nFor context, someone once ran `rm -rf /` here.',
  };
  const r = await enrichOneCard(card, {
    callLLM: async () => JSON.stringify({
      command: 'npx tsc --noEmit',
      acceptanceCriteria: '## Acceptance criteria\n`npx tsc --noEmit` passes',
    }),
    notionBrain: fakeNotionBrain(calls),
    logPath: SCRATCH_LOG_PATH,
  });
  assert.equal(r.action, 'llm-enriched');
  const written = writtenNotes(calls);
  assert.match(written, /`rm -rf \/`/, 'prose outside a VERIFY line is not part of the executable surface and must be preserved verbatim');
});

test('eligible card: LLM call throws — failed, zero writes', async () => {
  const calls = [];
  const card = { id: 'c4', name: 'Fix scoring bug', category: 'Product', tags: [], notes: '## Problem\nBug.' };
  const r = await enrichOneCard(card, {
    callLLM: async () => { throw new Error('ECONNRESET'); },
    notionBrain: fakeNotionBrain(calls),
  });
  assert.equal(r.action, 'failed');
  assert.match(r.detail, /LLM call failed/);
  assert.equal(calls.length, 0);
});

test('eligible card: LLM names a NEW test under tests/unit/ (real dir) — accepted as a to-be-created artifact', async () => {
  const calls = [];
  const card = {
    id: 'c6', name: 'Fix scoring bug', category: 'Product', tags: [],
    notes: '## Problem\nSomething scores wrong.',
  };
  const r = await enrichOneCard(card, {
    callLLM: async () => JSON.stringify({
      command: 'node --test tests/unit/scoring-bug-c6.test.mjs',
      acceptanceCriteria: '## Acceptance criteria\n`node --test tests/unit/scoring-bug-c6.test.mjs` passes',
    }),
    notionBrain: fakeNotionBrain(calls),
    logPath: SCRATCH_LOG_PATH,
  });
  assert.equal(r.action, 'llm-enriched');
  assert.equal(r.detail, 'node --test tests/unit/scoring-bug-c6.test.mjs');
  assert.deepEqual(r.newPaths, ['tests/unit/scoring-bug-c6.test.mjs']);
  assert.equal(calls.length, 1);
});

test('dry-run mode never calls notionBrain even on a successful enrichment', async () => {
  const calls = [];
  const card = { id: 'c5', name: 'Fix scoring bug', category: 'Product', tags: [], notes: '## Problem\nBug.' };
  const r = await enrichOneCard(card, {
    callLLM: async () => JSON.stringify({ command: 'npx next lint', acceptanceCriteria: '## Acceptance criteria\n`npx next lint` is clean' }),
    notionBrain: fakeNotionBrain(calls),
    dryRun: true,
  });
  assert.equal(r.action, 'llm-enriched');
  assert.equal(calls.length, 0);
});

test('spliceNotes: replaces an existing unarmed Acceptance criteria section in place', () => {
  const original = '## Problem\nBug.\n\n## Acceptance criteria\nThe owner agrees it looks better.\n\n## What was already tried\nNothing.';
  const drafted = '## Acceptance criteria\n`npx tsc --noEmit` is clean';
  const result = spliceNotes(original, drafted);
  assert.match(result, /npx tsc --noEmit/);
  assert.match(result, /## What was already tried/);
  assert.doesNotMatch(result, /owner agrees it looks better/);
});

test('spliceNotes: appends when no existing section is present', () => {
  const result = spliceNotes('## Problem\nBug.', '## Acceptance criteria\n`npx tsc --noEmit`');
  assert.match(result, /## Problem/);
  assert.match(result, /## Acceptance criteria/);
});

// ── Linear leg (task #1830) ─────────────────────────────────────────────────

test('selectRefusedLinearIdentifiers: keeps only issues whose description fails the verify gate', () => {
  const issues = [
    { identifier: 'BRO-1', title: 'Armed', description: '## Acceptance criteria\n`npx tsc --noEmit`' },
    { identifier: 'BRO-2', title: 'Owner judgment', description: 'VERIFY: owner-judgment' },
    { identifier: 'BRO-3', title: 'Prose only, no command', description: '## Problem\nSomething is broken.' },
    { identifier: 'BRO-4', title: 'No description at all', description: '' },
  ];
  assert.deepEqual(selectRefusedLinearIdentifiers(issues), ['BRO-3', 'BRO-4']);
});

test('selectRefusedLinearIdentifiers: tolerates null/missing description and empty input', () => {
  assert.deepEqual(selectRefusedLinearIdentifiers([]), []);
  assert.deepEqual(selectRefusedLinearIdentifiers(null), []);
  assert.deepEqual(
    selectRefusedLinearIdentifiers([{ identifier: 'BRO-9', title: 'No desc field' }]),
    ['BRO-9']
  );
});

// ship-check/Codex finding (task #1830): the underlying GraphQL query has no
// orderBy, so a naive slice(0, limit) downstream would process an arbitrary,
// run-to-run-inconsistent subset. Selection must be deterministic.
test('selectRefusedLinearIdentifiers: returns refused issues sorted ascending by BRO-N, regardless of input order', () => {
  const issues = [
    { identifier: 'BRO-450', title: 'x', description: '## Problem\nno command' },
    { identifier: 'BRO-9', title: 'x', description: '## Problem\nno command' },
    { identifier: 'BRO-100', title: 'x', description: '## Problem\nno command' },
  ];
  assert.deepEqual(selectRefusedLinearIdentifiers(issues), ['BRO-9', 'BRO-100', 'BRO-450']);
});

test('linearIssueNumber: parses the trailing number, non-numeric identifiers sort last', () => {
  assert.equal(linearIssueNumber('BRO-42'), 42);
  assert.equal(linearIssueNumber('BRO-007'), 7);
  assert.equal(linearIssueNumber('not-an-identifier'), Infinity);
  assert.equal(linearIssueNumber(''), Infinity);
  assert.equal(linearIssueNumber(null), Infinity);
});

// ship-check/Codex finding (task #1830): a stale "open" snapshot must never
// let a write resurrect an issue that reached Done/Canceled since the sweep.
test('isLinearIssueTerminal: true for completed/canceled/duplicate state types, false otherwise', () => {
  assert.equal(isLinearIssueTerminal({ state: { type: 'completed', name: 'Done' } }), true);
  assert.equal(isLinearIssueTerminal({ state: { type: 'canceled', name: 'Canceled' } }), true);
  assert.equal(isLinearIssueTerminal({ state: { type: 'duplicate', name: 'Duplicate' } }), true);
  assert.equal(isLinearIssueTerminal({ state: { type: 'started', name: 'In Progress' } }), false);
  assert.equal(isLinearIssueTerminal({ state: { type: 'unstarted', name: 'Todo' } }), false);
  assert.equal(isLinearIssueTerminal({}), false);
  assert.equal(isLinearIssueTerminal(null), false);
});

test('normalizeLinearIssue: maps a full linear.getIssue() result to the enrichOneCard card shape', () => {
  const issue = {
    id: 'uuid-123',
    identifier: 'BRO-450',
    title: 'Cron stale 3+ consecutive days: Refresh Show Score',
    description: '## Problem\nCron has not run.',
    labels: { nodes: [{ id: 'l1', name: 'cron' }, { id: 'l2', name: 'auto-enriched' }] },
  };
  const card = normalizeLinearIssue(issue);
  assert.equal(card.id, 'uuid-123');
  assert.equal(card.name, 'Cron stale 3+ consecutive days: Refresh Show Score');
  assert.equal(card.notes, '## Problem\nCron has not run.');
  assert.deepEqual(card.tags, ['cron', 'auto-enriched']);
  // No [notion:...] meta line in this description — category is genuinely
  // unknown (native Linear card, or pre-fmt:2 import), not a hardcode.
  assert.equal(card.category, null);
  assert.equal(card.identifier, 'BRO-450');
});

test('normalizeLinearIssue: tolerates a missing description, no labels, and no url', () => {
  const card = normalizeLinearIssue({ id: 'uuid-1', identifier: 'BRO-1', title: 'x' });
  assert.equal(card.notes, '');
  assert.deepEqual(card.tags, []);
  assert.equal(card.url, null);
});

test('normalizeLinearIssue: carries the issue url through for the audit log', () => {
  const card = normalizeLinearIssue({ id: 'uuid-1', identifier: 'BRO-1', title: 'x', url: 'https://linear.app/broadway-scorecard/issue/BRO-1' });
  assert.equal(card.url, 'https://linear.app/broadway-scorecard/issue/BRO-1');
});

// BRO-2245: normalizeLinearIssue hardcoded category:null, so the
// owner-judgment branch could never fire on the Linear leg. notion-tasks-sync
// writes "[notion:<id>] <priority> · <status> · <category>" as the imported
// description's meta line — linear-import.js carries it through verbatim, so
// it is recoverable on every already-imported card.
test('normalizeLinearIssue: recovers category from the imported [notion:...] meta line', () => {
  const issue = {
    id: 'uuid-mkt-1',
    identifier: 'BRO-9001',
    title: 'Reddit post: Les Mis Arena Concert (r/Broadway)',
    description: '[notion:3b2637c5-abcd-1234-9999-000000000000] P1 Next · Not started · Marketing\nDraft a Reddit post.',
  };
  const card = normalizeLinearIssue(issue);
  assert.equal(card.category, 'Marketing');
});

test('categoryOfLinearIssue: parses the trailing segment of the [notion:...] meta line', () => {
  assert.equal(
    categoryOfLinearIssue('[notion:abc-123] P0 Now · In progress · Marketing'),
    'Marketing'
  );
  assert.equal(
    categoryOfLinearIssue('[notion:abc-123] P2 Later · Backlog · Product'),
    'Product'
  );
});

test('categoryOfLinearIssue: returns null when there is no [notion:...] meta line at all', () => {
  assert.equal(categoryOfLinearIssue('## Problem\nNative Linear card, no Notion import.'), null);
  assert.equal(categoryOfLinearIssue(''), null);
  assert.equal(categoryOfLinearIssue(undefined), null);
});

// linear-import-rules.js's extractNotionId scans the whole description, not
// just line 1, because zombie-sweep re-opens and other prefixes push the
// marker down — categoryOfLinearIssue must do the same or a re-opened
// Marketing card silently loses its category again.
test('categoryOfLinearIssue: finds the meta line even when it is not line 1', () => {
  const description = [
    '[zombie-sweep re-opened 2026-08-10]',
    'Follow-up needed.',
    '[notion:abc-123] P1 Now · Not started · Marketing',
    'Original body text.',
  ].join('\n');
  assert.equal(categoryOfLinearIssue(description), 'Marketing');
});

// End-to-end reproduction of the live incident: a Marketing card imported
// from Notion into Linear, run through normalizeLinearIssue then
// enrichOneCard, must land on owner-judgment and must NEVER be armed with a
// runnable acceptance command.
test('BRO-2245: a Linear issue whose imported description marks it Marketing is owner-judgment, never armed', async () => {
  let llmCalled = false;
  const writeCalls = [];
  const issue = {
    id: 'uuid-mkt-2',
    identifier: 'BRO-9002',
    title: 'Forbes feature pitch: Marc Hershberg (Commercial Scorecard)',
    description: '[notion:3b2637c5-abcd-1234-9999-000000000001] P1 Next · Not started · Marketing\nDraft a pitch email.',
  };
  const card = normalizeLinearIssue(issue);
  assert.equal(card.category, 'Marketing');

  const r = await enrichOneCard(card, {
    callLLM: async () => { llmCalled = true; return '{}'; },
    writeCard: async (c, newNotes) => { writeCalls.push({ id: c.id, newNotes }); },
    logPath: SCRATCH_LOG_PATH,
  });

  assert.equal(r.action, 'owner-judgment');
  assert.equal(llmCalled, false, 'the LLM must never be called for an owner-judgment card');
  assert.equal(writeCalls.length, 1);
  assert.match(writeCalls[0].newNotes, /VERIFY: owner-judgment/);
  // The whole point: no runnable safe-form command anywhere in the write.
  assert.doesNotMatch(writeCalls[0].newNotes, /## Acceptance criteria/);
});

test('makeLinearWriteCard: updates the description then ensures the auto-enriched label via findOrCreateLabel + addLabelToIssue', async () => {
  const calls = [];
  const fakeLinearClient = {
    updateIssue: async (id, input) => { calls.push(['updateIssue', id, input]); },
    findOrCreateLabel: async (teamId, name) => { calls.push(['findOrCreateLabel', teamId, name]); return { id: 'label-1', name }; },
    addLabelToIssue: async (issueId, labelId) => { calls.push(['addLabelToIssue', issueId, labelId]); },
  };
  const writeCard = makeLinearWriteCard(fakeLinearClient, 'team-1');
  await writeCard({ id: 'issue-1' }, '## Acceptance criteria\n`npx tsc --noEmit` is clean');
  assert.deepEqual(calls, [
    ['updateIssue', 'issue-1', { description: '## Acceptance criteria\n`npx tsc --noEmit` is clean' }],
    ['findOrCreateLabel', 'team-1', 'auto-enriched'],
    ['addLabelToIssue', 'issue-1', 'label-1'],
  ]);
});

test('enrichOneCard: honors opts.writeCard (Linear path) and never calls opts.notionBrain', async () => {
  const notionCalls = [];
  const writeCalls = [];
  const card = {
    id: 'issue-uuid-1', name: 'Fetch Guardian Reviews via API', category: null, tags: [],
    identifier: 'BRO-440', notes: '## Problem\nWorkflow keeps failing.',
  };
  const r = await enrichOneCard(card, {
    callLLM: async () => JSON.stringify({ command: 'npx tsc --noEmit', acceptanceCriteria: '## Acceptance criteria\n`npx tsc --noEmit` is clean' }),
    notionBrain: fakeNotionBrain(notionCalls),
    writeCard: async (c, newNotes) => { writeCalls.push({ id: c.id, newNotes }); },
    logPath: SCRATCH_LOG_PATH,
  });
  assert.equal(r.action, 'llm-enriched');
  assert.equal(notionCalls.length, 0);
  assert.equal(writeCalls.length, 1);
  assert.equal(writeCalls[0].id, 'issue-uuid-1');
  assert.match(writeCalls[0].newNotes, /npx tsc --noEmit/);
});

// ship-check finding (QA subagent + Codex, task #1830): a Linear write is 3
// sequential network calls, any of which can throw. Uncaught, that used to
// propagate out of enrichOneCard and crash the whole batch loop — must
// degrade to a per-card 'failed' result instead, same as every other I/O
// failure path in this file.
test('enrichOneCard: a throwing opts.writeCard degrades to a failed result, does not propagate', async () => {
  const card = {
    id: 'issue-uuid-3', name: 'Some Linear issue', category: null, tags: [],
    notes: '## Problem\nBug.',
  };
  const r = await enrichOneCard(card, {
    callLLM: async () => JSON.stringify({ command: 'npx tsc --noEmit', acceptanceCriteria: '## Acceptance criteria\n`npx tsc --noEmit` is clean' }),
    writeCard: async () => { throw new Error('Linear API HTTP 502'); },
    logPath: SCRATCH_LOG_PATH,
  });
  assert.equal(r.action, 'failed');
  assert.match(r.detail, /write failed: Linear API HTTP 502/);
});

test('enrichOneCard: a throwing opts.writeCard on the owner-judgment path also degrades to failed', async () => {
  const card = { id: 'issue-uuid-4', name: 'Email volunteers', category: '', tags: [], notes: 'Reach out.' };
  const r = await enrichOneCard(card, {
    callLLM: async () => '{}',
    writeCard: async () => { throw new Error('Linear API HTTP 500'); },
    logPath: SCRATCH_LOG_PATH,
  });
  assert.equal(r.action, 'failed');
  assert.match(r.detail, /write failed: Linear API HTTP 500/);
});

test('enrichOneCard: dry-run mode never calls opts.writeCard either', async () => {
  const writeCalls = [];
  const card = { id: 'issue-uuid-2', name: 'Some Linear issue', category: null, tags: [], notes: '## Problem\nBug.' };
  const r = await enrichOneCard(card, {
    callLLM: async () => JSON.stringify({ command: 'npx next lint', acceptanceCriteria: '## Acceptance criteria\n`npx next lint` is clean' }),
    writeCard: async (c, newNotes) => { writeCalls.push({ id: c.id, newNotes }); },
    dryRun: true,
  });
  assert.equal(r.action, 'llm-enriched');
  assert.equal(writeCalls.length, 0);
});
