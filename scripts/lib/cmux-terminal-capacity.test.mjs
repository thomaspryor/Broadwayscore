import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const cap = require('./cmux-terminal-capacity.js');
const {
  parseDebugTerminals, countLiveRuntimes, workspaceRuntimeState, hasRuntimeSignal,
  decideCapacity, learnCeiling, probeTerminalCapacity, recordLaunchOutcome,
  readCeiling, readCeilingRecord, writeCeiling, MIN_PLAUSIBLE_CEILING, CEILING_TTL_MS, CEILING_PATH,
  CEILING_CONFIRMATIONS_REQUIRED,
} = cap;

// Verbatim `cmux debug-terminals` output captured on the machine at 14:20Z on
// 2026-08-26, WHILE the failure was live — one healthy surface and one that
// cmux had created but never attached a terminal to. The doomed one is the
// second block: it is visible=1 inWindow=1 hidden=0 firstResponder=1, i.e.
// on screen and focused, which is why "the surface wasn't rendered" was the
// wrong diagnosis for four previous cards.
const REAL_DUMP = `[0] surface:44 "✳ P1 backlog dispatcher crown cycle v18" mapped=1 tree=1 window=window:1 workspace=workspace:43 pane=pane:44 bonsplitTab=8AC310E0-A5B1-4F74-9375-E8289BE27699 ctx=split
    runtime=1 focused=1 selected=1 pinned=0 terminal=0x0000000bedc49200 hosted=0x0000000be95bf800 ghostty=0x0000000beb6ac000 portal=live#1 teardown=nil
    tty=nil cwd=/Users/tompryor/Broadwayscore branch=main* ports=[] visible=0 inWindow=0 superview=0 hidden=1 ancestorHidden=1 firstResponder=0 windowNum=963 windowKey=0 frame={0.0,0.0 0.0x0.0}
    created=3767.273s runtimeCreated=1736.194s lastWorkspace=workspace:43 initialCommand=nil portalHost=ObjectIdentifier(0x0000000bed81ed00)/win=0/area=1021570.0
    window=title=🤖⚡ Infra·Fix confirmed REVIEW_TEXTS_TOKEN gap class=CmuxMainWindow controller=MainWindowController delegate=MainWindowController chain=GhosttySurfaceScrollView
[1] surface:68 "Terminal" mapped=1 tree=1 window=window:2 workspace=workspace:66 pane=pane:66 bonsplitTab=8E889249-E92F-4C9B-A402-EBB04F1E9B6D ctx=tab
    runtime=0 focused=1 selected=1 pinned=0 terminal=0x0000000bed6dae00 hosted=0x0000000be9980000 ghostty=nil portal=live#1 teardown=nil
    tty=nil cwd=/Users/tompryor/Broadwayscore branch=main* ports=[] visible=1 inWindow=1 superview=1 hidden=0 ancestorHidden=0 firstResponder=1 windowNum=1225 windowKey=0 frame={200.0,0.0 1400.0x814.0}
    created=354.044s runtimeCreated=nil lastWorkspace=workspace:66 initialCommand=nil portalHost=ObjectIdentifier(0x0000000bedd3cc00)/win=1/area=1139600.0
    window=title=ZZ-win2-done-1787753562 class=CmuxMainWindow controller=MainWindowController delegate=MainWindowController chain=GhosttySurfaceScrollView
[2] surface:56 mapped=0 tree=0 window=nil workspace=nil pane=nil bonsplitTab=nil ctx=tab
    runtime=0 focused=0 selected=0 pinned=0 terminal=0x0000000bee111100 hosted=nil ghostty=nil portal=nil teardown=nil
`;

function tmpCeilingPath(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cap-test-')), `${name}.json`);
}

// ── parser ────────────────────────────────────────────────────────────────

test('parses the real debug-terminals dump, including the unmapped orphan block', () => {
  const s = parseDebugTerminals(REAL_DUMP);
  assert.equal(s.length, 3);
  assert.deepEqual(s[0], {
    surfaceRef: 'surface:44', workspaceRef: 'workspace:43', mapped: true,
    runtime: true, createdSec: 3767.273, runtimeCreatedSec: 1736.194,
  });
  assert.equal(s[1].surfaceRef, 'surface:68');
  assert.equal(s[1].runtime, false);
  assert.equal(s[1].runtimeCreatedSec, null, 'runtimeCreated=nil must parse as null, not NaN');
  assert.equal(s[2].workspaceRef, null, 'workspace=nil is null, not the string "nil"');
});

test('countLiveRuntimes counts only attached terminals', () => {
  assert.equal(countLiveRuntimes(parseDebugTerminals(REAL_DUMP)), 1);
  assert.equal(countLiveRuntimes([]), 0);
  assert.equal(countLiveRuntimes(null), 0);
  // runtime:null (field absent) is NOT counted as live — unknown never reads as healthy.
  assert.equal(countLiveRuntimes([{ runtime: null }, { runtime: undefined }]), 0);
});

test('parser never throws on junk, truncated, or empty input', () => {
  for (const junk of ['', null, undefined, 'Error: not_found', '[0] garbage\n[1]\n', '\u0000\uFFFD']) {
    assert.doesNotThrow(() => parseDebugTerminals(junk));
  }
  assert.deepEqual(parseDebugTerminals('Error: unknown command'), []);
});

test('workspaceRuntimeState distinguishes live / dead / unknown', () => {
  const s = parseDebugTerminals(REAL_DUMP);
  assert.equal(workspaceRuntimeState(s, 'workspace:43'), true);
  assert.equal(workspaceRuntimeState(s, 'workspace:66'), false);
  assert.equal(workspaceRuntimeState(s, 'workspace:999'), null, 'an absent ref is unknown, never dead');
  // A workspace with a split where ONE surface has a terminal is live.
  assert.equal(workspaceRuntimeState(
    [{ workspaceRef: 'workspace:5', runtime: false }, { workspaceRef: 'workspace:5', runtime: true }],
    'workspace:5'), true);
});

// ── capacity decision ─────────────────────────────────────────────────────

test('unknown live count or unknown ceiling never blocks a launch', () => {
  assert.equal(decideCapacity({ liveRuntimes: null, ceiling: 29 }).hasCapacity, true);
  assert.equal(decideCapacity({ liveRuntimes: null, ceiling: 29 }).known, false);
  assert.equal(decideCapacity({ liveRuntimes: 40, ceiling: null }).hasCapacity, true);
  assert.equal(decideCapacity({}).hasCapacity, true);
});

test('blocks at or above the observed ceiling, allows below it', () => {
  const C = CEILING_CONFIRMATIONS_REQUIRED;
  assert.equal(decideCapacity({ liveRuntimes: 28, ceiling: 29, confirmations: C }).hasCapacity, true);
  assert.equal(decideCapacity({ liveRuntimes: 29, ceiling: 29, confirmations: C }).hasCapacity, false);
  assert.equal(decideCapacity({ liveRuntimes: 31, ceiling: 29, confirmations: C }).hasCapacity, false);
  const blocked = decideCapacity({ liveRuntimes: 29, ceiling: 29, confirmations: C });
  assert.match(blocked.reason, /ceiling/i);
  assert.match(blocked.reason, /bsc-prune|restart cmux/, 'the refusal must say what actually frees a runtime');
});

test('an implausibly low stored ceiling is ignored, not obeyed', () => {
  // Otherwise one unrelated failure at 3 live terminals latches the gate shut
  // and every future dispatch is refused forever.
  const d = decideCapacity({ liveRuntimes: 5, ceiling: MIN_PLAUSIBLE_CEILING - 1, confirmations: CEILING_CONFIRMATIONS_REQUIRED });
  assert.equal(d.hasCapacity, true);
  assert.equal(d.ceiling, null);
});

// ── ceiling learning ──────────────────────────────────────────────────────

test('a runtime-missing launch records the ceiling at the count it failed on, UNCONFIRMED', () => {
  const r = learnCeiling({ ceiling: null, liveRuntimesBefore: 29, outcome: 'runtime-missing' });
  assert.deepEqual([r.ceiling, r.changed, r.confirmations], [29, true, 1]);
  // One observation must not be enough to refuse anything — see the latch test below.
  assert.equal(decideCapacity({ liveRuntimes: 29, ceiling: r.ceiling, confirmations: r.confirmations }).hasCapacity, true);
});

test('ONE runtime-missing verdict cannot latch the gate shut (ship-check blocker)', () => {
  // The same verdict is produced by failures that have nothing to do with
  // capacity (the #1829 class). Before the confirmation counter, a single
  // one at 15 live tabs latched ceiling=15 for a day and reported a
  // confident "cap observed at 15" on a near-empty cmux.
  const p = tmpCeilingPath('latch');
  const first = recordLaunchOutcome({ liveRuntimesBefore: 15, outcome: 'runtime-missing', ceilingPath: p });
  assert.equal(first.confirmations, 1);
  assert.equal(probeTerminalCapacity({ debugTerminals: () => REAL_DUMP, ceilingPath: p }).hasCapacity, true,
    'an unconfirmed candidate must never refuse a launch');

  const second = recordLaunchOutcome({ liveRuntimesBefore: 15, outcome: 'runtime-missing', ceilingPath: p });
  assert.equal(second.confirmations, CEILING_CONFIRMATIONS_REQUIRED);
  assert.equal(decideCapacity({ liveRuntimes: 15, ceiling: 15, confirmations: second.confirmations }).hasCapacity, false,
    'two observations in the same regime IS the pattern the gate is allowed to act on');
});

test('a lower observation CANNOT destroy a confirmed ceiling — it becomes a candidate', () => {
  // This test previously asserted the OPPOSITE (one low observation replaced
  // the confirmed ceiling outright, "the evidence supports 12, not the old
  // 29"). That was the bug, not the contract: /code-review finding 4, the one
  // finding in this lineage that could wrongly REFUSE real dispatches. A
  // confirmed 29 plus a single #1829-class failure at 12 became an
  // unconfirmed 12, and a second such failure confirmed 12 — refusing every
  // dispatch above 12 live tabs for the full 24h TTL while reporting a
  // confident "cap observed at 12" on a half-empty cmux. Rewritten
  // deliberately rather than deleted, so the old behavior stays refuted here.
  const p = tmpCeilingPath('restart');
  recordLaunchOutcome({ liveRuntimesBefore: 29, outcome: 'runtime-missing', ceilingPath: p });
  recordLaunchOutcome({ liveRuntimesBefore: 29, outcome: 'runtime-missing', ceilingPath: p });
  assert.equal(readCeilingRecord(p).confirmations, CEILING_CONFIRMATIONS_REQUIRED);

  const lower = recordLaunchOutcome({ liveRuntimesBefore: 12, outcome: 'runtime-missing', ceilingPath: p });
  assert.deepEqual([lower.ceiling, lower.confirmations], [29, CEILING_CONFIRMATIONS_REQUIRED],
    'the confirmed ceiling stands — one anecdote below it is not evidence the cap moved');
  assert.deepEqual([lower.candidate, lower.candidateConfirmations], [12, 1]);
  assert.equal(probeTerminalCapacity({ debugTerminals: () => REAL_DUMP, ceilingPath: p }).ceiling, 29,
    'the gate still enforces 29, not 12 — this is the refusal the finding was about');

  // …but a candidate that earns the SAME corroboration the ceiling had does
  // supersede it, so a genuinely lowered cap is still learnable.
  const second = recordLaunchOutcome({ liveRuntimesBefore: 12, outcome: 'runtime-missing', ceilingPath: p });
  assert.deepEqual([second.ceiling, second.confirmations], [12, CEILING_CONFIRMATIONS_REQUIRED]);
  assert.deepEqual([second.candidate, second.candidateConfirmations], [null, 0], 'promotion clears the candidate');
});

test('a genuinely lowered cap is still learnable — the first repeat at-or-above the running low confirms it', () => {
  // A real cap at 20 produces failures at EVERY count at or above 20, not a
  // strictly descending staircase, so the corroborating observation arrives
  // quickly. (A strictly descending run is evidence these are NOT capacity
  // failures, and leaving the gate armed at the older corroborated number is
  // the safe direction — see the candidate-corroboration test above.)
  const a = learnCeiling({ ceiling: 29, confirmations: 2, liveRuntimesBefore: 22, outcome: 'runtime-missing' });
  assert.deepEqual([a.candidate, a.candidateConfirmations], [22, 1]);
  const b = learnCeiling({ ...a, liveRuntimesBefore: 25, outcome: 'runtime-missing' });
  assert.deepEqual([b.ceiling, b.confirmations], [22, CEILING_CONFIRMATIONS_REQUIRED],
    'a second failure at or above the candidate confirms the cap really did drop');
  assert.equal(decideCapacity({ liveRuntimes: 22, ceiling: b.ceiling, confirmations: b.confirmations }).hasCapacity, false);
});

test('a success at or above the candidate withdraws it, even far below the confirmed ceiling', () => {
  // Without this arm the late-adopt/reclaim disproof in cmux-launch.js is
  // inert: those cases are exactly `confirmed 29 > before 12`, which the
  // ceiling-raising branch skips. A false low observation would survive while
  // its own disproof never did.
  const r = learnCeiling({ ceiling: 29, confirmations: 2, candidate: 12, candidateConfirmations: 1, liveRuntimesBefore: 12, outcome: 'runtime-created' });
  assert.deepEqual([r.ceiling, r.confirmations, r.candidate, r.candidateConfirmations], [29, 2, null, 0]);
  assert.equal(r.changed, true, 'the withdrawal has to PERSIST, or the candidate just re-accumulates');
  assert.equal(r.touched, 'candidate', 'and it must not refresh the confirmed ceiling toward its TTL');
  // A success below the candidate proves nothing about either number.
  assert.equal(learnCeiling({ ceiling: 29, confirmations: 2, candidate: 12, candidateConfirmations: 1, liveRuntimesBefore: 5, outcome: 'runtime-created' }).changed, false);
});

test('a candidate observation cannot refresh the confirmed ceiling toward its TTL', () => {
  // The TTL is the ONLY recovery when cmux ships a build with a HIGHER cap:
  // the gate itself prevents the success that would raise the number. If a
  // stream of candidate writes kept re-stamping the confirmed half, that
  // escape hatch would never fire.
  const p = tmpCeilingPath('ttl-split');
  const t0 = Date.parse('2026-08-26T00:00:00.000Z');
  recordLaunchOutcome({ liveRuntimesBefore: 29, outcome: 'runtime-missing', ceilingPath: p, nowMs: t0 });
  recordLaunchOutcome({ liveRuntimesBefore: 29, outcome: 'runtime-missing', ceilingPath: p, nowMs: t0 });
  // 23h later: one low observation lands as a candidate.
  const t1 = t0 + 23 * 60 * 60 * 1000;
  recordLaunchOutcome({ liveRuntimesBefore: 12, outcome: 'runtime-missing', ceilingPath: p, nowMs: t1 });
  // 25h after the ORIGINAL confirmation the ceiling must be gone, however
  // recently the candidate half was written.
  const t2 = t0 + 25 * 60 * 60 * 1000;
  const rec = readCeilingRecord(p, { nowMs: t2 });
  assert.equal(rec.ceiling, null, 'the confirmed half ages from ITS OWN stamp');
  assert.equal(rec.candidate, 12, 'while the candidate half is still inside its own TTL');
});

test('the ceiling only ratchets DOWN on a NEW number; a repeat at/above it confirms instead', () => {
  assert.deepEqual(learnCeiling({ ceiling: 29, confirmations: 1, liveRuntimesBefore: 25, outcome: 'runtime-missing' }).ceiling, 25);
  const again = learnCeiling({ ceiling: 25, confirmations: 1, liveRuntimesBefore: 29, outcome: 'runtime-missing' });
  assert.equal(again.ceiling, 25, 'a failure ABOVE the known ceiling does not move the number');
  assert.equal(again.confirmations, 2, 'but it IS corroboration that the cap is real');
});

test('a success at or above the ceiling DISPROVES it — the escape from a stale-low ceiling', () => {
  // This previously RAISED the ceiling to before+1. That fabricated a number
  // no observation supported, and the number then collected corroboration from
  // failures far above it — demonstrated end to end below. Clearing to unknown
  // keeps the escape (gate goes quiet, next failures re-learn) without
  // asserting anything nobody saw.
  const r = learnCeiling({ ceiling: 29, confirmations: 2, liveRuntimesBefore: 29, outcome: 'runtime-created' });
  assert.deepEqual([r.ceiling, r.confirmations, r.changed], [null, 0, true]);
  assert.equal(learnCeiling({ ceiling: 29, confirmations: 2, liveRuntimesBefore: 34, outcome: 'runtime-created' }).ceiling, null);
  // A success comfortably below the ceiling proves nothing about the cap.
  assert.equal(learnCeiling({ ceiling: 29, confirmations: 2, liveRuntimesBefore: 10, outcome: 'runtime-created' }).changed, false);
  assert.equal(learnCeiling({ ceiling: null, liveRuntimesBefore: 10, outcome: 'runtime-created' }).changed, false);
});

test('a disproved ceiling cannot be re-confirmed by failures far ABOVE it', () => {
  // The harm the clear-instead-of-raise change exists for. With the old raise,
  // this sequence ended at a CONFIRMED ceiling of 13 and refused every
  // dispatch above 13 live tabs — having observed a SUCCESS at 12 and failures
  // only at 30. The late-adopt/reclaim compensating record makes the
  // missing-then-created-at-the-same-count pair a routine event, so this is
  // not a corner case.
  const p = tmpCeilingPath('no-fabrication');
  recordLaunchOutcome({ liveRuntimesBefore: 12, outcome: 'runtime-missing', ceilingPath: p });
  recordLaunchOutcome({ liveRuntimesBefore: 12, outcome: 'runtime-created', ceilingPath: p });
  assert.equal(readCeilingRecord(p).ceiling, null, 'the success at 12 disproves the 12 observation outright');
  recordLaunchOutcome({ liveRuntimesBefore: 30, outcome: 'runtime-missing', ceilingPath: p });
  recordLaunchOutcome({ liveRuntimesBefore: 30, outcome: 'runtime-missing', ceilingPath: p });
  const rec = readCeilingRecord(p);
  assert.equal(rec.ceiling, 30, 'the relearned ceiling is where cmux ACTUALLY failed, not a fabricated 13');
  assert.equal(decideCapacity({ liveRuntimes: 20, ceiling: rec.ceiling, confirmations: rec.confirmations }).hasCapacity, true,
    '20 live tabs must still dispatch — nothing ever failed there');
});

test('a candidate is only corroborated by an observation AT OR ABOVE it, never by a lower one', () => {
  // Adversarial review catch, found independently by two reviewers. Pairing a
  // min() value with a monotonic counter meant that from a confirmed 29, a miss
  // at 28 plus an unrelated miss at 12 promoted a CONFIRMED ceiling of 12 that
  // no single value had ever been seen at twice — reintroducing exactly the
  // harm the confirmed/candidate split exists to prevent.
  const first = learnCeiling({ ceiling: 29, confirmations: 2, liveRuntimesBefore: 28, outcome: 'runtime-missing' });
  assert.deepEqual([first.candidate, first.candidateConfirmations], [28, 1]);
  const lower = learnCeiling({ ...first, liveRuntimesBefore: 12, outcome: 'runtime-missing' });
  assert.deepEqual([lower.ceiling, lower.confirmations], [29, 2], 'the confirmed ceiling must still stand');
  assert.deepEqual([lower.candidate, lower.candidateConfirmations], [12, 1],
    'a LOWER observation replaces the candidate and restarts its count — it does not corroborate it');
  // …and an observation at or above the candidate does corroborate it.
  const corroborated = learnCeiling({ ...lower, liveRuntimesBefore: 15, outcome: 'runtime-missing' });
  assert.deepEqual([corroborated.ceiling, corroborated.confirmations], [12, CEILING_CONFIRMATIONS_REQUIRED]);
});

test('a candidate that outlives its expired confirmed ceiling is adopted, not discarded', () => {
  // The two halves expire independently. When the confirmed half ages out
  // first, the candidate is the best evidence there is — the first cut fell
  // into the "no ceiling yet" arm and threw it away, so a candidate could never
  // converge across the expiry boundary while doomed workspaces kept being made.
  const r = learnCeiling({ ceiling: null, confirmations: 0, candidate: 20, candidateConfirmations: 1, liveRuntimesBefore: 24, outcome: 'runtime-missing' });
  assert.deepEqual([r.ceiling, r.confirmations], [20, CEILING_CONFIRMATIONS_REQUIRED],
    'the candidate becomes the ceiling and its corroboration carries over');
  assert.deepEqual([r.candidate, r.candidateConfirmations], [null, 0]);
});

test('a failure below the plausibility floor is not recorded as a ceiling', () => {
  const r = learnCeiling({ ceiling: null, liveRuntimesBefore: 3, outcome: 'runtime-missing' });
  assert.equal(r.changed, false);
  assert.equal(r.ceiling, null);
  assert.match(r.reason, /plausibility floor/);
});

test('learnCeiling is inert on a missing count or an unknown outcome', () => {
  assert.equal(learnCeiling({ ceiling: 29, confirmations: 2, liveRuntimesBefore: null, outcome: 'runtime-missing' }).changed, false);
  assert.equal(learnCeiling({ ceiling: 29, confirmations: 2, liveRuntimesBefore: 29, outcome: 'nonsense' }).changed, false);
});

// ── persistence + probe wiring ────────────────────────────────────────────

test('ceiling round-trips through the file, and unreadable/corrupt files read as null', () => {
  const p = tmpCeilingPath('roundtrip');
  assert.equal(readCeiling(p), null, 'missing file is null, never 0');
  assert.equal(writeCeiling(29, { ceilingPath: p, note: 'test' }), true);
  assert.equal(readCeiling(p), 29);
  fs.writeFileSync(p, '{not json');
  assert.equal(readCeiling(p), null);
  fs.writeFileSync(p, JSON.stringify({ ceiling: 'twenty-nine', observedAt: new Date().toISOString() }));
  assert.equal(readCeiling(p), null, 'a non-integer ceiling is not a ceiling');
});

test('the ceiling EXPIRES rather than refusing dispatches forever', () => {
  // Without this, a ceiling learned from cmux 0.64.6 would keep refusing
  // launches after an upgrade raised the cap — and could never be disproved,
  // because learnCeiling only raises it on a success at or above the ceiling
  // and the gate is what prevents that success from being attempted.
  const p = tmpCeilingPath('ttl');
  const t0 = Date.parse('2026-08-26T12:00:00.000Z');
  writeCeiling(29, { ceilingPath: p, confirmations: CEILING_CONFIRMATIONS_REQUIRED, nowIso: new Date(t0).toISOString() });
  assert.equal(readCeiling(p, { nowMs: t0 + CEILING_TTL_MS - 1000 }), 29, 'still fresh');
  assert.equal(readCeiling(p, { nowMs: t0 + CEILING_TTL_MS + 1000 }), null, 'expired reads as unknown');
  assert.equal(decideCapacity({ liveRuntimes: 40, ceiling: readCeiling(p, { nowMs: t0 + CEILING_TTL_MS + 1000 }), confirmations: CEILING_CONFIRMATIONS_REQUIRED }).hasCapacity,
    true, 'an expired ceiling must not block');
  // A ceiling with no readable observedAt is expired, never eternally fresh.
  fs.writeFileSync(p, JSON.stringify({ ceiling: 29 }));
  assert.equal(readCeiling(p), null);
});

test('ceiling state lives in tmpdir, not in the git-tracked data/audit tree', () => {
  // data/audit/ is tracked apart from one explicit .gitignore line for
  // dispatch-ledger.jsonl, so a ceiling file there would be committed and
  // shared with CI and every other machine — and this number describes ONE
  // cmux install on ONE host.
  assert.equal(CEILING_PATH.startsWith(os.tmpdir()), true, `${CEILING_PATH} must be under ${os.tmpdir()}`);
  assert.equal(/data[/\\]audit/.test(CEILING_PATH), false);
});

// The record carries freshness stamps that are wall-clock values, so compare
// the DECISION fields rather than deepEqual-ing the whole object.
const decisionFields = (rec) => ({
  ceiling: rec.ceiling, confirmations: rec.confirmations,
  candidate: rec.candidate, candidateConfirmations: rec.candidateConfirmations,
});

test('recordLaunchOutcome round-trips the ceiling AND its confirmation count', () => {
  const p = tmpCeilingPath('record');
  recordLaunchOutcome({ liveRuntimesBefore: 29, outcome: 'runtime-missing', ceilingPath: p });
  assert.deepEqual(decisionFields(readCeilingRecord(p)), { ceiling: 29, confirmations: 1, candidate: null, candidateConfirmations: 0 });
  recordLaunchOutcome({ liveRuntimesBefore: 40, outcome: 'runtime-missing', ceilingPath: p });
  assert.deepEqual(decisionFields(readCeilingRecord(p)), { ceiling: 29, confirmations: 2, candidate: null, candidateConfirmations: 0 },
    'a failure above the ceiling does not raise the number, but it does corroborate it');
  recordLaunchOutcome({ liveRuntimesBefore: 29, outcome: 'runtime-created', ceilingPath: p });
  assert.deepEqual(decisionFields(readCeilingRecord(p)), { ceiling: null, confirmations: 0, candidate: null, candidateConfirmations: 0 },
    'a success at the ceiling disproves it and clears it — it does not invent a ceiling of 30');
});

test('probe fails OPEN when cmux is unavailable or the format changes', () => {
  const p = tmpCeilingPath('probe-open');
  writeCeiling(29, { ceilingPath: p, confirmations: CEILING_CONFIRMATIONS_REQUIRED });
  const gone = probeTerminalCapacity({ debugTerminals: () => null, ceilingPath: p });
  assert.equal(gone.hasCapacity, true);
  assert.equal(gone.known, false);
  assert.equal(gone.liveRuntimes, null);

  const renamed = probeTerminalCapacity({ debugTerminals: () => 'surfaces: 0\nno blocks here', ceilingPath: p });
  assert.equal(renamed.hasCapacity, true, 'an unparseable dump must never be read as "0 live, plenty of room"');
  assert.equal(renamed.liveRuntimes, null);
});

test('probe blocks on a real at-capacity dump and hands back the snapshot', () => {
  const p = tmpCeilingPath('probe-block');
  writeCeiling(1, { ceilingPath: p, confirmations: CEILING_CONFIRMATIONS_REQUIRED }); // below the plausibility floor
  assert.equal(probeTerminalCapacity({ debugTerminals: () => REAL_DUMP, ceilingPath: p }).hasCapacity, true);

  writeCeiling(MIN_PLAUSIBLE_CEILING, { ceilingPath: p, confirmations: CEILING_CONFIRMATIONS_REQUIRED });
  const dump = Array.from({ length: MIN_PLAUSIBLE_CEILING }, (_, i) =>
    `[${i}] surface:${i} "t" mapped=1 workspace=workspace:${i} ctx=tab\n    runtime=1 ghostty=0x1\n    created=1.0s runtimeCreated=0.9s`).join('\n');
  const r = probeTerminalCapacity({ debugTerminals: () => dump, ceilingPath: p });
  assert.equal(r.hasCapacity, false);
  assert.equal(r.liveRuntimes, MIN_PLAUSIBLE_CEILING);
  assert.equal(r.surfaces.length, MIN_PLAUSIBLE_CEILING, 'the snapshot rides along so callers need not probe twice');
});

// ── Adversarial-review hardening (2026-08-26) ─────────────────────────────

test('a FUTURE observedAt reads as unknown, not as permanently fresh', () => {
  // `age > ttl` alone lets a stamp written under a clock that later rolled
  // back — or a file left by another machine — refuse every dispatch until
  // that future date plus a day, looking like a legitimate capacity refusal
  // the whole time.
  const p = tmpCeilingPath('future');
  const t0 = Date.parse('2026-08-26T12:00:00.000Z');
  writeCeiling(29, { ceilingPath: p, confirmations: 2, nowIso: new Date(t0 + 48 * 60 * 60 * 1000).toISOString() });
  assert.equal(readCeiling(p, { nowMs: t0 }), null, 'two days in the future is nonsense, not fresh');
  // Ordinary clock skew (a second or two ahead) must still be accepted.
  writeCeiling(29, { ceilingPath: p, confirmations: 2, nowIso: new Date(t0 + 2000).toISOString() });
  assert.equal(readCeiling(p, { nowMs: t0 }), 29);
});

test('a dump with no runtime= field anywhere is UNKNOWN, not "zero live, plenty of room"', () => {
  // If cmux keeps the block layout but renames the field, every record parses
  // with runtime:null and countLiveRuntimes returns 0 — which would read as
  // wide-open capacity and silently switch the gate off.
  const renamed = '[0] surface:1 "t" mapped=1 workspace=workspace:1 ctx=tab\n    attached=1 ghostty=0x1\n    created=1.0s\n'
    + '[1] surface:2 "t" mapped=1 workspace=workspace:2 ctx=tab\n    attached=0 ghostty=nil\n    created=1.0s';
  const surfaces = parseDebugTerminals(renamed);
  assert.equal(surfaces.length, 2, 'the blocks still parse — that is exactly what makes this dangerous');
  assert.equal(countLiveRuntimes(surfaces), 0);
  assert.equal(hasRuntimeSignal(surfaces), false);

  const p = tmpCeilingPath('blind');
  writeCeiling(MIN_PLAUSIBLE_CEILING, { ceilingPath: p, confirmations: CEILING_CONFIRMATIONS_REQUIRED });
  const r = probeTerminalCapacity({ debugTerminals: () => renamed, ceilingPath: p });
  assert.equal(r.liveRuntimes, null, 'no runtime signal means unknown, never 0');
  assert.equal(r.known, false);
  assert.equal(r.hasCapacity, true, 'still fail-open — but on "unknown", not on a fabricated 0');
});

test('hasRuntimeSignal is true as soon as ONE block carries a real runtime field', () => {
  assert.equal(hasRuntimeSignal(parseDebugTerminals(REAL_DUMP)), true);
  assert.equal(hasRuntimeSignal([]), false);
  assert.equal(hasRuntimeSignal(null), false);
});

test('the ceiling file is published atomically — a reader never sees a partial write', () => {
  // A dozen parallel sessions dispatch on this host; a torn ceiling file reads
  // as no ceiling and silently disables the gate.
  const p = tmpCeilingPath('atomic');
  writeCeiling(29, { ceilingPath: p, note: 'x'.repeat(50000) });
  const dir = path.dirname(p);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [],
    'no stray .tmp file may survive a successful write');
  assert.equal(readCeiling(p), 29);
});

test('recordLaunchOutcome still works when the lock cannot be taken (fail-open)', () => {
  // withFileLock runs the body anyway after its timeout. Blocking a dispatch
  // on a scratch-file lock would be far worse than a lost ceiling update.
  const p = tmpCeilingPath('locked');
  fs.writeFileSync(`${p}.lock`, `${process.pid} held\n`); // this process's own pid: not stale, not stealable
  const r = recordLaunchOutcome({ liveRuntimesBefore: 29, outcome: 'runtime-missing', ceilingPath: p });
  assert.equal(r.changed, true, 'the learn must still happen even when the lock is unavailable');
  assert.equal(readCeiling(p), 29);
});
