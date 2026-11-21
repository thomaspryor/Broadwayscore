// BRO-7552: replays the 2026-11-15 session (SAFE TO ARCHIVE "live and verified" over a pending EFFECT and an
// unmeasured spend change) through the Stop check. Each gate branch has a case that fails with that branch removed.
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from './effect-pending-stop.mjs';
import assert from 'node:assert/strict';
import { stopHookDecision, claimsVerified, lastEffectLine, effectSources, fetchEdits, spendCheckRuns, blockBudget, EFFECT_PENDING_BLOCKING_FROM } from './effect-pending-stop.mjs';

const ENV = { CLAUDE_CODE_REMOTE: 'true' };
let n = 0;
const id = () => `t${++n}`;
const text = (t) => ({ kind: 'assistant_text', text: t });
const use = (name, input) => { const e = { kind: 'assistant_tool_use', name, input, id: id() }; return [e, (c, isError = false) => ({ kind: 'tool_result', tool_use_id: e.id, content: c, isError })]; };
const bash = (command, out = 'ok') => { const [u, r] = use('Bash', { command }); return [u, r(out)]; };
const edit = (file_path, new_string = 'x') => { const [u, r] = use('Edit', { file_path, new_string }); return [u, r('edited')]; };
const land = () => bash('git push origin HEAD:refs/heads/land/bro-7532-fix', 'To github.com:x\n * [new branch] HEAD -> land/bro-7532-fix');
const CLOSE = 'Both changes are live and verified.\nStill running: nothing.\nSAFE TO ARCHIVE — both changes are live and verified';
// BRO-7532's real comments (newest first, as list_comments returns them), trimmed.
const cardRead = (issueId, comments) => { const [u, r] = use('mcp__3307c749-7318-4776-9b30-f07de4a6352f__list_comments', { issueId }); return [u, r(JSON.stringify({ comments }))]; };
const BRO7532 = [
  { body: '**Session report (paused)** Landed and live. ROOT-CAUSE: paid render was the first route. CLASS-GUARD: scripts/lib/free-first-fetch.test.mjs (free hit = 0 paid; every failure shape = 1 paid). EFFECT: live check 5/5 known reviews found free; false hits fall back to paid; ledger numbers pending. EXECUTED: node --test x (60 pass)', createdAt: '2026-11-15T17:28:11Z' },
  { body: 'Claimed by session', createdAt: '2026-11-15T16:09:49Z' },
].reverse();
const SPEND_RUN = (verdict) => bash('node scripts/spend-effect-check.js --since=2026-11-15T17:06:00Z --hosts=deadline.com,serp', `host flow ...\nOVERALL VERDICT: ${verdict}`);

test('2026-11-15 replay: "live and verified" over a child card EFFECT "ledger numbers pending" is refused', () => {
  const events = [...cardRead('BRO-7532', BRO7532), ...edit('/repo/scripts/lib/site-search-discovery.js'), ...land(), text(CLOSE)];
  const d = stopHookDecision({ lastMessage: CLOSE, events, env: ENV });
  assert.equal(d.decision, 'block');
  assert.match(d.message, /defers the measurement/);
  assert.match(d.message, /BRO-7532/);
  assert.match(d.message, /never ran scripts\/spend-effect-check\.js/);
  assert.match(d.message, /not yet proven until/);
});

test('plain honest closing ("live, not yet proven until 2026-11-18") passes once the spend check was run and says pending', () => {
  const msg = 'Live, not yet proven until 2026-11-18.\nSAFE TO ARCHIVE — landed, first observation needs a press night';
  const events = [...cardRead('BRO-7532', BRO7532), ...edit('/repo/scripts/lib/site-search-discovery.js'), ...land(), ...SPEND_RUN('pending'), text(msg)];
  assert.equal(stopHookDecision({ lastMessage: msg, events, env: ENV }).decision, 'allow');
});

test('measured change passes: spend check saved, EFFECT has numbers, message says verified', () => {
  const effect = 'EFFECT: deadline.com paid renders 24/h before, 4/h after (spend-effect-check, all flows, Broadway press night included)';
  const events = [...edit('/repo/scripts/lib/url-discovery.js'), ...land(), ...SPEND_RUN('saved'), text(effect)];
  assert.equal(stopHookDecision({ lastMessage: CLOSE, events, env: ENV }).decision, 'allow');
});

test('637f3125e replay: no spend check after landing a SERP change is refused even with no "verified" word', () => {
  const msg = 'Search chain change landed.\nSAFE TO ARCHIVE — landed';
  const events = [...edit('/repo/scripts/lib/url-discovery.js'), ...land(), text(msg)];
  const d = stopHookDecision({ lastMessage: msg, events, env: ENV });
  assert.equal(d.decision, 'block');
  assert.match(d.message, /never ran scripts\/spend-effect-check\.js/);
});

test('a spend check run BEFORE the landing does not count', () => {
  const msg = 'SAFE TO ARCHIVE — landed';
  const events = [...edit('/repo/scripts/lib/serp-chain-order.js'), ...SPEND_RUN('saved'), ...land(), text(msg)];
  assert.equal(stopHookDecision({ lastMessage: msg, events, env: ENV }).decision, 'block');
});

test('"Phase 3: skipped: no data effect" is named in the refusal for a spend change', () => {
  const cov = 'COVERAGE:\nPhase 3: skipped: no data effect\nPhase 4: skipped: no UI files changed';
  const msg = 'SAFE TO ARCHIVE — landed';
  const events = [...edit('/repo/scripts/lib/free-first-fetch.js'), ...land(), text(cov), text(msg)];
  const d = stopHookDecision({ lastMessage: msg, events, env: ENV });
  assert.equal(d.decision, 'block');
  assert.match(d.message, /Phase 3: skipped: no data effect" does not hold/);
});

test('contradiction: tool printed WORSE or NO CHANGE and the message still says verified', () => {
  for (const v of ['WORSE', 'NO CHANGE']) {
    const events = [...edit('/repo/scripts/lib/url-discovery.js'), ...land(), ...SPEND_RUN(v), text(CLOSE)];
    const d = stopHookDecision({ lastMessage: CLOSE, events, env: ENV });
    assert.equal(d.decision, 'block', v);
    assert.match(d.message, new RegExp(`OVERALL VERDICT: ${v}`));
  }
});

test('NO-EFFECT-CHECK with a reason covers a fetch edit with no spend effect', () => {
  const msg = 'SAFE TO ARCHIVE — landed';
  const events = [...edit('/repo/scripts/lib/scraper.js'), ...land(), text('NO-EFFECT-CHECK: comment-only edit, no call path changed'), text(msg)];
  assert.equal(stopHookDecision({ lastMessage: msg, events, env: ENV }).decision, 'allow');
});

test('a later measured EFFECT replaces an earlier pending one from the same source', () => {
  const events = [text('EFFECT: ledger numbers pending'), ...edit('/repo/scripts/lib/url-discovery.js'), ...land(), ...SPEND_RUN('saved'), text('EFFECT: deadline.com 24/h -> 4/h')];
  assert.equal(stopHookDecision({ lastMessage: CLOSE, events, env: ENV }).decision, 'allow');
});

test('text a command printed (grep, cat, tests) is not the session\'s EFFECT line', () => {
  const [u, r] = bash('grep -rn EFFECT docs/', 'docs/x.md:3:EFFECT: ledger numbers pending');
  const events = [u, r, text('Docs checked.')];
  assert.deepEqual(effectSources(events, -1, CLOSE), []);
  assert.equal(stopHookDecision({ lastMessage: CLOSE, events, env: ENV }).decision, 'allow');
});

test('a pending EFFECT with no verified claim is allowed (honesty about being early)', () => {
  const msg = 'Landed. Not yet verified.\nSAFE TO ARCHIVE — live, effect not yet proven until 2026-11-18';
  const events = [text('EFFECT: ledger numbers pending'), ...cardRead('BRO-7532', BRO7532), text(msg)];
  assert.equal(stopHookDecision({ lastMessage: msg, events, env: ENV }).decision, 'allow');
});

test('edits to tests, docs and unrelated files are not fetch edits; a vendor mention in another script is', () => {
  const ev = [...edit('/repo/scripts/lib/url-discovery.test.mjs'), ...edit('/repo/docs/x.md'), ...edit('/repo/src/app/page.tsx'), ...edit('/repo/scripts/foo.js', 'await scrapingbee.render(url)')].flat();
  assert.deepEqual(fetchEdits(ev, -1), ['/repo/scripts/foo.js']);
});

test("the gate's own scripts name vendors but are not spend changes (ship-check BRO-7552)", () => {
  const ev = [...edit('/repo/scripts/spend-effect-check.js', 'brightdata scrapingbee scraper-spend-ledger'), ...edit('/repo/scripts/lib/effect-pending-stop.mjs', 'scrapingbee'), ...edit('/repo/scripts/effect-pending-dryrun.mjs', 'brightdata')].flat();
  assert.deepEqual(fetchEdits(ev, -1), []);
});

test('claimsVerified: positives, negations and fenced code', () => {
  assert.ok(claimsVerified('both changes are live and verified'));
  assert.ok(claimsVerified('The chain is now working'));
  assert.ok(!claimsVerified('live, not yet proven until 2026-11-18'));
  assert.ok(!claimsVerified('This is not yet verified and unverified on Broadway'));
  assert.ok(!claimsVerified('```\nverified\n```\nlanded'));
});

test('lastEffectLine takes the newest EFFECT line; spendCheckRuns needs --since and a real answer', () => {
  assert.equal(lastEffectLine('EFFECT: a pending\nx\n**EFFECT:** b 24 to 4'), 'b 24 to 4');
  assert.equal(lastEffectLine('CLASS-GUARD: t. EFFECT: live 5/5; ledger numbers pending. EXECUTED: node --test'), 'live 5/5; ledger numbers pending.');
  assert.equal(lastEffectLine('NO-EFFECT-CHECK: comment-only edit here'), null);
  const [u, r] = bash('node scripts/spend-effect-check.js --help', 'usage');
  const [u2, r2] = bash('cat <<EOF\nnode scripts/spend-effect-check.js --since=x\nEOF', 'x');
  assert.deepEqual(spendCheckRuns([u, r, u2, r2], -1), []);
});

test('scope: not cloud, kill switch, not claiming SAFE TO ARCHIVE, nothing landed, empty transcript', () => {
  const events = [...cardRead('BRO-7532', BRO7532), ...edit('/repo/scripts/lib/url-discovery.js'), ...land()];
  assert.equal(stopHookDecision({ lastMessage: CLOSE, events, env: {} }).decision, 'allow');
  assert.equal(stopHookDecision({ lastMessage: CLOSE, events, env: { ...ENV, EFFECT_PENDING_STOP_DISABLE: '1' } }).decision, 'allow');
  assert.equal(stopHookDecision({ lastMessage: 'still working on it, verified so far', events, env: ENV }).decision, 'allow');
  assert.equal(stopHookDecision({ lastMessage: CLOSE, events: [], env: ENV }).decision, 'allow');
  assert.equal(stopHookDecision({ lastMessage: CLOSE, events: [...edit('/repo/scripts/lib/url-discovery.js')], env: ENV }).decision, 'allow', 'edited but never landed: nothing live to measure');
});

test('chunking: an earlier accepted claim does not leak its pending EFFECT into the next chunk of work', () => {
  const events = [text('EFFECT: ledger numbers pending'), text('SAFE TO ARCHIVE — first chunk'), text('Different work done.')];
  const d = stopHookDecision({ lastMessage: CLOSE, events, env: ENV });
  assert.equal(d.decision, 'allow');
});

test('budget is one nudge until the blocking date, two after', () => {
  assert.equal(blockBudget(new Date('2026-11-15T00:00:00Z')), 1);
  assert.equal(blockBudget(new Date(`${EFFECT_PENDING_BLOCKING_FROM}T00:00:00Z`)), 2);
});

test('verify-edits.sh keeps the effect-pending-stop call (a Mac-master sync must not silently drop it)', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const src = fs.readFileSync(path.join(root, '.claude', 'hooks', 'verify-edits.sh'), 'utf8');
  assert.match(src, /effect-pending-stop\.mjs" --stop-hook/);
  assert.match(src, /EFFECT_PENDING_STOP_DISABLE/);
});

test('main(): a real transcript file blocks once (exit 2), then the budget lets the same chunk through', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eps-'));
  const tp = path.join(dir, 't.jsonl');
  const rec = (type, content) => JSON.stringify({ type, message: { id: `m${Math.random()}`, content }, timestamp: '2026-11-15T20:00:00Z' });
  const lines = [
    rec('assistant', [{ type: 'tool_use', id: 'a1', name: 'Edit', input: { file_path: '/r/scripts/lib/url-discovery.js', new_string: 'x' } }]),
    rec('user', [{ type: 'tool_result', tool_use_id: 'a1', content: 'ok' }]),
    rec('assistant', [{ type: 'tool_use', id: 'a2', name: 'Bash', input: { command: 'git push origin HEAD:refs/heads/land/bro-1-x' } }]),
    rec('user', [{ type: 'tool_result', tool_use_id: 'a2', content: '* [new branch] HEAD -> land/bro-1-x' }]),
  ];
  fs.writeFileSync(tp, lines.join('\n') + '\n');
  const input = JSON.stringify({ transcript_path: tp, session_id: 's', last_assistant_message: CLOSE });
  const run = () => { const orig = fs.readFileSync; fs.readFileSync = (f, ...a) => (f === 0 ? input : orig(f, ...a)); const w = process.stderr.write; process.stderr.write = () => true; try { return main(['--stop-hook'], { env: ENV, now: new Date('2026-11-15T00:00:00Z') }); } finally { fs.readFileSync = orig; process.stderr.write = w; } };
  assert.equal(run(), 2);
  assert.equal(run(), 0);
  for (const f of fs.readdirSync(os.tmpdir())) if (f.startsWith('effect-pending-stop-')) fs.rmSync(path.join(os.tmpdir(), f), { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the did-it-work and ship-check docs carry the cost-change rules the gate enforces', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const dw = fs.readFileSync(path.join(root, '.claude', 'commands', 'did-it-work.md'), 'utf8');
  const sc = fs.readFileSync(path.join(root, '.claude', 'commands', 'ship-check.md'), 'utf8');
  assert.match(dw, /spend-effect-check\.js/);
  assert.match(dw, /every flow it serves/);
  assert.match(dw, /not evidence of savings/);
  assert.match(sc, /Phase 3 is then NOT skippable/);
});

test('ship-check BRO-7552: a parent session that only landed (no fetch edits of its own) is still refused "verified" over a WORSE run', () => {
  const events = [...land(), ...SPEND_RUN('WORSE')];
  assert.equal(stopHookDecision({ lastMessage: CLOSE, events, env: ENV }).decision, 'block');
});

test('ship-check BRO-7552: "live and confirmed" and "savings confirmed" count as verified claims', () => {
  assert.equal(claimsVerified('Both changes are live and confirmed.'), true);
  assert.equal(claimsVerified('Savings confirmed in the ledger.'), true);
  assert.equal(claimsVerified('Live, not yet proven until 2026-11-18.'), false);
});

// Parent-session finding (BRO-7552 follow-up): a child's REPORT-BACK arrives as an inbound peer turn, not as a card read.
const REPORT_BACK = '<cross-session-message from-session="session_01CHILD">\nREPORT-BACK BRO-7532: landed. EFFECT: live check 5/5 on deadline.com; ledger numbers pending (RECHECK-AFTER 2026-11-18)\n</cross-session-message>';
test('peer report-back: a pending EFFECT in an inbound cross-session turn blocks a "verified" closing (the 2026-11-15 shape)', () => {
  const events = [{ kind: 'user_text', text: REPORT_BACK, synthetic: true }];
  const d = stopHookDecision({ lastMessage: CLOSE, events, env: ENV });
  assert.equal(d.decision, 'block');
  assert.match(d.reason, /another session \(session_01CHILD\)/);
});

test('peer report-back read through ReadNotifications (tool result) and an agent-message hand-back are sources too', () => {
  const [u, r] = use('ReadNotifications', {});
  const viaTool = [u, r(`--- Notification 1 of 1 ---\n${REPORT_BACK}`)];
  assert.equal(stopHookDecision({ lastMessage: CLOSE, events: viaTool, env: ENV }).decision, 'block');
  const handBack = [{ kind: 'user_text', text: 'Another Claude session sent a message:\n<agent-message from="a99b">[Subagent hand-back] EFFECT: not yet observed</agent-message>' }];
  assert.equal(stopHookDecision({ lastMessage: CLOSE, events: handBack, env: ENV }).decision, 'block');
});

test('peer report-back with a measured EFFECT allows; the owner typing "EFFECT: pending" in plain text is not a peer source', () => {
  const measured = [{ kind: 'user_text', text: REPORT_BACK.replace(/EFFECT:[^\n]*/, 'EFFECT: deadline.com paid renders 24/h before, 3/h after'), synthetic: true }];
  assert.equal(stopHookDecision({ lastMessage: CLOSE, events: measured, env: ENV }).decision, 'allow');
  const owner = [{ kind: 'user_text', text: 'Is the EFFECT: pending on BRO-7532 still true?' }];
  assert.equal(stopHookDecision({ lastMessage: CLOSE, events: owner, env: ENV }).decision, 'allow');
});

test('newest EFFECT per peer wins', () => {
  const later = REPORT_BACK.replace(/EFFECT:[^\n]*/, 'EFFECT: 24/h before, 3/h after');
  const events = [{ kind: 'user_text', text: REPORT_BACK, synthetic: true }, { kind: 'user_text', text: later, synthetic: true }];
  assert.equal(stopHookDecision({ lastMessage: CLOSE, events, env: ENV }).decision, 'allow');
});

test('BRO-7738: a SAFE TO ARCHIVE another Stop hook refused does not reset the chunk (retry still owes the spend check)', () => {
  const fb = { kind: 'user_text', text: 'Stop hook feedback:\n[command hook 2]: BLOCKED: x\n[VE:ROOTCAUSE]', synthetic: true };
  const first = 'Search chain change landed.\nSAFE TO ARCHIVE — landed';
  const retry = 'NO-ROOT-CAUSE: spot change\nSAFE TO ARCHIVE — landed';
  const events = [...edit('/repo/scripts/lib/url-discovery.js'), ...land(), text(first), fb];
  assert.equal(stopHookDecision({ lastMessage: retry, events, env: ENV }).decision, 'block');
  const accepted = [...edit('/repo/scripts/lib/url-discovery.js'), ...land(), text(first), { kind: 'user_text', text: 'ok, next thing' }];
  assert.equal(stopHookDecision({ lastMessage: retry, events: accepted, env: ENV }).decision, 'allow', 'an accepted claim still closes the chunk');
});
