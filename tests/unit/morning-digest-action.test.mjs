// BRO-6230: the morning digest as a GitHub Action (dry-run only), the Mac
// heartbeat that replaces "the digest arrived" as the dead-Mac signal, and the
// digest compare tooling. Pins the workflow shape so a later edit cannot quietly
// add a send, a schedule or a public dump of the digest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const hb = require('../../scripts/lib/mac-applied-heartbeat.js');
const digest = require('../../scripts/send-morning-digest.js');
const cmp = require('../../scripts/morning-digest-compare.js');

// ── workflow shape ──────────────────────────────────────────────────────────
const WF = read('.github/workflows/morning-digest-action.yml');
const steps = WF.split(/\n {6}- (?:name|uses):/).slice(1);

test('digest workflow: committed schedule (both DST offsets), gated by the handoff date, no repo variable', () => {
  assert.match(WF, /^ {2}workflow_dispatch:/m);
  const crons = [...WF.matchAll(/^ {4}- cron: '([^']+)'$/gm)].map((m) => m[1]);
  assert.deepEqual(crons, ['50 11 * * *', '50 12 * * *', '50 13 * * *']);
  assert.doesNotMatch(WF, /MORNING_DIGEST_ACTION_ENABLED|MAC_ALIVE_SIGNAL/);
  assert.doesNotMatch(WF, /ENABLE_FROM: '/, 'the date lives only in config/morning-digest-handoff.json');
  assert.match(WF, /d=\$\(node -p "require\('\.\/scripts\/lib\/digest-handoff\.js'\)\.handoffDate\(\)"\)\n\s+node scripts\/lib\/digest-enable-gate\.js "\$d"/);
  assert.match(WF, /^ {6}test:$/m);
  // A scheduled run sends only when the gate said go; dispatch sends only with send=true.
  assert.match(WF, /if: \(github\.event_name == 'schedule' && steps\.gate\.outputs\.go == 'true'\) \|\| \(github\.event_name == 'workflow_run' && steps\.precheck\.outputs\.go == 'true'\) \|\| \(github\.event_name == 'workflow_dispatch' && inputs\.send\)/);
});

test('digest workflow: dropped-cron catch-up wakes on Test Suite and Deploy to Vercel runs on main, gated then pre-checked, one send path', () => {
  assert.match(WF, /^ {2}workflow_run:\n {4}workflows: \['Test Suite', 'Deploy to Vercel'\]\n {4}types: \[completed\]\n {4}branches: \[main\]/m);
  // gate runs for schedule and catch-up; the pre-check only for the catch-up, only after the gate said go
  assert.match(WF, /id: gate\n\s+if: github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_run'/);
  assert.match(WF, /id: precheck\n\s+if: github\.event_name == 'workflow_run' && steps\.gate\.outputs\.go == 'true'/);
  assert.match(WF, /node scripts\/digest-sent-precheck\.js/);
  // exactly one send step, always with the Resend sent-today guard on the automatic paths
  assert.equal((WF.match(/send-morning-digest\.js --send-to-owner/g) || []).length, 1);
  assert.match(WF, /--resend-sent-guard/);
  // cache restore follows the same condition so a skipped wake does no work
  const cache = steps.find((x) => x.includes("Restore yesterday's board snapshot"));
  assert.match(cache, /workflow_run' && steps\.precheck\.outputs\.go == 'true'/);
  // the failure pager treats the catch-up like the schedule
  assert.match(WF, /\(github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_run'\) && 'critical'/);
});

test('digest workflow: wake sources are pinned and each names a real workflow (BRO-7016)', () => {
  // GitHub silently ignores an unknown workflow name, so a rename would quietly remove a wake.
  const m = WF.match(/^ {2}workflow_run:\n {4}workflows: \[([^\]]*)\]/m);
  assert.ok(m, 'workflow_run.workflows list not found');
  const names = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.equal(m[1].split(',').length, names.length, 'list entries must be single-quoted strings');
  // Exact list: Test Suite is push-driven and can be silent for 2h at the 07:45 ET gate opening
  // (2026-11-05), Deploy to Vercel finishes every 10-20 min. Cron re-dispatch is excluded on purpose
  // (woken by Test Suite itself = no independence, and at the 3-level workflow_run chain limit).
  assert.deepEqual(names, ['Test Suite', 'Deploy to Vercel']);
  const dir = path.join(ROOT, '.github/workflows');
  const topNames = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => {
    const line = read(`.github/workflows/${f}`).split('\n').find((l) => /^name:/.test(l)) || '';
    return line.replace(/\s+#.*$/, '').replace(/^name:\s*['"]?/, '').replace(/['"]?\s*$/, '');
  });
  for (const n of names) assert.equal(topNames.filter((x) => x === n).length, 1, `"${n}" must be the top-level name of exactly one workflow`);
});

test('digest workflow: the Mac label is NOT retired; on the handoff day it runs autofix only (W2)', () => {
  const retired = JSON.parse(read('config/mac-retired.json')).entries.map((e) => e.label);
  assert.ok(!retired.includes('com.broadwayscore.morning-digest'), 'retiring it boots out the job that runs autofix + canary');
  assert.ok(!fs.existsSync(path.join(ROOT, 'scripts/launchd/com.broadwayscore.digest-autofix.plist')), 'the uninstalled standalone plist would double-run autofix');
  const src = read('scripts/send-morning-digest.js');
  assert.match(src, /require\('\.\/lib\/digest-handoff\.js'\)\.actionOwnsToday\(\)/);
  assert.match(src, /const autofixOnly = !!args\['autofix-only'\] \|\| macHandoff;/);
  assert.match(src, /const dryRun = !!args\['dry-run'\] \|\| autofixOnly;/);
  // macHandoff only covers a REAL owner send from the Mac: never dry runs, tests, --force or the Action itself.
  const m = src.match(/const macHandoff = ([\s\S]*?)\n\s*if \(macHandoff\)/)[1];
  for (const guard of ["!args['autofix-only']", "!args['dry-run']", "!args['test-send']", '!args.force', "GITHUB_ACTIONS !== 'true'"]) {
    assert.ok(m.includes(guard), `macHandoff must be gated by ${guard}`);
  }
  // The handoff branch drops the recipient flags so nothing can send.
  assert.match(src, /if \(macHandoff\) \{[\s\S]*?delete args\['send-to'\]; delete args\['send-to-owner'\];/);
});

test('digest workflow: the only send is owner-only, guarded, report-only; never a broadcast', () => {
  const code = WF.replace(/^\s*#.*$/gm, '');
  assert.doesNotMatch(code, /--send-to [^-]|broadcasts|--force/);
  assert.equal(code.match(/--send-to-owner/g).length, 1);
  assert.match(WF, /send-morning-digest\.js --send-to-owner --no-autofix --skip-mac-local \$MODE \\\n\s+> "\$RUNNER_TEMP\/digest\.log" 2>&1/);
  assert.match(WF, /MODE="--resend-sent-guard"/);
  assert.match(WF, /send-morning-digest\.js --dry-run --no-autofix --skip-mac-local --resend-sent-guard \\\n\s+> "\$RUNNER_TEMP\/digest\.log" 2>&1/);
  // Already sent (exit 3) is green; every other nonzero stays red.
  assert.match(WF, /if \[ "\$status" -eq 3 \]; then[^\n]*exit 0; fi\n/);
  // The dry-run/compare steps never run on schedule or with send=true (they would pin to our own send).
  for (const name of ["Fetch today's Mac-sent digest", 'Pin snapshots', 'Build the digest (dry run']) {
    const step = steps.find((x) => x.includes(name));
    assert.match(step, /if: github\.event_name == 'workflow_dispatch' && !inputs\.send/, name);
  }
  assert.doesNotMatch(WF, /upload-artifact|GITHUB_STEP_SUMMARY/);
  assert.equal(WF.match(/\$\{\{\s*inputs\.pubkey_b64\s*\}\}/g).length, 1);
  assert.match(WF, /PUBKEY_B64: \$\{\{ inputs\.pubkey_b64 \}\}/);
});

test('digest workflow: read-only permissions, no npm install, notify-failure last (critical only when scheduled)', () => {
  assert.match(WF, /^permissions:\n {2}contents: read\n {2}statuses: read\n {2}actions: read\b/m);
  assert.doesNotMatch(WF.replace(/^\s*#.*$/gm, ''), /: write\b/);
  assert.doesNotMatch(WF.replace(/^\s*#.*$/gm, ''), /npm (ci|install)/);
  const last = steps[steps.length - 1];
  assert.match(last, /uses: \.\/\.github\/actions\/notify-failure/);
  assert.match(last, /severity: \$\{\{ \(github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_run'\) && 'critical' \|\| 'warning' \}\}/);
});

test('pager workflow: both signals are live and explicit, no repo variables', () => {
  const pager = read('.github/workflows/check-morning-digest-sent.yml');
  assert.doesNotMatch(pager, /vars\./);
  assert.doesNotMatch(pager, /continue-on-error/);
  assert.match(pager, /ARGS="--signal=digest"/);
  assert.match(pager, /ARGS="--signal=heartbeat"/);
  assert.match(pager, /cron: '30 16 \* \* \*'/);
  assert.match(pager, /^ {2}statuses: read$/m);
});

test('pager script: heartbeat is the default signal and uses its own, allowlisted, owner-actioned key', () => {
  const src = read('scripts/check-morning-digest-sent.js');
  assert.match(src, /signalArg \? signalArg\.split\('='\)\[1\] : 'heartbeat'/);
  const { PAGE_WORTHY_CONDITION_KEYS, ownerActionFor } = require('../../scripts/lib/page-worthy-alerts.js');
  for (const key of ['mac:checkin-heartbeat-dead', 'mac:morning-digest-missing']) {
    assert.ok([...PAGE_WORTHY_CONDITION_KEYS].includes(key), `${key} must be page-worthy`);
    assert.ok(ownerActionFor(key), `${key} needs an owner action line`);
  }
  assert.match(src, /conditionKey: 'mac:checkin-heartbeat-dead'/);
  assert.notEqual(require('../../scripts/lib/morning-digest-liveness.js').CONDITION_KEY, 'mac:checkin-heartbeat-dead');
});

// ── scheduled-send gate ─────────────────────────────────────────────────────
const gate = require('../../scripts/lib/digest-enable-gate.js');
const handoff = require('../../scripts/lib/digest-handoff.js');
test('gate: refuses before ENABLE_FROM, before 07:45 ET, and on a bad date; sends in both DST seasons', () => {
  const d = (iso) => gate.decideScheduledSend({ now: new Date(iso), enableFrom: handoff.handoffDate() });
  assert.equal(handoff.handoffDate(), '2026-11-02');
  assert.equal(d('2026-11-01T12:50:00Z').go, false, 'day before: Mac still sends');
  assert.equal(d('2026-11-02T11:50:00Z').go, false, 'EST 06:50 is early');
  assert.equal(d('2026-11-02T12:50:00Z').go, true, 'EST 07:50');
  assert.equal(d('2026-11-02T13:50:00Z').go, true, 'EST retry');
  assert.equal(d('2027-07-01T11:50:00Z').go, true, 'EDT 07:50');
  assert.equal(d('2027-07-01T10:50:00Z').go, false);
  // upper bound: the catch-up must not fire a stale digest in the afternoon (pager owns it from 11:30 ET)
    assert.equal(d('2026-11-02T16:29:00Z').go, true, 'EST 11:29');
  assert.equal(d('2026-11-02T16:30:00Z').go, false, 'EST 11:30 (pager time)');
  assert.equal(d('2027-07-01T15:29:00Z').go, true, 'EDT 11:29');
  assert.equal(d('2027-07-01T15:30:00Z').go, false, 'EDT 11:30');
  assert.equal(d('2026-11-03T12:50:00Z').go, true, 'next morning, EST 07:50');
  for (const bad of [undefined, '', '2026-13-45', 'tomorrow']) assert.equal(gate.decideScheduledSend({ now: new Date('2027-01-01T13:00:00Z'), enableFrom: bad }).go, false, String(bad));
});

// ── --autofix-only ──────────────────────────────────────────────────────────
test('autofix-only: never sends, keeps autofix live', () => {
  const src = read('scripts/send-morning-digest.js');
  assert.match(src, /autofixShouldDryRun\(\{ dryRun: !!args\['dry-run'\],/);
  assert.match(src, /--autofix-only never sends/);
  assert.match(src, /autofixFailed \|\| invariantViolations\.length/);
  assert.match(WF, /path: data\/audit\/board-report-snapshot\.json/);
  // The installed Mac job is the one that runs it after the handoff: same SYNC_TAG gate, still --send-to-owner on its command line.
  const plist = read('scripts/launchd/com.broadwayscore.morning-digest.plist');
  assert.match(plist, /export SYNC_TAG=digest/);
  assert.match(plist, /node scripts\/send-morning-digest\.js --send-to-owner/);
});

// ── require graph: the workflow skips npm ci ────────────────────────────────
test('digest and compare load only node built-ins and repo files', () => {
  const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
  const seen = new Set();
  const bad = [];
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    // Comments mention requires that never run (usage examples, history).
    const src = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const spec = m[1];
      if (spec.startsWith('.')) {
        // data/*.json is data, not an npm package; core data is absent from a fresh clone.
        if (path.relative(ROOT, path.resolve(path.dirname(file), spec)).startsWith('data' + path.sep)) continue;
        let dep;
        try { dep = require.resolve(path.resolve(path.dirname(file), spec)); } catch { bad.push(`${path.relative(ROOT, file)} -> ${spec} (unresolvable)`); continue; }
        if (dep.endsWith('.js') || dep.endsWith('.cjs')) walk(dep);
      } else if (!builtins.has(spec) && !builtins.has(spec.split('/')[0])) {
        bad.push(`${path.relative(ROOT, file)} -> ${spec}`);
      }
    }
  };
  walk(path.join(ROOT, 'scripts/send-morning-digest.js'));
  walk(path.join(ROOT, 'scripts/morning-digest-compare.js'));
  assert.deepEqual(bad, [], 'a package import here needs npm ci in morning-digest-action.yml');
  assert.ok(seen.size > 20, `walked ${seen.size} files`);
});

// ── Mac heartbeat ───────────────────────────────────────────────────────────
const NOW = new Date('2026-10-25T15:00:00Z');
const H = 3600e3;

test('decideMacAlive: fresh heartbeat is alive, stale is dead, failed or short reads are unknown', () => {
  assert.equal(hb.decideMacAlive({ newestMs: NOW - 1 * H, now: NOW }).state, 'alive');
  assert.equal(hb.decideMacAlive({ newestMs: NOW - (hb.DEAD_AFTER_MS - 60e3), now: NOW }).state, 'alive');
  const dead = hb.decideMacAlive({ newestMs: NOW - (hb.DEAD_AFTER_MS + 60e3), now: NOW });
  assert.equal(dead.state, 'dead');
  assert.ok(dead.ageH > 6);
  assert.equal(hb.decideMacAlive({ newestMs: null, oldestWalkedMs: NOW - 10 * H, now: NOW }).state, 'dead');
  assert.equal(hb.decideMacAlive({ newestMs: null, oldestWalkedMs: NOW - 2 * H, now: NOW }).state, 'unknown');
  assert.equal(hb.decideMacAlive({ readError: 'HTTP 502', now: NOW }).state, 'unknown');
});

function fakeGraphql(pages) {
  const calls = [];
  const fn = async (q, vars) => {
    calls.push(vars.after);
    const i = vars.after ? Number(vars.after) : 0;
    const nodes = pages[i];
    return { repository: { ref: { target: { history: { nodes, pageInfo: { hasNextPage: i + 1 < pages.length, endCursor: String(i + 1) } } } } } };
  };
  fn.calls = calls;
  return fn;
}
const commit = (t, status) => ({ committedDate: new Date(t).toISOString(), status: status ? { context: status } : null });

test('fetchHeartbeat: first SUCCESS heartbeat wins, pages until found, ignores non-success', async () => {
  const g = fakeGraphql([
    [commit(NOW - 0.1 * H), commit(NOW - 0.2 * H, { state: 'FAILURE', createdAt: new Date(NOW - 0.2 * H).toISOString() })],
    [commit(NOW - 1 * H), commit(NOW - 2 * H, { state: 'SUCCESS', createdAt: new Date(NOW - 1.5 * H).toISOString() })],
  ]);
  const r = await hb.fetchHeartbeat({ graphql: g, repo: 'o/r' });
  assert.equal(r.newestMs, NOW - 1.5 * H);
  assert.deepEqual(g.calls, [null, '1']);
});

test('fetchHeartbeat: none found reports how far back it looked; readMacAlive never throws', async () => {
  const g = fakeGraphql([[commit(NOW - 1 * H), commit(NOW - 9 * H)]]);
  const r = await hb.fetchHeartbeat({ graphql: g, repo: 'o/r' });
  assert.deepEqual(r, { newestMs: null, oldestWalkedMs: NOW - 9 * H });
  const bad = await hb.readMacAlive({ graphql: async () => { throw new Error('boom'); }, now: NOW });
  assert.equal(bad.state, 'unknown');
  assert.match(bad.reason, /boom/);
});

// ── digest flags ────────────────────────────────────────────────────────────
test('digest parseArgs accepts the three Action flags; USAGE names them', () => {
  const a = digest.parseArgs(['--dry-run', '--no-autofix', '--skip-mac-local', '--resend-sent-guard']);
  for (const k of ['dry-run', 'no-autofix', 'skip-mac-local', 'resend-sent-guard']) assert.ok(a[k], k);
  const src = read('scripts/send-morning-digest.js');
  for (const k of ['--no-autofix', '--skip-mac-local', '--resend-sent-guard']) assert.ok(src.includes(`  ${k} `), `USAGE lists ${k}`);
});

test('macLocalSkippedLine names the missing sections and alarms unless the Mac is alive', () => {
  const ok = digest.macLocalSkippedLine({ state: 'alive', reason: 'the Mac finished a checkout sync 0.5h ago' });
  assert.equal(ok.alarm, false);
  assert.match(ok.text, /Not in this email \(Mac-only\): .*dispatch watchdog/);
  const dead = digest.macLocalSkippedLine({ state: 'dead', reason: 'no Mac checkout sync in the last 7h of main' });
  assert.equal(dead.alarm, true);
  assert.match(dead.text, /off or logged out, or its code sync is stuck/);
  assert.equal(digest.macLocalSkippedLine({ state: 'unknown', reason: 'x' }).alarm, true);
});

test('resendSentToday: already sent, not yet sent, and fail-closed cases', async () => {
  const to = 'owner@example.com';
  const row = (subject, created_at) => ({ subject, created_at, to: [to] });
  const sent = await digest.resendSentToday({ apiKey: 'k', recipient: to, now: NOW, fetchEmails: async () => [row('Morning digest — Sun, Oct 25', '2026-10-25T11:31:00Z')] });
  assert.equal(sent.verdict, 'already-sent');
  const yesterdayOnly = await digest.resendSentToday({ apiKey: 'k', recipient: to, now: NOW, fetchEmails: async () => [row('Morning digest — Sat, Oct 24', '2026-10-24T11:31:00Z')] });
  assert.equal(yesterdayOnly.verdict, 'send');
  const thrown = await digest.resendSentToday({ apiKey: 'k', recipient: to, now: NOW, fetchEmails: async () => { throw new Error('403 restricted key'); } });
  assert.equal(thrown.verdict, 'cannot-tell');
  assert.equal((await digest.resendSentToday({ apiKey: '', recipient: to })).verdict, 'cannot-tell');
  assert.equal((await digest.resendSentToday({ apiKey: 'k', recipient: null })).verdict, 'cannot-tell');
});

// ── compare tooling ─────────────────────────────────────────────────────────
const page = (title, lines) => `<html><head><style>p{}</style></head><body>
<p style="font-size:15px;font-weight:700;color:#1a1a19;margin:0 0 8px;">${title}</p>
${lines.map((l) => `<p style="font-size:12px;">${l}</p>`).join('\n')}</body></html>`;

test('htmlToLines and headings read the digest markup', () => {
  const html = page('How the board is doing', ['3 cards done &amp; 2 open', 'Tom&#39;s line']);
  assert.deepEqual(cmp.htmlToLines(html), ['How the board is doing', '3 cards done & 2 open', "Tom's line"]);
  assert.deepEqual(cmp.headings(html), ['How the board is doing']);
  assert.deepEqual(cmp.headings(page('3 decisions for you', [])), ['# decision for you']);
});

test('compareDigests: counts and dates do not count as drift; the public summary holds no body lines', () => {
  const mac = page('How the board is doing', ['78/day Done on Sat, Oct 24', 'secret-ish card title A']);
  const act = page('How the board is doing', ['81/day Done on Sun, Oct 25', 'card title B']);
  const r = cmp.compareDigests(mac, act);
  assert.equal(r.same, 2);
  assert.equal(r.macOnly, 1);
  assert.equal(r.actionOnly, 1);
  assert.doesNotMatch(r.public, /card title/);
  assert.match(r.full, /secret-ish card title A[\s\S]*card title B/);
});

test('pickTodaysDigest takes the newest Morning digest of the ET day', () => {
  const rows = [
    { subject: 'Morning digest — Sat', created_at: '2026-10-25T03:00:00Z' }, // 23:00 ET on the 24th
    { subject: 'Morning digest — Sun', created_at: '2026-10-25T11:31:00Z' },
    { subject: 'Something else', created_at: '2026-10-25T12:00:00Z' },
  ];
  assert.equal(cmp.pickTodaysDigest(rows, NOW).email.subject, 'Morning digest — Sun');
  assert.equal(cmp.pickTodaysDigest([rows[0]], NOW).email, null);
});

test('fetchMac writes meta and body; missing body or no email is not an error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-cmp-'));
  const listImpl = async () => [{ id: 'e1', subject: 'Morning digest — Sun', created_at: '2026-10-25T11:31:00Z' }];
  const fetchImpl = async () => ({ ok: true, json: async () => ({ html: '<p>hi</p>' }) });
  assert.equal(await cmp.fetchMac({ outDir: dir, apiKey: 'k', ownerEmail: 'o@x', now: NOW, listImpl, fetchImpl }), 0);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'mac-meta.json'), 'utf8'));
  assert.equal(meta.found, true);
  assert.equal(meta.body, true);
  assert.equal(fs.readFileSync(path.join(dir, 'mac.html'), 'utf8'), '<p>hi</p>');

  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-cmp-'));
  await cmp.fetchMac({ outDir: dir2, apiKey: 'k', ownerEmail: 'o@x', now: NOW, listImpl, fetchImpl: async () => ({ ok: false, status: 404 }) });
  const m2 = JSON.parse(fs.readFileSync(path.join(dir2, 'mac-meta.json'), 'utf8'));
  assert.equal(m2.body, false);
  assert.match(m2.reason, /404/);

  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-cmp-'));
  assert.equal(await cmp.fetchMac({ outDir: dir3, apiKey: 'k', ownerEmail: 'o@x', now: NOW, listImpl: async () => [] }), 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir3, 'mac-meta.json'), 'utf8')).found, false);
  assert.equal(await cmp.fetchMac({ outDir: dir3, apiKey: 'k', ownerEmail: 'o@x', now: NOW, listImpl: async () => { throw new Error('down'); } }), 2);
});

test('sealedBlock round-trips through sealed-output and the run-script extractor', () => {
  const { generateKeyPair, open } = require('../../scripts/lib/sealed-output.js');
  const { extractOutput } = require('../../scripts/cloud-run-script.js');
  const { publicKey, privateKey } = generateKeyPair();
  const block = cmp.sealedBlock('only in Mac: x', Buffer.from(publicKey).toString('base64'));
  assert.doesNotMatch(block, /only in Mac/);
  const { found, output } = extractOutput(`2026-10-25T00:00:00.0000000Z noise\n${block}\n`);
  assert.ok(found);
  assert.equal(open(JSON.parse(output.replace(/\n/g, '')), privateKey), 'only in Mac: x');
  assert.throws(() => cmp.sealedBlock('x', Buffer.from('nope').toString('base64')), /PEM/);
});

test('markTrackedReportOnly: open card (exact or number-free title) reads tracked, nothing else moves', () => {
  const { markTrackedReportOnly } = require('../../scripts/lib/digest-autofix.js');
  const plan = () => [
    { title: 'Stale grosses: 3 shows', state: 'needs-card' },
    { title: 'Cron failed: X', state: 'needs-card' },
    { title: 'Owner call', state: 'decision' },
  ];
  const rows = markTrackedReportOnly(plan(), new Set(['Stale grosses: 5 shows']));
  assert.deepEqual(rows.map((r) => r.state), ['tracked', 'needs-card', 'decision']);
  assert.deepEqual(markTrackedReportOnly(plan(), null).map((r) => r.state), ['needs-card', 'needs-card', 'decision']);
  assert.deepEqual(markTrackedReportOnly(null, new Set(['a'])), []);
});

test('--no-autofix plans and marks tracked but never calls runAutofix or the canary', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/send-morning-digest.js'), 'utf8');
  const i = src.indexOf('if (noAutofix) try {');
  assert.ok(i > 0);
  const branch = src.slice(i, src.indexOf('else try {', i));
  assert.match(branch, /markTrackedReportOnly\(planAutofix\(/);
  assert.doesNotMatch(branch, /runAutofix\(|fileCard|dispatch\w*\(/);
  assert.match(src, /if \(!noAutofix\) try \{\s*const \{ runAutofixCanary \}/);
});

test('report-only email says no fix was started; the Mac email keeps its queued wording', () => {
  const { buildHtml } = require(path.join(ROOT, 'scripts/send-morning-digest.js'));
  const rows = [{ state: 'needs-card', title: 'X broken', severity: 'error' }];
  const sections = { health: { errors: [{ name: 'X broken', message: 'm' }], warnings: [], queued: [] } };
  const ro = buildHtml({ sections, autofixRows: rows, reportOnly: true, loopDeadMsg: '' });
  assert.match(ro, /did not start any automatic fix/);
  assert.doesNotMatch(ro, /queued for automated fix/);
  const mac = buildHtml({ sections, autofixRows: rows, loopDeadMsg: '' });
  assert.match(mac, /all queued for automated fix sessions/);
  assert.doesNotMatch(mac, /did not start any automatic fix/);
});

test('pager: heartbeat step runs even when the digest check went red', () => {
  const pager = read('.github/workflows/check-morning-digest-sent.yml');
  assert.match(pager, /name: Check the Mac heartbeat[^\n]*\n {8}if: always\(\)/);
});

// ── handoff + test-send (BRO-6764) ──────────────────────────────────────────
test('handoff: one date; the Mac stops sending on and after it (autofix-only), before it the Mac sends', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-')), 'h.json');
  fs.writeFileSync(f, JSON.stringify({ handoffDate: '2026-11-02' }));
  assert.equal(handoff.actionOwnsToday(new Date('2026-11-02T05:00:00Z'), f), true, '05:00Z = 00:00 EST of 11-02');
  assert.equal(handoff.actionOwnsToday(new Date('2026-11-02T04:59:00Z'), f), false);
  assert.equal(handoff.actionOwnsToday(new Date('2026-11-02T12:33:00Z'), f), true, 'Mac 07:30 ET slot runs autofix only');
  assert.equal(handoff.actionOwnsToday(new Date('2026-11-01T12:33:00Z'), f), false);
  fs.writeFileSync(f, JSON.stringify({ handoffDate: 'soon' }));
  assert.throws(() => handoff.handoffDate(f));
});

test('test-send: TEST subject, no guards, no sent-state or snapshot write', () => {
  const src = read('scripts/send-morning-digest.js');
  assert.match(src, /subject: testSend \? `TEST: \$\{subject\}` : subject,/);
  assert.match(src, /resendSentGuard = !!args\['resend-sent-guard'\] && !testSend/);
  assert.match(src, /if \(!args\.force && !testSend\) \{\n\s+const prev = sentState\[sendTo\]/);
  const iTest = src.indexOf("sent-state and board snapshot left untouched");
  assert.ok(iTest > 0 && iTest < src.indexOf('saveBoardTableSnapshot(boardTable.report)'));
  assert.match(WF, /if \[ "\$IS_TEST" = "true" \]; then MODE="--test-send"; else MODE="--resend-sent-guard"; fi/);
});

// ── catch-up pre-check (digest-sent-precheck.js) ────────────────────────────
const precheckMod = require('../../scripts/digest-sent-precheck.js');
test('precheck: go only when no digest to the owner exists yet today; fails closed', async () => {
  const now = new Date('2026-11-03T13:30:00Z');
  const base = { apiKey: 're_test', recipient: 'owner@example.com', now };
  const none = await precheckMod.precheck({ ...base, fetchEmails: async () => [] });
  assert.equal(none.go, true, JSON.stringify(none));
  const sent = await precheckMod.precheck({ ...base, fetchEmails: async () => [{ to: ['owner@example.com'], subject: 'Morning digest, Tue Nov 3', created_at: '2026-11-03T12:55:00Z', last_event: 'delivered' }] });
  assert.equal(sent.go, false, JSON.stringify(sent));
  const boom = await precheckMod.precheck({ ...base, fetchEmails: async () => { throw new Error('resend down'); } });
  assert.equal(boom.go, false, 'cannot tell means skip, never double-send');
  const nokey = await precheckMod.precheck({ ...base, apiKey: '', fetchEmails: async () => [] });
  assert.equal(nokey.go, false);
  assert.equal(precheckMod.goFromVerdict('already-sent'), false);
  assert.equal(precheckMod.goFromVerdict('cannot-tell'), false);
});
