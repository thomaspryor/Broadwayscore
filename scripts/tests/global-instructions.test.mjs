// BRO-4237: cloud sessions get the owner's global instructions, fetched from
// the private claude-config repo and installed as ~/.claude/CLAUDE.md by the
// cloud session-start hook. Real functions via require() (CLAUDE.md §15); the
// fetcher is injected so no test touches the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSyncStdinFile } from '../../tests/helpers/spawn-stdin-file.mjs';

const require = createRequire(import.meta.url);
const { installForCloud, renderInstalled, stripMacOnly, MARKER, GLOBAL_FILES } = require('../lib/global-instructions.js');
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `bro-4237-${tag}-`));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
const fakeFetch = (files) => async (name) => (name in files ? { text: files[name], reason: null } : { text: null, reason: 'HTTP 404' });
const SOURCE = { 'CLAUDE.md': '# Global Rules\n## Cloud sessions\n- owner not technical\n', 'anti-slop-rules.md': '# no em dashes\n' };

test('installForCloud: installs every source file with the GENERATED marker', async (t) => {
  const home = tmp('home'); t.after(() => rm(home));
  const r = await installForCloud({ homeDir: home, fetchFn: fakeFetch(SOURCE) });
  assert.deepEqual(r.installed, GLOBAL_FILES);
  for (const name of GLOBAL_FILES) {
    const body = fs.readFileSync(path.join(home, '.claude', name), 'utf8');
    assert.equal(body, renderInstalled(name, SOURCE[name]));
    assert.ok(body.includes(MARKER));
  }
});

test('installForCloud: a second run is a no-op; a changed source is rewritten', async (t) => {
  const home = tmp('home'); t.after(() => rm(home));
  await installForCloud({ homeDir: home, fetchFn: fakeFetch(SOURCE) });
  assert.deepEqual((await installForCloud({ homeDir: home, fetchFn: fakeFetch(SOURCE) })).unchanged, GLOBAL_FILES);
  const r = await installForCloud({ homeDir: home, fetchFn: fakeFetch({ ...SOURCE, 'CLAUDE.md': '# edited on the Mac\n' }) });
  assert.deepEqual(r.installed, ['CLAUDE.md']);
  assert.match(fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8'), /edited on the Mac/);
});

test('installForCloud: never overwrites a hand-written ~/.claude file (a real Mac config)', async (t) => {
  const home = tmp('home'); t.after(() => rm(home));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'the real Mac rules\n');
  const r = await installForCloud({ homeDir: home, fetchFn: fakeFetch(SOURCE) });
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8'), 'the real Mac rules\n');
  assert.match(r.skipped.find((s) => s.name === 'CLAUDE.md').reason, /hand-written/);
  assert.deepEqual(r.installed, ['anti-slop-rules.md']);
});

// BRO-5072: Mac-only blocks are dropped from the cloud copy, never anything else.
const O = '<!-- mac-only -->';
const C = '<!-- /mac-only -->';

test('stripMacOnly: drops whole-line blocks, keeps everything else', () => {
  const r = stripMacOnly(['# Rules', O, '## File Output', 'save to ~/Documents', C, '## Cloud sessions', '- keep me', O, 'cmux', C, 'end'].join('\n'));
  assert.equal(r.text, ['# Rules', '## Cloud sessions', '- keep me', 'end'].join('\n'));
  assert.equal(r.warning, null);
  assert.equal(r.removedLines, 7);
});

test('stripMacOnly: CRLF and indented markers count; markers inside prose do not', () => {
  assert.equal(stripMacOnly(['a', `  ${O}\r`, 'mac', `${C}\r`, 'b'].join('\n')).text, 'a\nb');
  const prose = `blocks between ${O} and ${C} are stripped\nrule`;
  assert.deepEqual(stripMacOnly(prose), { text: prose, removedLines: 0, warning: null });
});

test('stripMacOnly: markers inside a code fence are examples, not markers', () => {
  const doc = ['a', '```', O, 'example', C, '```', 'b'].join('\n');
  assert.deepEqual(stripMacOnly(doc), { text: doc, removedLines: 0, warning: null });
  const mixed = [O, 'mac', '```', 'code', '```', C, 'b'].join('\n');
  assert.equal(stripMacOnly(mixed).text, 'b');
});

test('stripMacOnly: any imbalance leaves the text whole and warns', () => {
  for (const [lines, re] of [
    [[O, 'x', O, 'y', C, C], /nested/],
    [['x', C, 'y'], /stray/],
    [['x', O, 'y'], /unclosed/],
  ]) {
    const text = lines.join('\n');
    const r = stripMacOnly(text);
    assert.equal(r.text, text);
    assert.match(r.warning, re);
  }
});

test('installForCloud: installs the stripped copy and reports a bad marker', async (t) => {
  const home = tmp('home'); t.after(() => rm(home));
  const src = { ...SOURCE, 'CLAUDE.md': `# Global\n${O}\nmac only rule\n${C}\n## Cloud sessions\n` };
  const r = await installForCloud({ homeDir: home, fetchFn: fakeFetch(src) });
  const body = fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8');
  assert.ok(!body.includes('mac only rule') && body.includes('## Cloud sessions'));
  assert.deepEqual(r.warnings, []);
  assert.deepEqual((await installForCloud({ homeDir: home, fetchFn: fakeFetch(src) })).unchanged, GLOBAL_FILES);
  const bad = await installForCloud({ homeDir: home, fetchFn: fakeFetch({ ...SOURCE, 'CLAUDE.md': `x\n${O}\nmac` }) });
  assert.match(bad.warnings[0], /^CLAUDE\.md: unclosed/);
  assert.match(fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8'), /mac$/);
});

test('installForCloud: a failed fetch installs nothing and says why (fail open)', async (t) => {
  const home = tmp('home'); t.after(() => rm(home));
  const r = await installForCloud({ homeDir: home, fetchFn: fakeFetch({}) });
  assert.deepEqual(r.installed, []);
  assert.equal(r.skipped.length, GLOBAL_FILES.length);
  assert.match(r.skipped[0].reason, /fetch failed: HTTP 404/);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'CLAUDE.md')), false);
});

function runHook(env, source = SOURCE) {
  const home = tmp('hookhome');
  const project = tmp('proj');
  const src = tmp('src');
  for (const [n, c] of Object.entries(source)) fs.writeFileSync(path.join(src, n), c);
  try {
    const full = { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: REPO_ROOT, CODE_SYNC_DISABLED: '1', GLOBAL_INSTRUCTIONS_FROM_DIR: src, ...env };
    for (const [k, v] of Object.entries(full)) if (v === undefined) delete full[k];
    const out = execFileSyncStdinFile('bash', [path.join(REPO_ROOT, '.claude', 'hooks', 'session-start.sh')], {
      cwd: project, input: '{"source":"startup"}', encoding: 'utf8', timeout: 120000, env: full, stdio: ['pipe', 'pipe', 'ignore'],
    });
    const installed = fs.existsSync(path.join(home, '.claude', 'CLAUDE.md')) ? fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8') : null;
    return { out, installed };
  } finally {
    rm(home); rm(project); rm(src);
  }
}

test('session-start.sh (real hook): a cloud session gets ~/.claude/CLAUDE.md installed', () => {
  const { installed } = runHook({ CLAUDE_CODE_REMOTE: 'true' });
  assert.ok(installed, 'cloud session must get the global instructions');
  assert.match(installed, /## Cloud sessions/);
  assert.ok(installed.includes(MARKER));
});

test('session-start.sh (real hook): no install outside cloud, and the kill switch works', () => {
  assert.equal(runHook({ CLAUDE_CODE_REMOTE: undefined }).installed, null);
  assert.equal(runHook({ CLAUDE_CODE_REMOTE: 'true', CLOUD_GLOBAL_RULES_DISABLED: '1' }).installed, null);
});

test('session-start.sh (real hook): the owner profile is no longer printed when the install works (single source is the installed file)', () => {
  const { out } = runHook({ CLAUDE_CODE_REMOTE: 'true', CLAUDE_CODE_ENTRYPOINT: 'remote_mobile' });
  assert.doesNotMatch(out, /ABOUT THE OWNER|not installed/);
  assert.match(out, /CRITICAL SESSION RULES/);
});

test('session-start.sh (real hook): a failed install is never silent — it prints the owner fallback and the reason', () => {
  const { out, installed } = runHook({ CLAUDE_CODE_REMOTE: 'true', GLOBAL_INSTRUCTIONS_FROM_DIR: '/nonexistent-bro-4237' });
  assert.equal(installed, null);
  assert.match(out, /global instructions not installed \(.*fetch failed/);
  assert.match(out, /not technical/);
  assert.match(out, /never reviews or merges PRs/);
});

test('session-start.sh (real hook): a malformed mac-only marker is reported, and the rules still install whole (BRO-5072)', () => {
  const { out, installed } = runHook({ CLAUDE_CODE_REMOTE: 'true' }, { ...SOURCE, 'CLAUDE.md': `${SOURCE['CLAUDE.md']}${O}\nmac rule\n` });
  assert.match(installed, /mac rule/);
  assert.match(out, /WARNING CLAUDE\.md: unclosed mac-only block/);
  const ok = runHook({ CLAUDE_CODE_REMOTE: 'true' }, { ...SOURCE, 'CLAUDE.md': `${SOURCE['CLAUDE.md']}${O}\nmac rule\n${C}\n` });
  assert.doesNotMatch(ok.installed, /mac rule/);
  assert.doesNotMatch(ok.out, /WARNING/);
});

// BRO-5072: every cloud session reads .claude/CLOUD.md before any work. It
// grew to 37KB of changelog narrative with no cap; trimmed to ~24KB. Keep
// rules there, history in git and Linear.
const CLOUD_MD_MAX_BYTES = 26 * 1024;
test('.claude/CLOUD.md stays under its byte cap', () => {
  const bytes = fs.statSync(path.join(REPO_ROOT, '.claude', 'CLOUD.md')).size;
  assert.ok(bytes <= CLOUD_MD_MAX_BYTES, `.claude/CLOUD.md is ${bytes}B (cap ${CLOUD_MD_MAX_BYTES}B): trim narrative, keep rules`);
});

// BRO-5732: two landings each fit under the cap alone but not together (3B of
// headroom, then 503B over, BRO-5648). Requiring headroom makes the landing
// that eats the margin fail its own gauntlet, so trim happens in that PR.
const CLOUD_MD_MIN_HEADROOM_BYTES = 256;
test('.claude/CLOUD.md keeps headroom under its byte cap', () => {
  const bytes = fs.statSync(path.join(REPO_ROOT, '.claude', 'CLOUD.md')).size;
  assert.ok(CLOUD_MD_MAX_BYTES - bytes >= CLOUD_MD_MIN_HEADROOM_BYTES, `.claude/CLOUD.md is ${bytes}B, ${CLOUD_MD_MAX_BYTES - bytes}B under the cap (need ${CLOUD_MD_MIN_HEADROOM_BYTES}B headroom): trim narrative before adding`);
});

// BRO-5072: AGENTS.md (Codex) points at CLAUDE.md instead of copying it; the
// copies drifted. A cap stops them growing back.
const AGENTS_MD_MAX_BYTES = 4 * 1024;
test('AGENTS.md stays a short pointer to CLAUDE.md', () => {
  const text = fs.readFileSync(path.join(REPO_ROOT, 'AGENTS.md'), 'utf8');
  assert.ok(Buffer.byteLength(text) <= AGENTS_MD_MAX_BYTES, `AGENTS.md is ${Buffer.byteLength(text)}B (cap ${AGENTS_MD_MAX_BYTES}B): put rules in CLAUDE.md, not here`);
  assert.match(text, /Read `CLAUDE\.md`/);
});
