// Regression tests for two fixes that shipped WITHOUT tests in 4718e869792,
// both found by adversarial review of already-committed code (2026-09-16).
//
// Per CLAUDE.md rule 15 these require() the real functions — no logic is
// copied, so a regression in the module fails these.

import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  pendingDecisions, collapseCrownLineages, formatDetail, buildNeedsYouSnapshot,
} = require('./needs-you-snapshot.js');

// ── 1. crown borrow ─────────────────────────────────────────────────────
// When the NEWEST crown generation is title-only (no state file), it wins the
// version sort and becomes `latest`. Before the fix its hollow "open the tab"
// placeholder REPLACED a superseded generation's real captured question —
// strictly less than the digest showed before title-only items existed.

test('crown borrow: a title-only newest generation does not discard an older generation\'s question', () => {
  const states = [
    { ref: 'workspace:10', question: 'Cancel Cyrus Team Cloud at $120/mo?', ts: '2026-09-01T10:00:00Z' },
  ];
  const workspaces = [
    { ref: 'workspace:10', title: '❓ 👑 OWNER — Crown v32: BRO-343 triage' },
    { ref: 'workspace:11', title: '❓ 👑 OWNER — Crown v33: BRO-343 triage' }, // newest, no state file
  ];
  const [folded] = collapseCrownLineages(pendingDecisions(states, workspaces));

  assert.match(folded.title, /v33/, 'newest generation title must be kept');
  assert.equal(folded.question, 'Cancel Cyrus Team Cloud at $120/mo?', 'question must be borrowed');
  assert.equal(folded.questionUnavailable, false);
  assert.match(formatDetail(folded), /Cancel Cyrus Team Cloud/);
  assert.doesNotMatch(formatDetail(folded), /open the tab/);
});

test('crown borrow: borrows the MOST RECENT captured question, not the oldest', () => {
  const states = [
    { ref: 'workspace:10', question: 'oldest phrasing', ts: '2026-09-01T10:00:00Z' },
    { ref: 'workspace:11', question: 'newer phrasing', ts: '2026-09-05T10:00:00Z' },
  ];
  const workspaces = [
    { ref: 'workspace:10', title: '❓ 👑 OWNER — Crown v31: same lineage' },
    { ref: 'workspace:11', title: '❓ 👑 OWNER — Crown v32: same lineage' },
    { ref: 'workspace:12', title: '❓ 👑 OWNER — Crown v33: same lineage' }, // title-only
  ];
  const [folded] = collapseCrownLineages(pendingDecisions(states, workspaces));
  assert.equal(folded.question, 'newer phrasing');
  assert.equal(folded.supersededCount, 2);
  assert.equal(folded.pendingSinceTs, '2026-09-01T10:00:00Z', 'age comes from the EARLIEST generation');
});

test('crown borrow: a lineage with no captured question anywhere keeps the placeholder', () => {
  const workspaces = [
    { ref: 'workspace:10', title: '❓ 👑 OWNER — Crown v32: nothing captured' },
    { ref: 'workspace:11', title: '❓ 👑 OWNER — Crown v33: nothing captured' },
  ];
  const [folded] = collapseCrownLineages(pendingDecisions([], workspaces));
  assert.equal(folded.questionUnavailable, true);
  assert.match(formatDetail(folded), /open the tab/);
});

test('crown borrow: an empty-content ("none") question is not borrowed', () => {
  const states = [
    { ref: 'workspace:10', question: 'none — no pending decision', ts: '2026-09-01T10:00:00Z' },
  ];
  const workspaces = [
    { ref: 'workspace:10', title: '❓ 👑 OWNER — Crown v32: stub' },
    { ref: 'workspace:11', title: '❓ 👑 OWNER — Crown v33: stub' },
  ];
  const [folded] = collapseCrownLineages(pendingDecisions(states, workspaces));
  assert.equal(folded.questionUnavailable, true, 'a "none" stub is not a real question to borrow');
});

// ── 2. undated ordering ─────────────────────────────────────────────────
// Title-only items have no timestamp. A bare '' sorts BEFORE every ISO date,
// which floated hollow placeholders above genuinely long-pending decisions.

test('ordering: undated title-only items sort AFTER dated decisions', () => {
  const states = [
    { ref: 'workspace:1', question: 'oldest real decision', ts: '2026-08-01T10:00:00Z' },
    { ref: 'workspace:2', question: 'newer real decision', ts: '2026-09-10T10:00:00Z' },
  ];
  const workspaces = [
    { ref: 'workspace:3', title: '❓ no state file at all' },
    { ref: 'workspace:2', title: '❓ newer real decision tab' },
    { ref: 'workspace:1', title: '❓ oldest real decision tab' },
  ];
  const sorted = collapseCrownLineages(pendingDecisions(states, workspaces))
    .sort((a, b) => {
      const ka = String(a.pendingSinceTs || a.ts || '￿');
      const kb = String(b.pendingSinceTs || b.ts || '￿');
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  assert.deepEqual(sorted.map(x => x.ref), ['workspace:1', 'workspace:2', 'workspace:3']);
});

test('ordering: the \\uffff sentinel beats every ISO timestamp under a deterministic compare', () => {
  // localeCompare is locale-sensitive and does NOT follow code-point order in
  // general, which is why the module uses `<`/`>` rather than localeCompare.
  const S = '￿';
  for (const d of ['1999-01-01T00:00:00Z', '2026-09-01T10:00:00Z', '2099-12-31T23:59:59Z', '']) {
    assert.ok(S > d, `sentinel must sort after ${JSON.stringify(d)}`);
  }
});

// ── 3. the real builder still works end to end ──────────────────────────

test('buildNeedsYouSnapshot returns a well-formed snapshot or null (no cmux)', () => {
  const snap = buildNeedsYouSnapshot();
  if (snap === null) return; // no cmux on this machine — acceptable
  assert.ok(typeof snap.generatedAt === 'string');
  assert.ok(typeof snap.bannerText === 'string');
  assert.ok(Array.isArray(snap.items));
  for (const i of snap.items) {
    assert.ok(typeof i.title === 'string' && i.title.length > 0);
    assert.ok(typeof i.detail === 'string' && i.detail.length > 0,
      'every item must render a non-empty detail, never an empty string');
  }
});
