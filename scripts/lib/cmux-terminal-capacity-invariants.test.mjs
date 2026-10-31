// Exhaustive state-space invariants for the learned terminal-runtime ceiling.
//
// WHY THIS EXISTS, SEPARATELY FROM cmux-terminal-capacity.test.mjs
// ----------------------------------------------------------------
// The example-based tests next door assert what specific observation sequences
// do. Twice now (task #1904, 2026-08-26) a change passed every one of them and
// still shipped a CONFIRMED ceiling that no observation supported — the one
// failure mode of this module that does real harm, because a fabricated low
// ceiling REFUSES healthy dispatches for the full 24h TTL while reporting a
// confident "cap observed at N" on a half-empty cmux:
//
//   1. The candidate arm paired a min() value with a monotonic counter, so from
//      a confirmed 29, a miss at 28 plus an unrelated miss at 12 promoted a
//      CONFIRMED 12 — corroboration counted across observations at different
//      counts, so no single value was ever seen twice.
//   2. A success at/above the ceiling raised it to `before + 1`, inventing a
//      number nothing had observed, which then collected corroboration from
//      failures far above it:
//        missing@12 -> 12/1 ; created@12 -> 13/0 ; missing@30 x2 -> 13 CONFIRMED
//      i.e. refusing at 20 live tabs having seen a SUCCESS at 12 and failures
//      only at 30.
//
// Both were found by adversarial review, not by the suite. An example test can
// only encode a sequence someone thought of; the harm is defined over ALL
// sequences. So this walks the reachable state space and checks the property
// directly — replaying each state's own observation history and asserting the
// number the gate would ENFORCE is actually supported by it.
//
// Pure and clock-free (CLAUDE.md rule 15): learnCeiling/decideCapacity only.
// No fs, no cmux, no timers — the whole walk runs in milliseconds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  learnCeiling, decideCapacity, MIN_PLAUSIBLE_CEILING, CEILING_CONFIRMATIONS_REQUIRED,
} = require('./cmux-terminal-capacity.js');

// Spread across the plausibility floor (8), the real measured cap on this
// machine (29-30), and both sides of it. Kept small on purpose: the walk is
// O(states x counts x outcomes) per level and the interesting transitions are
// about ORDER, not about how many distinct integers exist.
const COUNTS = [5, 8, 12, 20, 25, 28, 29, 34];
const OUTCOMES = ['runtime-missing', 'runtime-created'];
const DEPTH = 7;

const stateKey = (s) => `${s.ceiling}|${s.confirmations}|${s.candidate}|${s.candidateConfirmations}`;

/** Every state reachable from empty within DEPTH observations, with one path that reaches it. */
function walk() {
  const start = { ceiling: null, confirmations: 0, candidate: null, candidateConfirmations: 0 };
  const seen = new Map([[stateKey(start), { state: start, path: [] }]]);
  let frontier = [seen.get(stateKey(start))];
  for (let depth = 0; depth < DEPTH && frontier.length; depth++) {
    const next = [];
    for (const node of frontier) {
      for (const before of COUNTS) {
        for (const outcome of OUTCOMES) {
          const r = learnCeiling({ ...node.state, liveRuntimesBefore: before, outcome });
          const state = {
            ceiling: r.ceiling, confirmations: r.confirmations,
            candidate: r.candidate, candidateConfirmations: r.candidateConfirmations,
          };
          const k = stateKey(state);
          if (seen.has(k)) continue;
          const entry = { state, path: [...node.path, { outcome, before }] };
          seen.set(k, entry);
          next.push(entry);
        }
      }
    }
    frontier = next;
  }
  return [...seen.values()];
}

const REACHABLE = walk();
const describe = (n) => `${stateKey(n.state)} via ${n.path.map(s => `${s.outcome}@${s.before}`).join(' -> ') || '(empty)'}`;

// States the WALK cannot produce but production can (adversarial review catch).
// The two halves of the record expire independently, so readCeilingRecord can
// hand learnCeiling a fresh candidate with no confirmed ceiling left — a shape
// no sequence of observations alone reaches, and one learnCeiling has a
// dedicated arm for. Transition checks run over these too, or that arm is
// unreviewed by every invariant here.
const EXPIRY_SEEDS = COUNTS
  .filter(v => v >= MIN_PLAUSIBLE_CEILING)
  .map(v => ({ ceiling: null, confirmations: 0, candidate: v, candidateConfirmations: 1 }));
const PRE_STATES = [...REACHABLE.map(n => n.state), ...EXPIRY_SEEDS];

test('the reachable state space is actually being explored', () => {
  // A guard on the guard: if a refactor made learnCeiling inert, every check
  // below would pass vacuously against a single state.
  assert.equal(REACHABLE.length > 50, true, `only ${REACHABLE.length} states reachable — the walk is not exercising the module`);
  // Branch-level, not just total: several invariants below only bite on states
  // that HAVE a candidate, or on inputs under the plausibility floor. If a
  // refactor stopped producing those, those checks would pass vacuously while
  // still iterating plenty of states (adversarial review catch).
  const withCandidate = REACHABLE.filter(n => n.state.candidate !== null).length;
  assert.equal(withCandidate > 5, true, `only ${withCandidate} candidate-bearing states — the candidate invariants would be near-vacuous`);
  const armed = REACHABLE.filter(n => decideCapacity({
    liveRuntimes: Number.MAX_SAFE_INTEGER, ceiling: n.state.ceiling, confirmations: n.state.confirmations,
  }).ceiling !== null).length;
  assert.equal(armed > 5, true, `only ${armed} armed states — the arming invariants would be near-vacuous`);
  assert.equal(COUNTS.some(v => v < MIN_PLAUSIBLE_CEILING), true, 'COUNTS must straddle the plausibility floor or that invariant is vacuous');
});

test('INVARIANT: a candidate can only be introduced by a FAILURE at exactly that count', () => {
  // The provenance hole the arming invariant alone leaves open (adversarial
  // review catch, and the sharpest finding on this file). That check accepts a
  // promotion whose value "was already tracked as the candidate" — but it takes
  // the candidate's own legitimacy on trust. Mutate learnCeiling so a
  // runtime-CREATED plants a candidate and the fabrication launders itself:
  //   missing@29, missing@29, created@28, missing@34
  // arms a confirmed ceiling of 28 with no failure at 28 ever observed, and
  // every other invariant here passes it, because the identical candidate state
  // is ALSO reachable innocently via missing@28 and the walk stored that path.
  //
  // Closing it inductively is what makes the arming check sound: a candidate may
  // only ever come from a failure AT its own value, so a "tracked" candidate is
  // always evidence-backed by construction.
  const violations = [];
  let introductions = 0;
  for (const s of PRE_STATES) {
    for (const before of COUNTS) {
      for (const outcome of OUTCOMES) {
        const r = learnCeiling({ ...s, liveRuntimesBefore: before, outcome });
        if (r.candidate === null || r.candidate === s.candidate) continue;
        introductions++;
        const step = `${outcome}@${before} from ${stateKey(s)} set candidate ${r.candidate}`;
        if (outcome !== 'runtime-missing') violations.push(`${step} — a SUCCESS must never introduce a candidate`);
        else if (r.candidate !== before) violations.push(`${step} — candidate is not the observed count`);
      }
    }
  }
  assert.equal(introductions > 5, true, `only ${introductions} candidate introductions seen — check is near-vacuous`);
  assert.deepEqual(violations, [], `fabricated candidate(s):\n  ${violations.join('\n  ')}`);
});

test('INVARIANT: a ceiling can only take a NEW value from a failure at it, or from the candidate', () => {
  // The same provenance rule one level up, so the two compose: every number the
  // module holds traces back to a failure actually observed at that count.
  const violations = [];
  let moves = 0;
  for (const s of PRE_STATES) {
    for (const before of COUNTS) {
      for (const outcome of OUTCOMES) {
        const r = learnCeiling({ ...s, liveRuntimesBefore: before, outcome });
        if (r.ceiling === null || r.ceiling === s.ceiling) continue;
        moves++;
        const step = `${outcome}@${before} from ${stateKey(s)} moved ceiling to ${r.ceiling}`;
        if (r.ceiling === s.candidate) continue; // promotion — legitimacy covered by the candidate invariant
        if (outcome !== 'runtime-missing') violations.push(`${step} — a SUCCESS must never install a ceiling value`);
        else if (r.ceiling !== before) violations.push(`${step} — value is neither the observed count nor the tracked candidate`);
      }
    }
  }
  assert.equal(moves > 5, true, `only ${moves} ceiling moves seen — check is near-vacuous`);
  assert.deepEqual(violations, [], `fabricated ceiling value(s):\n  ${violations.join('\n  ')}`);
});

test('INVARIANT: arming a NEW ceiling requires that exact value to have been tracked and corroborated', () => {
  // The property both shipped bugs violated, checked as a TRANSITION rather
  // than as a property of states.
  //
  // Checking states does not work here and the first cut of this test was
  // unsound because of it: the buggy candidate arm promoted a CONFIRMED ceiling
  // of 12 from {missing@29, missing@29, missing@28, missing@12}, but the
  // resulting state {ceiling:12, confirmations:2} is ALSO reachable innocently
  // (two straight failures at 12), so the walk had already stored the innocent
  // path and the check passed a mutant that demonstrably reproduced the bug.
  // Only the step that ARMS the value can be judged; the state it lands in
  // carries no evidence of how it got there.
  //
  // The rule, stated over one step: when an observation makes a value
  // actionable that was not actionable before, that value must be the one the
  // pre-state was already tracking — its confirmed ceiling or its candidate,
  // never a value synthesised from the observation (a min(), an arithmetic
  // guess) — it must already carry CEILING_CONFIRMATIONS_REQUIRED - 1
  // observations, and this observation must itself be a failure at or above it.
  const violations = [];
  let armings = 0;
  for (const s of PRE_STATES) {
    const armedBefore = decideCapacity({
      liveRuntimes: Number.MAX_SAFE_INTEGER, ceiling: s.ceiling, confirmations: s.confirmations,
    }).ceiling;
    for (const before of COUNTS) {
      for (const outcome of OUTCOMES) {
        const r = learnCeiling({ ...s, liveRuntimesBefore: before, outcome });
        const armedAfter = decideCapacity({
          liveRuntimes: Number.MAX_SAFE_INTEGER, ceiling: r.ceiling, confirmations: r.confirmations,
        }).ceiling;
        if (armedAfter === null || armedAfter === armedBefore) continue;
        armings++;
        const step = `${outcome}@${before} from ${stateKey(s)} armed ${armedAfter}`;
        if (outcome !== 'runtime-missing') { violations.push(`${step} — a SUCCESS must never arm a ceiling`); continue; }
        const wasTracked = armedAfter === s.ceiling || armedAfter === s.candidate;
        if (!wasTracked) {
          violations.push(`${step} — value was neither the tracked ceiling (${s.ceiling}) nor the candidate (${s.candidate}); it was synthesised from this observation`);
          continue;
        }
        if (before < armedAfter) violations.push(`${step} — corroborating failure was BELOW the value it corroborated`);
        const priorCount = armedAfter === s.candidate ? s.candidateConfirmations : s.confirmations;
        if (priorCount < CEILING_CONFIRMATIONS_REQUIRED - 1) {
          violations.push(`${step} — only ${priorCount} prior observation(s) behind that value`);
        }
      }
    }
  }
  assert.equal(armings > 20, true, `only ${armings} arming transitions seen — the walk is not exercising the gate`);
  assert.deepEqual(violations, [], `fabricated ceiling(s):\n  ${violations.join('\n  ')}`);
});

test('INVARIANT: no single observation can lower the ceiling the gate enforces', () => {
  // Finding 4, stated as a property. From any armed state with no candidate
  // already in flight, one runtime-missing must never move the enforced number
  // down — that is the latch that refused every dispatch above 12 live tabs for
  // a day off one unrelated failure.
  const violations = [];
  let transitions = 0;
  for (const s of PRE_STATES) {
    if (s.candidate !== null) continue; // mid-corroboration: promoting next IS the 2-observation rule
    const armedBefore = decideCapacity({
      liveRuntimes: Number.MAX_SAFE_INTEGER, ceiling: s.ceiling, confirmations: s.confirmations,
    }).ceiling;
    if (armedBefore === null) continue;
    for (const before of COUNTS) {
      transitions++;
      const r = learnCeiling({ ...s, liveRuntimesBefore: before, outcome: 'runtime-missing' });
      const armedAfter = decideCapacity({
        liveRuntimes: Number.MAX_SAFE_INTEGER, ceiling: r.ceiling, confirmations: r.confirmations,
      }).ceiling;
      if (armedAfter !== null && armedAfter < armedBefore) {
        violations.push(`${armedBefore} -> ${armedAfter} on runtime-missing@${before} from ${stateKey(s)}`);
      }
    }
  }
  assert.equal(transitions > 100, true, 'not enough armed states to make this meaningful');
  assert.deepEqual(violations, [], `single-observation drop(s):\n  ${violations.join('\n  ')}`);
});

test('INVARIANT: every stored number is a value some observation actually produced', () => {
  const violations = [];
  for (const node of REACHABLE) {
    const { ceiling, candidate } = node.state;
    const observed = new Set(node.path.map(s => s.before));
    if (ceiling !== null && !observed.has(ceiling)) violations.push(`ceiling ${ceiling} unobserved: ${describe(node)}`);
    if (candidate !== null && !observed.has(candidate)) violations.push(`candidate ${candidate} unobserved: ${describe(node)}`);
  }
  assert.deepEqual(violations, [], `invented number(s):\n  ${violations.join('\n  ')}`);
});

test('INVARIANT: the candidate is well-formed wherever it exists', () => {
  const violations = [];
  for (const node of REACHABLE) {
    const { ceiling, confirmations, candidate, candidateConfirmations } = node.state;
    if (candidate === null) {
      if (candidateConfirmations !== 0) violations.push(`orphan candidate count ${candidateConfirmations}: ${describe(node)}`);
      continue;
    }
    // A candidate only exists to be measured against a CONFIRMED ceiling.
    if (!(Number.isInteger(ceiling) && confirmations >= CEILING_CONFIRMATIONS_REQUIRED)) {
      violations.push(`candidate alongside an unconfirmed ceiling: ${describe(node)}`);
    }
    if (candidate >= ceiling) violations.push(`candidate ${candidate} >= ceiling ${ceiling}: ${describe(node)}`);
    // Must be mid-corroboration: a candidate at the bar should have been promoted.
    if (candidateConfirmations < 1 || candidateConfirmations >= CEILING_CONFIRMATIONS_REQUIRED) {
      violations.push(`candidate stuck at ${candidateConfirmations}/${CEILING_CONFIRMATIONS_REQUIRED}: ${describe(node)}`);
    }
  }
  assert.deepEqual(violations, [], `malformed candidate state(s):\n  ${violations.join('\n  ')}`);
});

test('INVARIANT: the plausibility floor holds for both halves', () => {
  // A cmux carrying 7 terminals is not at a resource cap, so nothing down there
  // may ever become an actionable number — this is the backstop that keeps a
  // crashed app or a bad cwd from latching the gate shut.
  const violations = [];
  for (const node of REACHABLE) {
    const { ceiling, candidate } = node.state;
    if (ceiling !== null && ceiling < MIN_PLAUSIBLE_CEILING) violations.push(`ceiling ${ceiling}: ${describe(node)}`);
    if (candidate !== null && candidate < MIN_PLAUSIBLE_CEILING) violations.push(`candidate ${candidate}: ${describe(node)}`);
  }
  assert.deepEqual(violations, [], `below-floor value(s):\n  ${violations.join('\n  ')}`);
});

test('LIVENESS: a genuinely lowered cap is still learnable', () => {
  // The invariants above are all safety properties — they would all hold for a
  // module that simply never learned anything. This is the counterweight: from
  // a confirmed 29, a real drop to 22 (which produces failures at every count
  // at or above 22) must still arm the gate at the new number.
  let s = { ceiling: 29, confirmations: CEILING_CONFIRMATIONS_REQUIRED, candidate: null, candidateConfirmations: 0 };
  for (const before of [22, 26]) s = pick(learnCeiling({ ...s, liveRuntimesBefore: before, outcome: 'runtime-missing' }));
  assert.equal(decideCapacity({ liveRuntimes: 22, ceiling: s.ceiling, confirmations: s.confirmations }).hasCapacity, false,
    'two corroborating failures at or above 22 must supersede the confirmed 29');
  assert.equal(s.ceiling, 22);
});

test('LIVENESS: a ceiling learned too low is escapable', () => {
  // The recovery direction. A success at or above the ceiling disproves it, and
  // the gate must go quiet rather than keep refusing — otherwise a wrong number
  // survives until the TTL with nothing able to dislodge it.
  const armed = { ceiling: 20, confirmations: CEILING_CONFIRMATIONS_REQUIRED, candidate: null, candidateConfirmations: 0 };
  assert.equal(decideCapacity({ liveRuntimes: 25, ceiling: armed.ceiling, confirmations: armed.confirmations }).hasCapacity, false);
  const after = learnCeiling({ ...armed, liveRuntimesBefore: 25, outcome: 'runtime-created' });
  assert.equal(decideCapacity({ liveRuntimes: 25, ceiling: after.ceiling, confirmations: after.confirmations }).hasCapacity, true,
    'a demonstrated success at 25 must stop the gate refusing at 25');
});

function pick(r) {
  return { ceiling: r.ceiling, confirmations: r.confirmations, candidate: r.candidate, candidateConfirmations: r.candidateConfirmations };
}
