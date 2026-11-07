// scripts/tests/verify-edits-scoring-gate.test.mjs
//
// BRO-5270: the scoring-delta Stop gate in .claude/hooks/verify-edits.sh.
// Before this, the gate (a) watched 5 of the ~20 files scoring-delta.js
// replays, and (b) judged a run by scraping its output for failure markers,
// so `scoring-delta.js | tail`, `--json`, `2>/dev/null`, a later
// test-temporal-override-regression run or a bare `grep scoring-delta`
// all passed a session whose real run exited 2. Now scoring-delta.js stamps
// its exit code (scripts/lib/scoring-watchlists.js) and the hook reads it.
//
// Pattern follows verify-edits-cloud-session-gates.test.mjs: pipe a real Stop
// payload into the REAL repo hook and read its exit code (0 allowed, 2 BLOCKED).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSyncStdinFile } from '../../tests/helpers/spawn-stdin-file.mjs';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');
const HOOK = path.join(REPO_ROOT, '.claude', 'hooks', 'verify-edits.sh');
const watch = require('../lib/scoring-watchlists.js');
const delta = require('../scoring-delta.js');

const DIRS = [];
after(() => {
  for (const d of DIRS) {
    const t = path.join(d, 'transcript', `${path.basename(d)}.jsonl`);
    fs.rmSync(`/tmp/verify-edits-chain-${execSync(`printf '%s' '${t}' | cksum`).toString().split(' ')[0]}`, { force: true });
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// stampFile()/readStamps() resolve the stamp dir from the env at call time.
function inStampDir(dir, fn) {
  const saved = process.env.SCORING_DELTA_STAMP_DIR;
  process.env.SCORING_DELTA_STAMP_DIR = dir;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.SCORING_DELTA_STAMP_DIR; else process.env.SCORING_DELTA_STAMP_DIR = saved;
  }
}

const ago = (s) => new Date(Date.now() - s * 1000).toISOString();
const edit = (rel) => ({ name: 'Edit', input: { file_path: `/work/repo/${rel}`, old_string: 'a', new_string: 'b' } });
const bash = (command, result = 'ok', isError = false) => ({ name: 'Bash', input: { command }, result, isError });
const SHIP_CHECK = { name: 'Skill', input: { skill: 'ship-check' } };

// One fixture = a session id, a transcript of tool calls (each result stamped
// `ts`), and the stamps scoring-delta.js would have appended for it.
function fixture(calls, stamps = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 've-scoring-'));
  DIRS.push(dir);
  const sid = path.basename(dir);
  const stampDir = path.join(dir, 'stamps');
  fs.mkdirSync(stampDir);
  inStampDir(stampDir, () => { for (const s of stamps) fs.appendFileSync(watch.stampFile(sid), JSON.stringify(s) + '\n'); });
  const lines = [JSON.stringify({ type: 'user', timestamp: ago(600), message: { role: 'user', content: [{ type: 'text', text: 'do the work' }] } })];
  for (const c of calls) {
    const id = `tu-${randomUUID()}`;
    lines.push(JSON.stringify({ type: 'assistant', timestamp: c.ts, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: c.name, input: c.input }] } }));
    lines.push(JSON.stringify({ type: 'user', timestamp: c.ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: c.result ?? 'ok', ...(c.isError ? { is_error: true } : {}) }] } }));
  }
  fs.mkdirSync(path.join(dir, 'transcript'));
  const transcript = path.join(dir, 'transcript', `${sid}.jsonl`);
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
  return { transcript, stampDir, sid };
}

function runHook({ transcript, stampDir, corpus, missingRegexGate }, lastMsg = 'Done.') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 've-scoring-home-'));
  try {
    let hook = HOOK;
    if (corpus !== undefined) {
      const root = path.join(home, 'repo');
      for (const rel of ['.claude/hooks/verify-edits.sh', 'scripts/lib/scoring-watchlists.js', 'scripts/lib/regex-audit-gate.js']) {
        if (missingRegexGate && rel.endsWith('/regex-audit-gate.js')) continue;
        const src = path.join(REPO_ROOT, rel);
        if (!fs.existsSync(src)) continue;
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.copyFileSync(src, path.join(root, rel));
      }
      if (corpus) fs.mkdirSync(path.join(root, 'data/review-texts'), { recursive: true });
      hook = path.join(root, '.claude/hooks/verify-edits.sh');
    }
    const r = spawnSyncStdinFile('bash', [hook], {
      input: JSON.stringify({ transcript_path: transcript, session_id: 'x', stop_hook_active: false, last_assistant_message: lastMsg }),
      encoding: 'utf8',
      env: { ...process.env, HOME: home, SCORING_DELTA_STAMP_DIR: stampDir, BOARD_GATE_DISABLED: '1',
        SESSION_STATUS_GATE_DISABLE: '1', CLOUD_CHAIN_GATE_DISABLE: '1', VISUAL_QA_DISABLE: '1' },
      timeout: 20_000,
    });
    return { status: r.status, stderr: r.stderr || '' };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const blocked = (r, re, msg) => {
  assert.equal(r.status, 2, `${msg}: expected BLOCKED, got ${r.status}. stderr: ${r.stderr.slice(0, 400)}`);
  if (re) assert.match(r.stderr, re, msg);
};
const allowed = (r, msg) => assert.equal(r.status, 0, `${msg}: expected allowed, got ${r.status}. stderr: ${r.stderr.slice(0, 400)}`);

const TQ = 'scripts/lib/text-quality.js';
const RG = 'scripts/lib/review-guards.js';
const stamp = (s, exitCode, changed, extra = {}) => ({ ts: ago(s), exitCode, base: 'HEAD', changed, dataFlagChanges: 0, ...extra });

test('acceptance: text-quality.js edit + scoring-delta exit 2 is blocked with the §13 A/B instruction', () => {
  const f = fixture([{ ...edit(TQ), ts: ago(300) }, { ...bash('node scripts/scoring-delta.js | tail -3'), ts: ago(200) }, { ...SHIP_CHECK, ts: ago(100) }],
    [stamp(200, 2, [TQ])]);
  blocked(runHook(f), /§13 A\/B/, 'piped exit-2 run');
});

test('acceptance: a later test-temporal-override-regression run does not wash out the exit 2', () => {
  const f = fixture([{ ...edit(TQ), ts: ago(300) }, { ...bash('node scripts/scoring-delta.js --json'), ts: ago(200) },
    { ...bash('node scripts/test-temporal-override-regression.js', 'PASS'), ts: ago(150) }, { ...SHIP_CHECK, ts: ago(100) }],
  [stamp(200, 2, [TQ])]);
  blocked(runHook(f), /§13 A\/B/, 'exit 2 then temporal-override');
});

test('grep scoring-delta / no run at all is blocked', () => {
  const f = fixture([{ ...edit('scripts/lib/score-routing.js'), ts: ago(300) }, { ...bash('grep -n scoring-delta CLAUDE.md'), ts: ago(200) }, { ...SHIP_CHECK, ts: ago(100) }]);
  blocked(runHook(f), /without a counterfactual/, 'grep only');
});

test('a clean exit-0 run that measured the edited file passes', () => {
  const f = fixture([{ ...edit(RG), ts: ago(300) }, { ...bash('node scripts/scoring-delta.js 2>&1 | tail -5'), ts: ago(200) }, { ...SHIP_CHECK, ts: ago(100) }],
    [stamp(200, 0, [RG])]);
  allowed(runHook(f), 'clean run');
});

test('a run from before the edit does not count', () => {
  const f = fixture([{ ...edit(RG), ts: ago(100) }, { ...SHIP_CHECK, ts: ago(50) }], [stamp(200, 0, [RG])]);
  blocked(runHook(f), /without a counterfactual/, 'stale stamp');
});

test('exit 0 that did not see the file (--base=HEAD after commit) is blocked as unmeasured', () => {
  const f = fixture([{ ...edit(RG), ts: ago(300) }, { ...SHIP_CHECK, ts: ago(100) }], [stamp(200, 0, [])]);
  blocked(runHook(f), /--base=origin\/main/, 'nothing to check');
});

test('the latest run decides: exit 1 (missing data) then a clean re-run passes', () => {
  const f = fixture([{ ...edit(RG), ts: ago(300) }, { ...SHIP_CHECK, ts: ago(100) }], [stamp(250, 1, []), stamp(200, 0, [RG])]);
  allowed(runHook(f), 'exit 1 then exit 0');
  const g = fixture([{ ...edit(RG), ts: ago(300) }, { ...SHIP_CHECK, ts: ago(100) }], [stamp(200, 1, [])]);
  blocked(runHook(g), /errored/, 'exit 1 alone');
});

test('an earlier watched edit is still gated after a later unrelated edit', () => {
  const f = fixture([{ ...edit(TQ), ts: ago(300) }, { ...edit('scripts/some-other.js'), ts: ago(250) },
    { ...bash('node scripts/some-other.js'), ts: ago(200) }, { ...SHIP_CHECK, ts: ago(100) }]);
  blocked(runHook(f), /text-quality\.js/, 'earlier watched edit');
});

test('a scoring pass no longer skips the later gates: an unverified later edit still blocks', () => {
  const f = fixture([{ ...edit(RG), ts: ago(300) }, { ...edit('scripts/other-tool.js'), ts: ago(250) }, { ...SHIP_CHECK, ts: ago(100) }],
    [stamp(200, 0, [RG])]);
  blocked(runHook(f), /unverified edit to `other-tool\.js`/, 'later unverified edit');
});

test('a run that started before the edit landed does not count, even if it exited after', () => {
  const f = fixture([{ ...edit(RG), ts: ago(300) }, { ...SHIP_CHECK, ts: ago(100) }], [stamp(200, 0, [RG], { started: ago(350) })]);
  blocked(runHook(f), /without a counterfactual/, 'overlapping run');
});

test('an edit with no transcript timestamp fails closed (no run can be shown to follow it)', () => {
  const f = fixture([{ ...edit(RG) }, { ...SHIP_CHECK, ts: ago(100) }], [stamp(200, 0, [RG])]);
  blocked(runHook(f), /without a counterfactual/, 'no edit timestamp');
});

test('exit 2 names the §13 A/B whenever the run saw an LLM-input file, whichever watched file was edited last', () => {
  const f = fixture([{ ...edit(RG), ts: ago(300) }, { ...SHIP_CHECK, ts: ago(100) }], [stamp(200, 2, [RG, TQ])]);
  blocked(runHook(f), /§13 A\/B/, 'review-guards edit with LLM input in the diff');
  const g = fixture([{ ...edit(RG), ts: ago(300) }, { ...SHIP_CHECK, ts: ago(100) }], [stamp(200, 2, [RG])]);
  blocked(runHook(g), /significant delta/, 'plain exit 2');
});

test('NO-VERIFY in the current turn still waives the gate', () => {
  const f = fixture([{ ...edit(TQ), ts: ago(300) }, { ...SHIP_CHECK, ts: ago(100) }], [stamp(200, 2, [TQ])]);
  allowed(runHook(f, 'NO-VERIFY: A/B re-score of 120 reviews, bucket shift 1.2%, mean drift 0.4.'), 'NO-VERIFY');
});

test('drift: the hook gates every file scoring-delta.js watches', () => {
  const all = [...new Set([...delta.INCLUSION_FILES, ...delta.SCORE_VALUE_FILES, ...delta.LLM_INPUT_FILES])];
  assert.deepEqual([...new Set([...watch.INCLUSION_FILES, ...watch.SCORE_VALUE_FILES])].sort(), all.sort(), 'scoring-delta.js re-exports the shared lists');
  assert.ok(all.length >= 20, `watchlist shrank to ${all.length}`);
  for (const rel of all) {
    const f = fixture([{ ...edit(rel), ts: ago(300) }, { ...bash(`node --check ${rel}`), ts: ago(200) }, { ...SHIP_CHECK, ts: ago(100) }]);
    blocked(runHook(f), rel === 'scripts/lib/content-quality.js' ? /audit-regex-patterns/ : /scoring|counterfactual/, `edit to ${rel}`);
  }
});

test('scoring-delta.js stamps its real exit code (exit 1 on a bad base), and --help leaves none', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 've-scoring-real-'));
  DIRS.push(dir);
  const env = { ...process.env, SCORING_DELTA_STAMP_DIR: dir, CLAUDE_CODE_SESSION_ID: 'real-run' };
  spawnSync('node', [path.join(REPO_ROOT, 'scripts/scoring-delta.js'), '--help'], { env, cwd: REPO_ROOT });
  assert.equal(inStampDir(dir, () => watch.readStamps('real-run')).length, 0, 'no stamp from --help');
  const r = spawnSync('node', [path.join(REPO_ROOT, 'scripts/scoring-delta.js'), '--base=no-such-ref-bro5270', '--json'], { env, cwd: REPO_ROOT });
  assert.equal(r.status, 1);
  const stamps = inStampDir(dir, () => watch.readStamps('real-run'));
  assert.equal(stamps.length, 1);
  assert.equal(stamps[0].exitCode, 1);
  assert.equal(stamps[0].base, 'no-such-ref-bro5270');
  assert.ok(stamps[0].started <= stamps[0].ts, 'stamp records when the run started');
});

// A clean scoring-delta stamp must never stand in for the separate regex audit.
const CQ = 'scripts/lib/content-quality.js';
function regexFixture(regexStamps = [], corpus = true, calls = []) {
  const f = fixture([{ ...edit(CQ), ts: ago(300) }, ...calls, { ...SHIP_CHECK, ts: ago(100) }],
    [stamp(150, 0, [CQ])]);
  f.corpus = corpus;
  inStampDir(f.stampDir, () => { for (const s of regexStamps) watch.writeStamp(s, f.sid, 'regex-audit'); });
  return f;
}
const regexStamp = (extra = {}) => ({ started: ago(200), ts: ago(190), exitCode: 0, full: true, maxHits: 5, scanned: 100, ...extra });

test('BRO-5307: content-quality edit without a regex audit stamp blocks when review texts exist', () => {
  blocked(runHook(regexFixture()), /audit-regex-patterns\.js --full/, 'missing regex audit');
});

test('BRO-5307: absent review texts only warn about the regex audit', () => {
  const r = runHook(regexFixture([], false));
  allowed(r, 'absent corpus');
  assert.match(r.stderr, /WARN.*data\/review-texts.*audit-regex-patterns/);
});

test('BRO-5307: only a completed full audit started after the content-quality edit clears the gate', () => {
  allowed(runHook(regexFixture([regexStamp()])), 'full audit');
  for (const extra of [{ full: false }, { maxHits: 999 }, { scanned: 0 }, { exitCode: 2 }, { exitCode: 3 },
    { started: ago(350) }, { started: undefined }, { ts: ago(350), started: ago(360) }]) {
    blocked(runHook(regexFixture([regexStamp(extra)])), /audit-regex-patterns/, JSON.stringify(extra));
  }
});

test('BRO-5307: exit-1 full audits warn with the file, violation count and names without blocking', () => {
  const violation = { exitCode: 1, violations: 14, violationNames: ['ERROR_PAGE_PATTERNS::0', 'PAYWALL_PATTERNS::1'] };
  const r = runHook(regexFixture([regexStamp(), regexStamp({ ...violation, ts: ago(180) })]));
  allowed(r, 'completed audit with threshold violations');
  assert.match(r.stderr, /WARN.*scripts\/lib\/content-quality\.js.*14.*threshold violation/);
  for (const name of violation.violationNames) assert.ok(r.stderr.includes(name), `warning names ${name}`);
  for (const extra of [{ full: false }, { maxHits: 999 }, { scanned: 0 }, { started: ago(350) }]) {
    blocked(runHook(regexFixture([regexStamp({ ...violation, ...extra })])), /audit-regex-patterns/, JSON.stringify(extra));
  }
});

test('BRO-5307: latest regex run decides and transcript output cannot replace a stamp', () => {
  blocked(runHook(regexFixture([regexStamp(), regexStamp({ exitCode: 2, ts: ago(180) })])), /audit-regex-patterns/, 'failed rerun');
  const clean = runHook(regexFixture([regexStamp({ exitCode: 1 }), regexStamp({ ts: ago(180) })]));
  allowed(clean, 'clean rerun');
  assert.doesNotMatch(clean.stderr, /threshold violation/);
  blocked(runHook(regexFixture([], true, [{ ...bash('node scripts/audit-regex-patterns.js --full | tail -1', 'All patterns under threshold'), ts: ago(200) }])),
    /audit-regex-patterns/, 'output without stamp');
});

test('BRO-5307: later edits cannot hide the regex requirement, and missing timestamps fail closed', () => {
  blocked(runHook(regexFixture([], true, [{ ...edit('scripts/other.js'), ts: ago(250) },
    { ...bash('node --check scripts/other.js'), ts: ago(200) }])), /audit-regex-patterns/, 'later unrelated edit');
  blocked(runHook(regexFixture([regexStamp()], true, [{ ...edit(CQ), ts: ago(120) }])), /audit-regex-patterns/, 'edit after audit');
  blocked(runHook(regexFixture([regexStamp()], true, [{ ...edit(CQ) }])), /audit-regex-patterns/, 'missing edit timestamp');
  const f = regexFixture([regexStamp()]);
  f.missingRegexGate = true;
  blocked(runHook(f), /cannot load regex-audit gate/, 'missing helper');
  allowed(runHook(regexFixture(), 'NO-VERIFY: Corpus audit deferred for an explicitly documented reason.'), 'existing override');
});

test('BRO-5307: audit CLI stamps real exits independently of scoring-delta, and help leaves no stamp', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 've-regex-cli-'));
  DIRS.push(root);
  fs.mkdirSync(path.join(root, 'scripts/lib'), { recursive: true });
  for (const rel of ['scripts/audit-regex-patterns.js', 'scripts/lib/scoring-watchlists.js', 'scripts/lib/regex-audit-gate.js']) {
    fs.copyFileSync(path.join(REPO_ROOT, rel), path.join(root, rel));
  }
  // Use the real pattern arrays and directory scanner. Title discovery is an
  // unrelated dependency, replaced with fixture arrays to avoid scraping deps.
  for (const name of ['content-quality.js', 'list-show-dirs.js']) {
    fs.symlinkSync(path.join(REPO_ROOT, 'scripts/lib', name), path.join(root, 'scripts/lib', name));
  }
  fs.writeFileSync(path.join(root, 'scripts/discover-new-shows.js'), 'module.exports = {NON_THEATER_PATTERNS: [], WE_EXTRA_PATTERNS: [], VENUE_PAGE_EXCLUDE_PATTERNS: []};');
  fs.writeFileSync(path.join(root, 'scripts/discover-opera-shows.js'), 'module.exports = {NON_OPERA_TITLE_PATTERNS: []};');
  fs.mkdirSync(path.join(root, 'public/data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'public/data/mobile-shows.json'), JSON.stringify({ shows: Array.from({ length: 15 }, (_, i) => ({ t: `Opera ${i}`, ty: 'opera' })) }));
  fs.mkdirSync(path.join(root, 'tests/fixtures'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'tests/fixtures/discovery-title-corpus.json'), path.join(root, 'tests/fixtures/discovery-title-corpus.json'));
  const stampDir = path.join(root, 'stamps');
  const env = { ...process.env, SCORING_DELTA_STAMP_DIR: stampDir, CLAUDE_CODE_SESSION_ID: 'regex-cli' };
  const run = (...args) => spawnSync('node', ['scripts/audit-regex-patterns.js', ...args], { cwd: root, env, encoding: 'utf8' });
  const stamps = () => inStampDir(stampDir, () => watch.readStamps('regex-cli', 'regex-audit'));
  assert.equal(run('--help').status, 0);
  assert.equal(stamps().length, 0);
  assert.equal(run('--full').status, 2, 'missing corpus exits 2');
  assert.equal(stamps().at(-1).exitCode, 2);
  const corpus = path.join(root, 'data/review-texts/show');
  fs.mkdirSync(corpus, { recursive: true });
  const text = 'The production has fine acting, strong direction and memorable performances. '.repeat(20);
  fs.writeFileSync(path.join(corpus, 'clean.json'), JSON.stringify({ fullText: text, contentTier: 'complete' }));
  assert.equal(run('--full', '--json').status, 0);
  const full = stamps().at(-1);
  assert.equal(full.exitCode, 0);
  assert.equal(full.full, true);
  assert.equal(full.scanned, 1);
  assert.equal(full.maxHits, 5);
  assert.equal(full.violations, 0);
  assert.deepEqual(full.violationNames, []);
  assert.ok(full.started <= full.ts);
  assert.equal(run('--json').status, 0);
  assert.equal(stamps().at(-1).full, false, 'sampling cannot masquerade as --full');
  for (let i = 0; i < 6; i++) {
    fs.writeFileSync(path.join(corpus, `error-${i}.json`), JSON.stringify({ fullText: 'Page not found. ' + text, contentTier: 'complete' }));
  }
  assert.equal(run('--full', '--json').status, 1, 'real pattern violations exit 1');
  assert.equal(stamps().at(-1).exitCode, 1);
  assert.equal(stamps().at(-1).violations, 2);
  assert.deepEqual(stamps().at(-1).violationNames, ['ERROR_PAGE_PATTERNS::0', 'STRONG_ERROR_PAGE_PATTERNS::0']);
  fs.writeFileSync(path.join(root, 'scripts/discover-new-shows.js'), 'module.exports = {NON_THEATER_PATTERNS: ["opera 0"], WE_EXTRA_PATTERNS: [], VENUE_PAGE_EXCLUDE_PATTERNS: []};');
  fs.writeFileSync(path.join(root, 'scripts/discover-opera-shows.js'), 'module.exports = {NON_OPERA_TITLE_PATTERNS: ["opera 1"]};');
  assert.equal(run('--full', '--json').status, 1, 'title violations also appear in the stamp');
  assert.equal(stamps().at(-1).violations, 4);
  assert.deepEqual(stamps().at(-1).violationNames, [
    'ERROR_PAGE_PATTERNS::0', 'STRONG_ERROR_PAGE_PATTERNS::0', 'NON_THEATER_PATTERNS::0', 'NON_OPERA_TITLE_PATTERNS::0',
  ]);
  fs.writeFileSync(path.join(root, 'scripts/discover-new-shows.js'), 'module.exports = {NON_THEATER_PATTERNS: ["hard job"], WE_EXTRA_PATTERNS: [], VENUE_PAGE_EXCLUDE_PATTERNS: []};');
  fs.writeFileSync(path.join(root, 'scripts/discover-opera-shows.js'), 'module.exports = {NON_OPERA_TITLE_PATTERNS: ["devereux"]};');
  const external = run('--full', '--json');
  assert.equal(external.status, 1, 'external controls flag exclusions absent from mobile-shows.json');
  const report = JSON.parse(external.stdout);
  assert.equal(report.titleViolations[0].examples[0].match, 'Hard Job Being God');
  assert.equal(report.operaTitleViolations[0].examples[0].match, 'Roberto Devereux');
  fs.unlinkSync(path.join(root, 'tests/fixtures/discovery-title-corpus.json'));
  assert.equal(run('--full', '--json').status, 2, 'missing independent evidence cannot pass');
  assert.equal(stamps().at(-1).exitCode, 2);
  assert.equal(inStampDir(stampDir, () => watch.readStamps('regex-cli')).length, 0, 'regex stamps never satisfy scoring-delta');
});
