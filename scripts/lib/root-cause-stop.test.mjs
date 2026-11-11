// BRO-7294: root-cause-stop.mjs, the rule-21 check at the SAFE TO ARCHIVE claim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stopHookDecision, missingRootCauseParts, blockMessage, commitSubjects, isFixSubject, cardTitles, hasRootCauseAnswer, answerTexts, blockBudget, main } from './root-cause-stop.mjs';
import { landedPushIndices } from './review-coverage.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLOUD = { CLAUDE_CODE_REMOTE: 'true' };
const toolUse = (id, name, input) => ({ kind: 'assistant_tool_use', id, name, input });
const ok = (id, content = 'ok', isError = false) => ({ kind: 'tool_result', tool_use_id: id, content, isError });
const say = (text) => ({ kind: 'assistant_text', text });
const LAND = [toolUse('p1', 'Bash', { command: 'git push origin HEAD:refs/heads/land/bro-1-fix 2>&1 | tail -3' }), ok('p1')];
const FIX_CARD = [toolUse('c1', 'Bash', { command: 'node scripts/linear-brain.js create "Fix wrong venue on 6 shows" --self --notes "x"' }), ok('c1')];
const FEATURE_CARD = [toolUse('c2', 'Bash', { command: 'node scripts/linear-brain.js create "Add a tour map page" --self' }), ok('c2')];
const SAFE = 'Fixed the six rows.\n\nSAFE TO ARCHIVE — all landed and verified.';
const d = (events, lastMessage = SAFE, env = CLOUD) => stopHookDecision({ events, lastMessage, env }).decision;

test('blocks a landed fix that claims SAFE TO ARCHIVE with no rule-21 answer (the incident)', () => {
  assert.equal(d([...FIX_CARD, ...LAND]), 'block');
  assert.equal(d([...LAND]), 'block', 'unknown card title is still checked');
});

test('passes with CLASS-GUARD, PREVENTION or NO-ROOT-CAUSE in chat', () => {
  assert.equal(d([...FIX_CARD, ...LAND], 'Done.\nCLASS-GUARD: scripts/lib/venue-guard.test.mjs\nCOUSINS: grepped data/ and scripts/, none\n\nSAFE TO ARCHIVE — x'), 'allow');
  assert.equal(d([...FIX_CARD, ...LAND, say('**PREVENTION:** scripts/lib/x.test.mjs ; cousins: grep of data/')]), 'allow');
  assert.equal(d([...FIX_CARD, ...LAND], 'NO-ROOT-CAUSE: one-off typo in a hand-entered row ; cousins: grepped data/ and scripts/, none\nSAFE TO ARCHIVE — x'), 'allow');
  assert.equal(d([...FIX_CARD, ...LAND], 'NO-PREVENTION: docs-only change to CLOUD.md ; cousins: grepped data/ and scripts/, none\nSAFE TO ARCHIVE — x'), 'allow');
});

test('passes when the answer is in the Linear Outcome comment, not the chat', () => {
  const viaCli = toolUse('l1', 'Bash', { command: "node scripts/linear-brain.js update BRO-1 --state Done --comment \"$(cat <<'EOF'\nOutcome.\nROOT-CAUSE: importer trusted URL slugs\nCLASS-GUARD: scripts/lib/import-guard.test.mjs\nCOUSINS: grepped the other importers, none\nEOF\n)\"" });
  assert.equal(d([...FIX_CARD, ...LAND, viaCli, ok('l1')]), 'allow');
  const inline = toolUse('l4', 'Bash', { command: 'node scripts/linear-brain.js update BRO-1 --comment "CLASS-GUARD: scripts/lib/inline.test.mjs ; cousins: grepped data/, none" --state Done' });
  assert.equal(d([...FIX_CARD, ...LAND, inline, ok('l4')]), 'allow', 'an inline single-line --comment counts');
  const report = toolUse('l5', 'Bash', { command: "node scripts/linear-session.js report --status=done --summary='NO-ROOT-CAUSE: one manual row typo fixed ; cousins: grepped data/ and scripts/, none'" });
  assert.equal(d([...FIX_CARD, ...LAND, report, ok('l5')]), 'allow');
  const viaMcp = toolUse('l2', 'mcp__Linear__save_comment', { issueId: 'BRO-1', body: 'Outcome\n- CLASS-GUARD: scripts/lib/a.test.mjs\n- COUSINS: grepped data/, none' });
  assert.equal(d([...FIX_CARD, ...LAND, viaMcp, ok('l2')]), 'allow');
  const viaUuid = toolUse('l3', 'mcp__0a1b2c3d-1111-2222-3333-444455556666__save_comment', { body: 'NO-ROOT-CAUSE: single bad row from a manual edit ; cousins: grepped data/ and scripts/, none' });
  assert.equal(d([...FIX_CARD, ...LAND, viaUuid, ok('l3')]), 'allow');
});

test('too-short or empty answers do not count', () => {
  assert.equal(d([...FIX_CARD, ...LAND], 'NO-ROOT-CAUSE: n/a\nSAFE TO ARCHIVE — x'), 'block');
  assert.equal(d([...FIX_CARD, ...LAND], 'CLASS-GUARD:\nSAFE TO ARCHIVE — x'), 'block');
  assert.equal(d([...FIX_CARD, ...LAND, say('ROOT-CAUSE: the importer trusted slugs')]), 'block', 'a cause with no guard is the spot-patch failure');
});

test('stays quiet when nothing landed, on feature cards, off cloud, with the kill switch, or without the claim', () => {
  assert.equal(d([...FIX_CARD]), 'allow');
  assert.equal(d([...FEATURE_CARD, ...LAND]), 'allow');
  assert.equal(d([...FEATURE_CARD, ...FIX_CARD, ...LAND]), 'block', 'any fix card in the session is checked');
  const parked = toolUse('c3', 'Bash', { command: 'node scripts/linear-brain.js create "Search broken on mobile" --park "found in passing"' });
  assert.equal(d([...FEATURE_CARD, parked, ok('c3'), ...LAND]), 'allow', 'a bug filed for someone else does not make a feature session a fix');
  assert.equal(d([...FIX_CARD, ...LAND], SAFE, {}), 'allow');
  assert.equal(d([...FIX_CARD, ...LAND], SAFE, { ...CLOUD, ROOT_CAUSE_STOP_DISABLE: '1' }), 'allow');
  assert.equal(d([...FIX_CARD, ...LAND], 'Waiting on CI.\n\nKEEP OPEN — land run in progress'), 'allow');
  assert.equal(d([...FIX_CARD, ...LAND], 'SAFE TO ARCHIVE is what I will say later.\n\nKEEP OPEN — x'), 'allow');
  assert.equal(d(null), 'allow');
});

test('only real landings count: refused, dry-run and delete pushes do not; MCP landings do', () => {
  const ev = (cmd, isError = false) => [toolUse('x', 'Bash', { command: cmd }), ok('x', 'r', isError)];
  assert.deepEqual(landedPushIndices(ev('git push origin HEAD:land/x')), [0]);
  assert.deepEqual(landedPushIndices(ev('git -C /w push origin HEAD:refs/heads/land/x')), [0]);
  assert.deepEqual(landedPushIndices(ev('git push origin HEAD:refs/heads/land/x', true)), [], 'a hook-refused push');
  assert.deepEqual(landedPushIndices(ev('git push --dry-run origin HEAD:land/x')), []);
  assert.deepEqual(landedPushIndices(ev('git push origin --delete land/x')), []);
  assert.deepEqual(landedPushIndices(ev('git push origin claude/foo')), []);
  assert.deepEqual(landedPushIndices([toolUse('m', 'mcp__github__create_branch', { branch: 'land/y' }), ok('m')]), [0]);
  assert.deepEqual(landedPushIndices([toolUse('m', 'mcp__github__actions_run_trigger', { workflow_id: 'land.yml' }), ok('m')]), [0]);
  assert.deepEqual(landedPushIndices([toolUse('m', 'mcp__github__create_branch', { branch: 'claude/y' }), ok('m')]), []);
  assert.deepEqual(landedPushIndices([toolUse('x', 'Bash', { command: 'git push origin HEAD:refs/heads/land/x 2>&1 | tail -5' }), ok('x', ' ! [rejected]        HEAD -> land/x (fetch first)\nerror: failed to push some refs')]), [], 'a piped push git refused');
  assert.deepEqual(landedPushIndices([toolUse('m', 'mcp__github__actions_run_trigger', { workflow_id: 'land-ref-prune.yml' }), ok('m')]), [], 'land-* helper workflows are not landings');
  assert.deepEqual(landedPushIndices([toolUse('m', 'mcp__github__actions_run_trigger', { workflow_id: 'visual-approval-land.yml' }), ok('m')]), []);
  assert.deepEqual(landedPushIndices(ev('gh workflow run land.yml -f branch=land/x')), [0]);
  assert.deepEqual(landedPushIndices(ev('node scripts/cloud-dispatch.js land.yml --ref main')), [0]);
  assert.deepEqual(landedPushIndices([toolUse('m', 'mcp__github__push_files', { branch: 'land/z', files: [] }), ok('m')]), [0]);
});

test('helpers: titles from CLI and connector creates; answer texts include Linear writes', () => {
  assert.deepEqual(cardTitles([...FIX_CARD, toolUse('s', 'mcp__Linear__save_issue', { title: 'Fix X', team: 'BRO' }), toolUse('u', 'mcp__Linear__save_issue', { id: 'BRO-2', title: 'edit' })]), ['Fix wrong venue on 6 shows', 'Fix X']);
  assert.equal(answerTexts([toolUse('b', 'Bash', { command: 'ls' })], 'm').length, 1);
  assert.equal(hasRootCauseAnswer(['PREVENTION: scripts/lib/q.test.mjs ; cousins: grepped data/, none']), true);
  assert.equal(blockBudget(new Date('2026-11-10T00:00:00Z')), 1);
  assert.equal(blockBudget(new Date('2026-12-22T00:00:00Z')), 2);
});

test('main(): blocks within its budget, then lets go', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcs-'));
  const tp = path.join(dir, 't.jsonl');
  const row = (type, content) => JSON.stringify({ type, message: { content } }) + '\n';
  fs.writeFileSync(tp, row('assistant', [{ type: 'tool_use', name: 'Bash', id: 'p', input: { command: 'git push origin HEAD:refs/heads/land/z' } }]) + row('user', [{ type: 'tool_result', tool_use_id: 'p', content: 'ok' }]));
  const run = (now) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/lib/root-cause-stop.mjs'), '--stop-hook'], {
    input: JSON.stringify({ transcript_path: tp, session_id: 't', last_assistant_message: SAFE }),
    encoding: 'utf8', env: { ...process.env, ...CLOUD, ROOT_CAUSE_STOP_DISABLE: '' },
  });
  const a = run();
  assert.equal(a.status, 2);
  assert.match(a.stderr, /BRO-7294/);
  assert.equal(run().status, 0, 'one reminder before the arming date, then it lets go');
  assert.equal(main(['--other']), 0);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const f of fs.readdirSync(os.tmpdir())) if (f.startsWith('root-cause-stop-')) fs.rmSync(path.join(os.tmpdir(), f), { force: true });
});

test('verify-edits.sh keeps the root-cause-stop call (a Mac-master sync must not silently drop it)', () => {
  const src = fs.readFileSync(path.join(ROOT, '.claude', 'hooks', 'verify-edits.sh'), 'utf8');
  assert.match(src, /root-cause-stop\.mjs" --stop-hook/);
  assert.match(src, /ROOT_CAUSE_STOP_DISABLE/);
});

// BRO-7301: a symptom-titled card (no FIX_RE word) with fix commits must still be checked.
const SYMPTOM_CARD = [toolUse('c9', 'Bash', { command: "node scripts/linear-brain.js create \"Opening grade: SERP census counts other cities' productions of classic titles\" --self" }), ok('c9')];
const commit = (id, cmd) => [toolUse(id, 'Bash', { command: cmd }), ok(id)];

test('BRO-7301: symptom-titled card + landed fix(...) commit + bare SAFE TO ARCHIVE blocks; feat commit allows', () => {
  const fixC = commit('g1', 'git commit -m "fix(opening-grade): scope SERP census to the show city"');
  const featC = commit('g2', 'git commit -m "feat: add a tour map page"');
  assert.equal(d([...SYMPTOM_CARD, ...fixC, ...LAND]), 'block');
  assert.equal(stopHookDecision({ events: [...SYMPTOM_CARD, ...fixC, ...LAND], lastMessage: SAFE, env: CLOUD }).reason, 'fix commit: fix(opening-grade): scope SERP census to the show city; missing: CLASS-GUARD or NO-ROOT-CAUSE + COUSINS');
  assert.equal(d([...SYMPTOM_CARD, ...featC, ...LAND]), 'allow');
  assert.equal(d([...SYMPTOM_CARD, ...LAND]), 'allow', 'no commits seen, symptom title alone stays quiet (old behavior)');
  assert.equal(d([...SYMPTOM_CARD, ...fixC, ...LAND], 'CLASS-GUARD: scripts/lib/census.test.mjs\nCOUSINS: grepped other shows, none\nSAFE TO ARCHIVE — x'), 'allow', 'a stated answer still passes');
});

test('BRO-7301: subject classification follows the conventional type, untyped goes to FIX_RE', () => {
  assert.equal(isFixSubject('fix: wrong venue'), true);
  assert.equal(isFixSubject('Fix(scope)!: wrong venue'), true);
  assert.equal(isFixSubject('feat: add retry when push fails'), false, 'a fix word inside a feat subject');
  assert.equal(isFixSubject('chore: fix typo'), false);
  assert.equal(isFixSubject('data: Auto-fix 19 URL collisions'), false);
  assert.equal(isFixSubject('Fix wrong venue on 6 shows'), true, 'untyped subject reads through FIX_RE');
  assert.equal(isFixSubject('Add a tour map page'), false);
  assert.equal(isFixSubject(''), false);
});

test('BRO-7301: commit parsing covers -am, --message=, heredoc, multi -m, MCP; scopes to landed, this repo, successful', () => {
  const subj = (...evs) => commitSubjects([...evs.flat(), ...LAND]);
  assert.deepEqual(subj(commit('a', 'git commit -am "fix: one"')), ['fix: one']);
  assert.deepEqual(subj(commit('a', "git commit --message='fix: two'")), ['fix: two']);
  assert.deepEqual(subj(commit('a', 'git commit -m "fix: first" -m "body second"')), ['fix: first']);
  assert.deepEqual(subj(commit('a', 'git commit -m "fix: say \\"hi\\" ok"')), ['fix: say "hi" ok']);
  assert.deepEqual(subj(commit('a', "git add -A && git commit -m \"$(cat <<'EOF'\nfix(x): heredoc subject\n\nbody\nEOF\n)\"")), ['fix(x): heredoc subject']);
  assert.deepEqual(subj([toolUse('m', 'mcp__github__push_files', { branch: 'land/z', message: 'fix: via mcp\n\nbody', files: [] }), ok('m')]), ['fix: via mcp']);
  assert.deepEqual(subj(commit('a', 'cd ~/BroadwayScorecard-app && git commit -m "fix: ios"')), [], 'other repo');
  assert.deepEqual(subj([toolUse('a', 'Bash', { command: 'git commit -m "fix: refused"' }), ok('a', 'hook refused', true)]), [], 'failed commit');
  assert.deepEqual(commitSubjects([...commit('a', 'git commit -m "fix: before"'), ...LAND, ...commit('b', 'git commit -m "fix: after landing"')]), ['fix: before'], 'a commit after the last landing never landed');
  assert.deepEqual(commitSubjects(commit('a', 'git commit -m "fix: not pushed"')), [], 'nothing landed');
});

test('BRO-7301 review fixes: follow-up subjects, unknown prefixes, heredoc/echo mentions, chained -m', () => {
  assert.equal(isFixSubject('Ship-check fixes: purge only on id rejection of the stored url'), false, 'review-round fixup in a feature session');
  assert.equal(isFixSubject('Revert "fix: thing"'), false);
  assert.equal(isFixSubject('Census: wrong city counted'), true, 'unknown Word: prefix is symptom wording, goes to FIX_RE');
  assert.equal(isFixSubject('WIP: fixing broken test'), true);
  assert.equal(isFixSubject('docs: wrong path in README'), false, 'known non-fix type wins');
  const subj = (...evs) => commitSubjects([...evs.flat(), ...LAND]);
  assert.deepEqual(subj(commit('a', "cat > notes.md <<'EOF'\nrun git commit -m \"fix: inside heredoc body\"\nEOF")), [], 'heredoc body that mentions a commit');
  assert.deepEqual(subj(commit('a', "echo \"git commit -m 'fix: echoed'\"")), [], 'echoed text');
  assert.deepEqual(subj(commit('a', 'git commit --amend --no-edit && git tag -a v1 -m "fix: tag message"')), [], 'a later command -m is not the commit message');
  assert.deepEqual(subj(commit('a', 'git add -A && git commit -m "feat: a; b & c" && git push origin x')), ['feat: a; b & c'], 'quoted separators stay in the subject');
  assert.deepEqual(subj(commit('a', 'git commit -m"fix: no space"')), ['fix: no space']);
  assert.deepEqual(subj(commit('a', "linear-brain.js update BRO-1 --comment \"$(cat <<'EOF'\ngit commit -m 'fix: quoted in a comment'\nEOF\n)\"")), []);
  const ship = commit('g3', 'git commit -m "Ship-check fixes: wrong sort order"');
  assert.equal(d([...SYMPTOM_CARD, ...ship, ...LAND]), 'allow', 'a ship-check fixup commit does not turn a feature session into a fix session');
  const untyped = commit('g4', 'git commit -m "Census counts the wrong city"');
  assert.equal(d([...SYMPTOM_CARD, ...untyped, ...LAND]), 'block', 'untyped fix-reading subject through stopHookDecision');
});

test('BRO-7316: a root-cause statement alone is not enough, COUSINS is required too', () => {
  const g = 'CLASS-GUARD: scripts/lib/venue-guard.test.mjs';
  const r = (msg) => stopHookDecision({ events: [...FIX_CARD, ...LAND], lastMessage: `${msg}\nSAFE TO ARCHIVE — x`, env: CLOUD });
  assert.equal(r(g).decision, 'block', 'CLASS-GUARD without COUSINS blocks');
  assert.match(r(g).reason, /missing: COUSINS$/);
  assert.equal(r(`${g}\nCOUSINS: grepped data/ and src/ for the same venue bug, fixed 2`).decision, 'allow');
  assert.equal(r('NO-ROOT-CAUSE: one-off typo in a hand-entered row').decision, 'block', 'a spot fix needs COUSINS too');
  assert.equal(r('NO-ROOT-CAUSE: one-off typo in a hand-entered row ; cousins: grepped shows.json, none').decision, 'allow');
  assert.equal(r('NO-PREVENTION: docs-only change to CLOUD.md').decision, 'block');
  assert.equal(r('PREVENTION: scripts/lib/x.test.mjs ; cousins: grepped data/, none').decision, 'allow', 'PREVENTION with a cousins tail');
  assert.equal(r('COUSINS: grepped data/ and scripts/, none').decision, 'block', 'COUSINS without a root-cause line blocks');
  assert.equal(r(`${g}\nCOUSINS: none`).decision, 'block', 'a bare "none" names no search');
  assert.deepEqual(missingRootCauseParts([]), ['CLASS-GUARD or NO-ROOT-CAUSE', 'COUSINS']);
  assert.match(blockMessage(['COUSINS']), /Missing: COUSINS\./);
});

test('BRO-7316: CLASS-GUARD in a Linear comment and COUSINS in chat combine', () => {
  const cmt = toolUse('l9', 'mcp__Linear__save_comment', { body: 'CLASS-GUARD: scripts/lib/a.test.mjs' });
  assert.equal(d([...FIX_CARD, ...LAND, cmt, ok('l9')], 'COUSINS: grepped all shows for the same field, fixed 3\nSAFE TO ARCHIVE — x'), 'allow');
  assert.equal(d([...FIX_CARD, ...LAND, cmt, ok('l9')]), 'block');
});

test('BRO-7316 ship-check: every line counts, templates and "not searched" do not', () => {
  const full = 'NO-ROOT-CAUSE: one-off typo in row ; cousins: grepped data/ and scripts/, none';
  assert.deepEqual(missingRootCauseParts([full, 'NO-ROOT-CAUSE: one-off typo in row']), [], 'a short repeat does not erase the full answer');
  assert.deepEqual(missingRootCauseParts(['COUSINS: grepped data/ and src/, fixed 2\nCLASS-GUARD: scripts/lib/a.test.mjs\nCOUSINS: none']), [], 'a later COUSINS: none keeps the earlier real one');
  assert.deepEqual(missingRootCauseParts(['NO-PREVENTION: docs only change\nNO-PREVENTION: docs only ; cousins: grepped docs, none']), []);
  assert.deepEqual(missingRootCauseParts(['CLASS-GUARD: <path of the test, check or guard>\nCOUSINS: <where you searched for the same defect>']), ['CLASS-GUARD or NO-ROOT-CAUSE', 'COUSINS'], 'echoed template');
  assert.deepEqual(missingRootCauseParts(['CLASS-GUARD: scripts/lib/a.test.mjs\nCOUSINS: not searched yet, TODO']), ['COUSINS']);
  assert.deepEqual(missingRootCauseParts(['**CLASS-GUARD:** scripts/lib/a.test.mjs\n- **Cousins:** grepped data/ and src/, none']), []);
});

// BRO-7349: the answer is per chunk of work between accepted SAFE TO ARCHIVE claims, not per session.
const ANSWER = say('CLASS-GUARD: scripts/lib/venue-guard.test.mjs\nCOUSINS: grepped data/ and scripts/, none');
const commitLand = (n, subject) => [toolUse(`k${n}`, 'Bash', { command: `git commit -qm "${subject}"` }), ok(`k${n}`), toolUse(`q${n}`, 'Bash', { command: `git push origin HEAD:refs/heads/land/x${n}` }), ok(`q${n}`)];
const FIRST = [...FIX_CARD, ...commitLand(1, 'fix: wrong venue on 6 shows'), ANSWER, say(SAFE)];
const feedback = (t = 'Stop hook feedback:\n[command hook 1]: BLOCKED: something') => ({ kind: 'user_text', text: t, synthetic: true });

test('BRO-7349: a second landed fix after an accepted claim needs its own answer', () => {
  assert.equal(d(FIRST), 'allow', 'first chunk answered');
  assert.equal(d([...FIRST, ...commitLand(2, 'fix: stale grosses on tour pages')]), 'block', 'the early answer no longer covers a later fix');
  assert.equal(d([...FIRST, ...commitLand(2, 'fix: stale grosses on tour pages'), say(SAFE)]), 'block', 'the current claim, flushed to the transcript, is not a boundary');
  assert.equal(d([...FIRST, ...commitLand(2, 'fix: stale grosses on tour pages'), ANSWER]), 'allow', 'a new answer after the claim covers it');
});

test('BRO-7349: a later chunk with no new fix stays quiet', () => {
  assert.equal(d([...FIRST, ...commitLand(2, 'data: session cost row')]), 'allow');
  assert.equal(d([...FIRST, ...commitLand(2, 'Ship-check fixes: tidy names')]), 'allow');
  const newCard = [toolUse('c9', 'Bash', { command: 'node scripts/linear-brain.js create "Fix broken search on mobile" --self' }), ok('c9')];
  assert.equal(d([...FIRST, ...newCard, ...commitLand(2, 'search: guard empty query')]), 'block', 'a new fix card in the chunk is a witness');
  assert.equal(d([...FIRST, ...commitLand(2, 'feat: tour map page')]), 'allow');
});

test('BRO-7349: a claim this check would block is not a boundary; one another hook refused is', () => {
  const unanswered = [...FIX_CARD, ...commitLand(1, 'fix: wrong venue on 6 shows'), say(SAFE), feedback()];
  assert.equal(d([...unanswered, ...commitLand(2, 'Ship-check fixes: names')]), 'block', 'fix A is still unanswered after a follow-up landing');
  assert.equal(d([...unanswered, ...commitLand(2, 'Ship-check fixes: names'), ANSWER]), 'allow');
  const answered = [...FIX_CARD, ...commitLand(1, 'fix: wrong venue on 6 shows'), ANSWER, say(SAFE), feedback('Stop hook feedback:\n[command hook 2]: There are 3 unpushed commit(s)')];
  assert.equal(d([...answered, ...commitLand(2, 'Ship-check fixes: names')]), 'allow', 'an answered claim refused by another hook is still a boundary');
  assert.equal(d([...answered, ...commitLand(2, 'fix: stale grosses')]), 'block', 'so the next fix after it needs its own answer');
});

test('BRO-7349: chunkStart and ranged commitSubjects', async () => {
  const { chunkStart } = await import('./root-cause-stop.mjs');
  const ev = [...FIRST, ...commitLand(2, 'fix: stale grosses on tour pages')];
  const c = chunkStart(ev);
  assert.equal(ev[c.claimIdx].text, SAFE);
  assert.deepEqual(commitSubjects(ev, { from: c.landedFrom, to: c.lastLanding }), ['fix: stale grosses on tour pages']);
  assert.deepEqual(commitSubjects(ev), ['fix: wrong venue on 6 shows', 'fix: stale grosses on tour pages'], 'default range unchanged');
  assert.equal(chunkStart([...FIX_CARD]).claimIdx, -1);
});

test('BRO-7349: main() gives each chunk its own block budget', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcs-'));
  const tp = path.join(dir, 't.jsonl');
  const row = (type, content, uuid) => JSON.stringify({ type, uuid, message: { content } }) + '\n';
  const landRows = (n, subj) => row('assistant', [{ type: 'tool_use', name: 'Bash', id: `k${n}`, input: { command: `git commit -qm "${subj}"` } }]) + row('user', [{ type: 'tool_result', tool_use_id: `k${n}`, content: 'ok' }])
    + row('assistant', [{ type: 'tool_use', name: 'Bash', id: `p${n}`, input: { command: `git push origin HEAD:refs/heads/land/z${n}` } }]) + row('user', [{ type: 'tool_result', tool_use_id: `p${n}`, content: 'ok' }]);
  const run = () => spawnSync(process.execPath, [path.join(ROOT, 'scripts/lib/root-cause-stop.mjs'), '--stop-hook'], {
    input: JSON.stringify({ transcript_path: tp, session_id: 't', last_assistant_message: SAFE }),
    encoding: 'utf8', env: { ...process.env, ...CLOUD, ROOT_CAUSE_STOP_DISABLE: '' },
  });
  fs.writeFileSync(tp, landRows(1, 'fix: a'));
  assert.equal(run().status, 2);
  assert.equal(run().status, 0, 'chunk 1 budget spent');
  fs.appendFileSync(tp, row('assistant', [{ type: 'text', text: 'CLASS-GUARD: scripts/lib/a.test.mjs\nCOUSINS: grepped data/, none\n\n' + SAFE }], 'claim-1') + landRows(2, 'fix: b'));
  const b = run();
  assert.equal(b.status, 2, 'a new fix after an accepted claim gets its own reminder');
  assert.match(b.stderr, /BRO-7316/);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const f of fs.readdirSync(os.tmpdir())) if (f.startsWith('root-cause-stop-')) fs.rmSync(path.join(os.tmpdir(), f), { force: true });
});

test('BRO-7349: a land push mentioned in a heredoc, a node -e test or a sed expression is not a landing', () => {
  const ev = (cmd) => [toolUse('x', 'Bash', { command: cmd }), ok('x')];
  assert.deepEqual(landedPushIndices(ev("cat >> t.test.mjs <<'EOF'\nconst LAND = 'git push origin HEAD:refs/heads/land/x';\nEOF")), []);
  assert.deepEqual(landedPushIndices(ev(`node -e 'run("git push origin HEAD:refs/heads/land/x")'`)), []);
  assert.deepEqual(landedPushIndices(ev(`sed -i "s/gh workflow run land.yml -f ref=x/gh workflow run land.yml -f branch=x/" t.mjs`)), []);
  assert.deepEqual(landedPushIndices(ev('git push origin "HEAD:refs/heads/land/x" 2>&1 | tail -2')), [0], 'a quoted refspec still lands');
  assert.deepEqual(landedPushIndices(ev("git commit -qm 'fix: a thing' && git push origin HEAD:refs/heads/land/x")), [0], 'a quoted commit message before a real push');
});

test('BRO-7349: a Linear close-out mentioned inside a heredoc or a quoted script is not an answer', () => {
  const fixture = toolUse('w1', 'Bash', { command: "cat >> t.test.mjs <<'EOF'\nconst c = 'node scripts/linear-brain.js update BRO-1 --comment \"CLASS-GUARD: scripts/lib/x.test.mjs ; cousins: grepped data/, none\"';\nEOF" });
  assert.equal(d([...FIX_CARD, ...LAND, fixture, ok('w1')]), 'block');
  const nodeE = toolUse('w2', 'Bash', { command: `node -e 'run("node scripts/linear-brain.js update BRO-1 --comment CLASS-GUARD: scripts/lib/x.test.mjs ; cousins: grepped data/, none")'` });
  assert.equal(d([...FIX_CARD, ...LAND, nodeE, ok('w2')]), 'block');
});
