// BRO-7881 guard. Two layers (CLAUDE.md §19, new gates land advisory first):
//   - PINNED: the files BRO-7881 fixed must stay free of owner-friction phrasing, and the docs must keep matching the
//     code they describe (review-gate --note route, planning-tier unlock routes). Fails if any of those fixes is reverted.
//   - ADVISORY: the whole scan (every .claude/commands/*.md, CLAUDE.md, CLOUD.md, owner-escalation.md) prints its hit
//     list and only fails with OWNER_FRICTION_STRICT=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { scan, PATTERNS, ALLOWLIST, scanFiles } from './owner-friction-scan.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');
const PINNED = ['CLAUDE.md', '.claude/commands/right-problem.md', '.claude/commands/second-opinion.md', '.claude/commands/plan-review.md'];

test('patterns: each BRO-7881 phrasing is caught; owner-chosen DECISION NEEDED wording is not', () => {
  const hit = (s) => scan({ files: ['x.md'], read: () => s }).map((h) => h.id);
  assert.deepEqual(hit('Should I proceed to detailed planning with this approach?'), ['should-i-proceed']);
  assert.deepEqual(hit('The user is approving THE PLAN, not a diff.'), ['user-approving-plan']);
  assert.deepEqual(hit('After the user approves a plan, comment on the card'), ['after-user-approves-plan']);
  assert.deepEqual(hit('Present the revised plan and ask: "Want to go with the revised plan, keep the original?"'), ['revised-plan-ask']);
  assert.deepEqual(hit('a fail stands until an `owner-override` verdict.'), ['fail-needs-owner-override']);
  assert.deepEqual(hit('overturning it is the owner\'s call, recorded as owner-override'), ['fail-needs-owner-override']);
  assert.deepEqual(hit('then ask the owner to approve the approach'), ['ask-owner-to-approve']);
  assert.deepEqual(hit('Ask once, as one DECISION NEEDED block with the plan summary and your recommendation.'), []);
  assert.deepEqual(hit('Social posts: the owner approves the exact words before anything is posted.'), []);
  assert.deepEqual(hit('pause and confirm with the owner before continuing'), ['confirm-with-owner']);
  assert.deepEqual(hit('Want me to proceed with option B?'), ['should-i-proceed']);
  assert.deepEqual(hit('wait for the owner\'s go-ahead, then push'), ['owner-signoff']);
  assert.ok(PATTERNS.length >= 9);
  for (const a of ALLOWLIST) assert.ok(a.why && a.why.length > 20, `allowlist entry ${a.file}/${a.id} must name the owner decision`);
});

test('pinned: the files BRO-7881 fixed carry no owner-friction phrasing', () => {
  const hits = scan({ files: PINNED });
  assert.deepEqual(hits.map((h) => `${h.file}:${h.line} ${h.id}`), []);
});

test('pinned: right-problem and plan-review decide technical plans and keep the owner-chosen asks', () => {
  const rp = read('.claude/commands/right-problem.md');
  assert.match(rp, /### Phase 6: Decide and proceed/);
  assert.match(rp, /substantial new system \(CLAUDE\.md §20, owner decision 2026-10-25\)/);
  const pr = read('.claude/commands/plan-review.md');
  assert.match(pr, /### Phase 7: Decide, or ask only when it is the owner's call/);
  assert.match(pr, /owner chose on 2026-10-25 that substantial efforts get a plan, \/plan-review and their yes/);
  assert.match(pr, /do not start building it until the owner answers/);
});

test('pinned: a fail verdict is cleared the way review-gate.mjs really clears it (re-reviewed pass with --note)', async () => {
  const { recordPlanVerdict } = await import('./review-gate.mjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'ofs-'));
  const rec = (o) => recordPlanVerdict({ repoRoot: dir, ledgerRoot: dir, reviewer: 'second-opinion', sessionId: 's', ...o });
  try {
    assert.equal(rec({ result: 'fail' }).recorded, true);
    assert.equal(rec({ result: 'pass' }).recorded, false, 'a pass after a fail must need --note, or the docs below are wrong');
    assert.equal(rec({ result: 'pass', note: 'revised' }).recorded, true, 'a noted pass must clear a fail, or the docs below are wrong');
  } finally { rmSync(dir, { recursive: true, force: true }); }
  for (const f of ['CLAUDE.md', '.claude/commands/second-opinion.md', '.claude/commands/plan-review.md']) {
    assert.match(read(f), /--note="<what changed/, `${f} must name the --note route`);
  }
});

test('pinned: the planning-tier message names exactly what isApproved() accepts, and keeps the owner yes', () => {
  const pt = require('./planning-tier.js');
  const { message } = pt.decide({ tier: 'substantial', triggers: ['new workflow x.yml'], approved: false, mode: 'block' });
  assert.match(message, /--reviewer=plan-review/);
  assert.match(message, /OWNER-PLAN-APPROVED:/);
  assert.match(message, /owner decision 2026-10-25/);
  assert.doesNotMatch(message, /and get the owner's yes/, 'old wording implied the yes is what lifts the gate');
  // ...and the two routes the message names are the two isApproved() takes.
  assert.equal(pt.isApproved({ verdicts: [{ phase: 'plan', reviewer: 'plan-review', result: 'pass', sessionId: 's', ts: new Date().toISOString() }], sessionId: 's' }).ok, true);
  const user = JSON.stringify({ type: 'user', message: { role: 'user', content: 'OWNER-PLAN-APPROVED: "yes, build it"' } });
  assert.equal(pt.isApproved({ verdicts: [], sessionId: 's', transcriptText: user }).ok, true);
  assert.equal(pt.isApproved({ verdicts: [{ phase: 'plan', reviewer: 'second-opinion', result: 'pass', sessionId: 's', ts: new Date().toISOString() }], sessionId: 's' }).ok, false);
  assert.match(read('CLAUDE.md'), /### 20\.[^\n]*\n[^\n]*build only after it\. The hook lifts on a plan-review verdict too, the yes is still owed/);
});

test('advisory: full scan hit list (fails only with OWNER_FRICTION_STRICT=1)', () => {
  const hits = scan();
  for (const h of hits) console.log(`[owner-friction advisory] ${h.file}:${h.line} [${h.id}] ${h.text}`);
  console.log(`[owner-friction advisory] ${hits.length} hit(s) across ${scanFiles().length} file(s)`);
  if (process.env.OWNER_FRICTION_STRICT === '1') assert.deepEqual(hits, []);
});
