// TESTS-VS-DERIVED-DATA-EXEMPT: shows.json only supplies a real show id per market for the CLI; no factual value is pinned.
// BRO-6620 (cutover card 6): LANE_ONLY_MARKETS stands the old path's press-night roles down for listed markets
// while a lane holds the night, and brings them back on any doubt. Requires the real decision functions, runs the
// real CLI in a subprocess against temp files, and pins the workflow wiring by reading the real YAML.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const lom = require('../../scripts/lib/opening-night-lane/lane-only-markets.js');
const { parseStanddown, standsDown } = require('../../scripts/lib/opening-night-lane/standdown.js');
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');

// Broadway's 2026-11-05 opening: market embargo 22:00 New York = 2026-11-06T03:00Z, window [00:00Z, 09:00Z].
const BWAY = { id: 'bway-show', market: 'broadway', category: 'broadway', openingDate: '2026-11-05' };
const OFFB = { id: 'offb-show', market: 'broadway', category: 'off-broadway', openingDate: '2026-11-05' };
const WE = { id: 'we-show', market: 'west-end', category: 'west-end', openingDate: '2026-11-05' };
const OWE = { id: 'owe-show', market: 'west-end', category: 'off-west-end', openingDate: '2026-11-05' };
const NOW = '2026-11-06T03:30:00Z';
const lease = (show, night = '2026-11-05', holder = 'gha-1', expiresAt = '2026-11-06T04:00:00Z') =>
  ({ leases: { [`${show}|${night}`]: { holder, acquiredAt: '2026-11-06T01:00:00Z', heartbeatAt: '2026-11-06T03:29:00Z', expiresAt } } });
const ok = (value) => ({ ok: true, value });
const base = (over = {}) => ({
  onlyMarkets: ok('broadway'), standdown: ok(''), show: BWAY, leaseState: lease('bway-show'), markers: {}, now: NOW, ...over,
});
const decide = (over) => lom.oldPathStandsDown(base(over));

test('(a) a listed market with a live lane lease in the press-night window stands the old path down', () => {
  const d = decide();
  assert.equal(d.standDown, true, d.reason);
  assert.equal(d.holder, 'gha-1');
  assert.equal(d.night, '2026-11-05');
});

test('market matching follows LANE_STANDDOWN: broadway covers Off-Broadway, off-broadway covers only itself', () => {
  const offbLease = lease('offb-show');
  assert.equal(decide({ show: OFFB, leaseState: offbLease }).standDown, true);
  assert.equal(decide({ onlyMarkets: ok('off-broadway'), show: OFFB, leaseState: offbLease }).standDown, true);
  assert.equal(decide({ onlyMarkets: ok('off-broadway') }).standDown, false, 'off-broadway must not cover Broadway');
  assert.equal(decide({ onlyMarkets: ok('west-end'), show: OWE, leaseState: lease('owe-show', '2026-11-05', 'gha-1', '2026-11-05T22:00:00Z'), now: '2026-11-05T21:30:00Z' }).standDown, true);
  assert.equal(decide({ onlyMarkets: ok('west-end') }).standDown, false, 'west-end must not cover Broadway');
  assert.equal(decide({ onlyMarkets: ok(' Broadway ; West End ') }).standDown, true, 'case, spaces and ; separators');
  // Same tokens, same answer as LANE_STANDDOWN for every market/category pairing.
  for (const v of ['broadway', 'off-broadway', 'west-end', 'off-west-end']) {
    for (const s of [BWAY, OFFB, WE, OWE]) {
      const t = lom.parseOnlyMarkets(v).tokens;
      assert.equal([s.market, s.category].some((x) => t.has(x)), standsDown(v, s), `${v} vs ${s.category}`);
    }
  }
});

test('the old path stays on for other markets (suppression is per market)', () => {
  assert.equal(decide({ show: WE, leaseState: lease('we-show') }).standDown, false);
});

test('a typo or "all" matches nothing, unlike LANE_STANDDOWN where it means everything', () => {
  for (const v of ['broadwy', 'all', '*', 'everything, broadwy']) {
    const d = decide({ onlyMarkets: ok(v) });
    assert.equal(d.standDown, false, v);
    assert.ok(lom.parseOnlyMarkets(v).unknown.length > 0, `${v} is reported as unknown`);
  }
  assert.equal(parseStanddown('broadwy').all, true, 'LANE_STANDDOWN keeps its fail-toward-stand-down rule');
  assert.equal(decide({ onlyMarkets: ok('broadwy, broadway') }).standDown, true, 'a typo next to a real token keeps the real one');
});

test('(b) emptying the variable restores the old path', () => {
  for (const v of ['', ' ', 'off', 'none', '0', 'false']) assert.equal(decide({ onlyMarkets: ok(v) }).standDown, false, JSON.stringify(v));
});

test('(c) a failed variable read keeps the old path on', () => {
  assert.equal(decide({ onlyMarkets: { ok: false, value: '' } }).standDown, false);
  assert.equal(decide({ onlyMarkets: undefined }).standDown, false);
  assert.match(decide({ onlyMarkets: { ok: false } }).reason, /unreadable/);
  // LANE_STANDDOWN unread: we cannot rule out that the lane is stood down, so the old path stays on.
  assert.equal(decide({ standdown: { ok: false, value: '' } }).standDown, false);
});

test('LANE_STANDDOWN covering the show restores the old path', () => {
  assert.equal(decide({ standdown: ok('broadway') }).standDown, false);
  assert.equal(decide({ standdown: ok('all') }).standDown, false);
  assert.equal(decide({ standdown: ok('west-end') }).standDown, true);
});

test('(b) no live lease, an expired lease or an unknown lease state keeps the old path on', () => {
  assert.equal(decide({ leaseState: { leases: {} } }).standDown, false);
  assert.equal(decide({ leaseState: lease('bway-show', '2026-11-05', 'gha-1', '2026-11-06T03:00:00Z') }).standDown, false, 'expired');
  assert.equal(decide({ leaseState: lease('bway-show', '2026-11-05', 'gha-1', 'garbage') }).standDown, false, 'unparsable expiry');
  assert.equal(decide({ leaseState: { leases: {}, unknown: true } }).standDown, false, 'sync failed');
  assert.equal(decide({ leaseState: { ...lease('bway-show'), unknown: true } }).standDown, false, 'unknown wins over a stale lease entry');
  assert.equal(decide({ leaseState: null }).standDown, false, 'unreadable');
  assert.equal(decide({ leaseState: lease('other-show') }).standDown, false, 'lease on another show');
});

test('window edges: [embargo - 3h, embargo + 6h] for the lease night', () => {
  const at = (now, exp = '2026-11-07T00:00:00Z') => decide({ now, leaseState: lease('bway-show', '2026-11-05', 'gha-1', exp) }).standDown;
  assert.equal(at('2026-11-06T00:00:00Z'), true, 'opens 3h before');
  assert.equal(at('2026-11-05T23:59:59Z'), false, 'before');
  assert.equal(at('2026-11-06T09:00:00Z'), true, 'closes 6h after');
  assert.equal(at('2026-11-06T09:00:01Z'), false, 'after');
});

test('the window follows a valid reviewEmbargoAt override on the opening night, and the market hour on other nights', () => {
  const withOverride = { ...BWAY, reviewEmbargoAt: '2026-11-05T19:00:00-05:00' }; // 00:00Z
  const s = (show, now, night = '2026-11-05') => decide({ show, now, leaseState: lease('bway-show', night, 'gha-1', '2026-11-08T00:00:00Z') }).standDown;
  assert.equal(s(withOverride, '2026-11-05T21:00:00Z'), true, 'override embargo 00:00Z opens the window at 21:00Z');
  assert.equal(s(BWAY, '2026-11-05T21:00:00Z'), false, 'market default opens at 00:00Z');
  assert.equal(s(BWAY, '2026-11-07T03:00:00Z', '2026-11-06'), true, 'a lease on another night uses that night at the market hour');
  assert.equal(lom.inPressNightWindow({ ...BWAY, category: 'nowhere' }, '2026-11-05', Date.parse(NOW)), false, 'no embargo = no window = old path on');
});

test('(b) the lane\'s exit-3 marker restores the old path, but only for the live lease holder', () => {
  const key = lom.markerKey('bway-show', '2026-11-05');
  assert.equal(decide({ markers: { [key]: { holder: 'gha-1' } } }).standDown, false, 'same holder stood down');
  assert.equal(decide({ markers: { [key]: { holder: 'mac-2' } } }).standDown, true, 'a second starter\'s held-by-other exit leaves the first one publishing');
  assert.equal(decide({ markers: { [lom.markerKey('bway-show', '2026-11-04')]: { holder: 'gha-1' } } }).standDown, true, 'another night\'s marker');
  assert.equal(decide({ markers: null }).standDown, false, 'unreadable markers');
});

test('markers: writeMarker/readMarkers round trip; missing dir = none; an unreadable file = old path on', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lom-'));
  const md = path.join(dir, 'm');
  assert.deepEqual(lom.readMarkers(md), {});
  const file = lom.writeMarker({ show: 'bway-show', night: '2026-11-05', holder: 'gha-1', runId: '9', at: '2026-11-06T03:10:00Z', dir: md });
  assert.equal(path.basename(file), 'bway-show__2026-11-05.json');
  const m = lom.readMarkers(md);
  assert.deepEqual(m['bway-show__2026-11-05'], { show: 'bway-show', night: '2026-11-05', holder: 'gha-1', exit: 3, runId: '9', at: '2026-11-06T03:10:00Z' });
  assert.equal(decide({ markers: m }).standDown, false);
  fs.writeFileSync(path.join(md, 'bad-show__2026-11-05.json'), '{not json');
  const m2 = lom.readMarkers(md);
  assert.deepEqual(m2['bad-show__2026-11-05'], { unreadable: true }, 'a bad file is unreadable under its own key');
  assert.equal(m2['bway-show__2026-11-05'].holder, 'gha-1', 'one bad file does not hide the other markers');
  assert.equal(decide({ markers: { [lom.markerKey('bway-show', '2026-11-05')]: { unreadable: true } } }).standDown, false, 'own marker unreadable = old path on');
  assert.equal(decide({ markers: { [lom.markerKey('other-show', '2026-11-05')]: { unreadable: true } } }).standDown, true, 'another show\'s bad marker does not touch this one');
  assert.throws(() => lom.writeMarker({ show: '../x', night: '2026-11-05', holder: 'h', dir: md }));
  assert.throws(() => lom.writeMarker({ show: 'x', night: 'tonight', holder: 'h', dir: md }));
  assert.throws(() => lom.writeMarker({ show: 'x', night: '2026-11-05', holder: '', dir: md }));
});

test('changedShowIds: show dirs from git status --porcelain inside review-texts', () => {
  const porcelain = [
    ' M bway-show/nyt.json',
    '?? new-show/variety.json',
    'R  old-name/a.json -> renamed-show/a.json',
    '?? "quoted-show/a b.json"',
    ' M README.md',
    '?? .hidden/x.json',
    '',
  ].join('\n');
  assert.deepEqual(lom.changedShowIds(porcelain).sort(), ['README.md', 'bway-show', 'new-show', 'quoted-show', 'renamed-show'].sort());
  assert.deepEqual(lom.changedShowIds(''), []);
  assert.deepEqual(lom.changedShowIds(undefined), []);
});

test('readLeaseState: missing file = no leases, corrupt = unknown, unknown marker passes through', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lom-'));
  assert.deepEqual(lom.readLeaseState(path.join(dir, 'none.json')), { leases: {} });
  fs.writeFileSync(path.join(dir, 'bad.json'), 'x');
  assert.equal(lom.readLeaseState(path.join(dir, 'bad.json')), null);
  fs.writeFileSync(path.join(dir, 'u.json'), '{"leases":{},"unknown":true}');
  assert.equal(lom.readLeaseState(path.join(dir, 'u.json')).unknown, true);
});

test('pollerSuppress: only when every action show stands down', () => {
  const yes = () => ({ standDown: true, reason: 'y' });
  const by = (set) => (id) => ({ standDown: set.has(id), reason: '' });
  assert.equal(lom.pollerSuppress([], yes).suppress, false, 'nothing to do = nothing to gate');
  assert.equal(lom.pollerSuppress(['a', 'a'], yes).suppress, true);
  assert.equal(lom.pollerSuppress(['a', 'b'], by(new Set(['a']))).suppress, false, 'mixed run publishes');
  assert.equal(lom.pollerSuppress(['a', 'b'], by(new Set(['a', 'b']))).suppress, true);
});

test('envInputs reads the _READ=ok markers from read-lane-only-vars', () => {
  const e = lom.envInputs({ LANE_ONLY_MARKETS: 'broadway', LANE_ONLY_MARKETS_READ: 'ok', LANE_STANDDOWN: '', LANE_STANDDOWN_READ: 'unknown' });
  assert.deepEqual(e, { onlyMarkets: { ok: true, value: 'broadway' }, standdown: { ok: false, value: '' } });
  assert.equal(lom.envInputs({ LANE_ONLY_MARKETS: 'broadway' }).onlyMarkets.ok, false, 'no _READ = not read');
});

// --- the real CLI, against temp lease and marker files ---
// Core data is gitignored (private repo): without it the CLI tests below skip instead of failing the whole file.
const shows = fs.existsSync(path.join(repo, 'data/shows.json')) ? JSON.parse(read('data/shows.json')) : [];
const showList = Array.isArray(shows.shows) ? shows.shows : shows;
const realBway = showList.find((s) => s.market === 'broadway' && s.category === 'broadway' && !s.reviewEmbargoAt);
const realWe = showList.find((s) => s.market === 'west-end' && s.category === 'west-end' && !s.reviewEmbargoAt);

function runCli(args, { only = 'broadway', onlyRead = 'ok', standdownRead = 'ok', leases } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lom-cli-'));
  const leasesFile = path.join(dir, 'leases.json');
  if (leases) fs.writeFileSync(leasesFile, JSON.stringify(leases));
  const out = path.join(dir, 'out');
  fs.writeFileSync(out, '');
  const r = spawnSync(process.execPath, ['scripts/lane-only-markets.js', ...args, `--markers-dir=${path.join(dir, 'markers')}`], {
    cwd: repo, encoding: 'utf8',
    env: { ...process.env, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: path.join(dir, 'sum'), OPENING_NIGHT_LEASES_FILE: leasesFile,
      LANE_ONLY_MARKETS: only, LANE_ONLY_MARKETS_READ: onlyRead, LANE_STANDDOWN: '', LANE_STANDDOWN_READ: standdownRead },
  });
  return { ...r, output: fs.readFileSync(out, 'utf8'), dir };
}
const night = '2026-11-05';
const cliNow = '--now=2026-11-06T03:30:00Z'; // inside Broadway's window for a non-opening night (market hour)

test('CLI gate writes suppress=true only for a lane-held listed market', { skip: !realBway && 'no Broadway show in data (core data absent?)' }, () => {
  const held = lease(realBway.id, night, 'gha-7', '2026-11-06T04:00:00Z');
  const r = runCli(['gate', `--shows=${realBway.id}`, cliNow], { leases: held });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.output.trim(), 'suppress=true', r.stdout);
  assert.match(r.stdout, /::notice::Lane-only markets/);
  assert.equal(runCli(['gate', `--shows=${realBway.id}`, cliNow], { leases: held, onlyRead: 'unknown' }).output.trim(), 'suppress=false', '(c) read failed');
  assert.equal(runCli(['gate', `--shows=${realBway.id}`, cliNow], { leases: held, only: '' }).output.trim(), 'suppress=false', '(b) emptied');
  assert.equal(runCli(['gate', `--shows=${realBway.id}`, cliNow], { leases: held, only: 'west-end' }).output.trim(), 'suppress=false', 'other market listed');
  assert.equal(runCli(['gate', `--shows=${realBway.id}`, cliNow], {}).output.trim(), 'suppress=false', 'no lease file');
  assert.equal(runCli(['gate', '--shows=', cliNow], { leases: held }).output.trim(), 'suppress=false', 'no action shows');
  const typo = runCli(['gate', `--shows=${realBway.id}`, cliNow], { leases: held, only: 'broadwy' });
  assert.equal(typo.output.trim(), 'suppress=false');
  assert.match(typo.stdout, /::warning::LANE_ONLY_MARKETS has entries/);
  if (realWe) {
    const mixed = { leases: { ...held.leases, ...lease(realWe.id, night, 'gha-8', '2026-11-06T04:00:00Z').leases } };
    assert.equal(runCli(['gate', `--shows=${realBway.id},${realWe.id}`, cliNow], { leases: mixed }).output.trim(), 'suppress=false', 'mixed run publishes');
  }
});

test('CLI mark then gate: the lane\'s own exit 3 brings the old path back', { skip: !realBway && 'no Broadway show in data (core data absent?)' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lom-mark-'));
  const markers = path.join(dir, 'markers');
  const leasesFile = path.join(dir, 'leases.json');
  fs.writeFileSync(leasesFile, JSON.stringify(lease(realBway.id, night, 'gha-7', '2026-11-06T04:00:00Z')));
  const env = { ...process.env, GITHUB_OUTPUT: path.join(dir, 'out'), OPENING_NIGHT_LEASES_FILE: leasesFile,
    LANE_ONLY_MARKETS: 'broadway', LANE_ONLY_MARKETS_READ: 'ok', LANE_STANDDOWN: '', LANE_STANDDOWN_READ: 'ok' };
  const cli = (...a) => spawnSync(process.execPath, ['scripts/lane-only-markets.js', ...a, `--markers-dir=${markers}`], { cwd: repo, encoding: 'utf8', env });
  const other = cli('mark', `--show=${realBway.id}`, `--night=${night}`, '--holder=mac-9');
  assert.equal(other.status, 0, other.stdout + other.stderr);
  fs.writeFileSync(env.GITHUB_OUTPUT, '');
  cli('gate', `--shows=${realBway.id}`, cliNow);
  assert.equal(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8').trim(), 'suppress=true', 'another starter\'s marker does not end the holder\'s night');
  const own = cli('mark', `--show=${realBway.id}`, `--night=${night}`, '--holder=gha-7', '--run-id=7');
  assert.equal(own.status, 0, own.stdout + own.stderr);
  fs.writeFileSync(env.GITHUB_OUTPUT, '');
  const g = cli('gate', `--shows=${realBway.id}`, cliNow);
  assert.equal(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8').trim(), 'suppress=false', g.stdout);
  assert.match(g.stdout, /stood down \(exit 3\)/);
  assert.equal(cli('mark', '--show=../x', `--night=${night}`, '--holder=h').status, 1, 'a marker that cannot be written fails its (continue-on-error) step');
});

// --- workflow and Express wiring ---
const stepsOf = (yml, job) => {
  const body = yml.split(new RegExp(`^  ${job}:\\n`, 'm'))[1].split(/^  [a-z][\w-]*:\n/m)[0];
  return body.split(/^      - /m).slice(1).map((b) => ({ body: b, name: (b.match(/name: (.+)/) || [])[1] || '', id: (b.match(/^\s+id: (\S+)/m) || [])[1], cond: (b.match(/^\s+if: (.+)/m) || [])[1] || '' }));
};

test('CLI gate --changed-dir: a show the drain changed this run keeps the rebuild on; a bad dir keeps it on', { skip: !realBway && 'no Broadway show in data (core data absent?)' }, () => {
  const held = lease(realBway.id, night, 'gha-7', '2026-11-06T04:00:00Z');
  const rt = fs.mkdtempSync(path.join(os.tmpdir(), 'lom-rt-'));
  const git = (...a) => spawnSync('git', ['-C', rt, ...a], { encoding: 'utf8' });
  git('init', '-q');
  fs.mkdirSync(path.join(rt, realBway.id));
  fs.writeFileSync(path.join(rt, realBway.id, 'a.json'), '{}');
  const own = runCli(['gate', `--shows=${realBway.id}`, `--changed-dir=${rt}`, cliNow], { leases: held });
  assert.equal(own.output.trim(), 'suppress=true', 'only the held show changed: still suppressed ' + own.stdout + own.stderr);
  fs.mkdirSync(path.join(rt, 'drained-show'));
  fs.writeFileSync(path.join(rt, 'drained-show', 'b.json'), '{}');
  const dirty = runCli(['gate', `--shows=${realBway.id}`, `--changed-dir=${rt}`, cliNow], { leases: held });
  assert.equal(dirty.output.trim(), 'suppress=false', 'a drained non-held show publishes ' + dirty.stdout);
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'lom-norepo-'));
  const bad = runCli(['gate', `--shows=${realBway.id}`, `--changed-dir=${notRepo}`, cliNow], { leases: held });
  assert.equal(bad.status, 0);
  assert.equal(bad.output.trim(), 'suppress=false', 'git status failed = old path on ' + bad.stdout);
  assert.equal(runCli(['gate', `--shows=${realBway.id}`, `--changed-dir=${path.join(notRepo, 'missing')}`, cliNow], { leases: held }).output.trim(), 'suppress=false', 'missing dir');
});

test('(c) read-lane-only-vars reads both variables with the token it is given and marks failed reads unknown', () => {
  const a = read('.github/actions/read-lane-only-vars/action.yml');
  assert.match(a, /read-actions-variable\.sh/);
  assert.match(a, /VARS_TOKEN: \$\{\{ inputs\.token \}\}/);
  assert.match(a, /GH_TOKEN="\$VARS_TOKEN"/);
  assert.match(a, /for NAME in LANE_ONLY_MARKETS LANE_STANDDOWN/);
  assert.match(a, /READ=unknown\n\s+VALUE=""/, 'a failed read (exit 3) is unknown with no value');
  assert.match(a, /\$\{NAME\}_READ=\$\{READ\}/);
});

test('(a)(c) poller: lease re-sync, variables read with REVIEW_TEXTS_TOKEN, gate before rebuild/deploy, picks still rebuild', () => {
  const yml = read('.github/workflows/opening-night-poller.yml');
  const jobs = yml.split(/^jobs:\n/m)[1];
  const job = jobs.match(/^  ([a-z][\w-]*):\n/m)[1];
  const steps = stepsOf(yml, job);
  const i = (n) => steps.findIndex((s) => s.name === n);
  const sync = i('Lease re-sync for the lane-only gate (BRO-6620)');
  const vars = i('Read lane-only variables (BRO-6620)');
  const gate = steps.findIndex((s) => s.id === 'lane_only');
  const drift = i('Sync review-texts drift before rebuild');
  const fast = steps.findIndex((s) => s.id === 'fast_rebuild');
  const legacy = i('Trigger rebuild + deploy (legacy)');
  assert.ok(sync >= 0 && vars > sync && gate > vars && drift > gate && fast > drift, `order ${sync} ${vars} ${gate} ${drift} ${fast}`);
  for (const k of [sync, vars, gate]) assert.match(steps[k].body, /continue-on-error: true/, steps[k].name);
  assert.match(steps[sync].body, /opening-night-lease\.js sync/);
  assert.match(steps[vars].body, /secrets\.REVIEW_TEXTS_TOKEN/);
  assert.doesNotMatch(steps[vars].body, /GITHUB_TOKEN/);
  assert.match(steps[gate].body, /lane-only-markets\.js gate/);
  assert.match(steps[gate].body, /--changed-dir=data\/review-texts/, 'shows the drain changed this run count as action shows');
  const cond = /steps\.lane_only\.outputs\.suppress != 'true' \|\| steps\.nyt_picks\.outputs\.picks_added == 'true'/;
  assert.match(steps[drift].cond, cond);
  assert.match(steps[fast].cond, cond);
  assert.ok(legacy >= 0);
  assert.match(steps[legacy].cond, /steps\.lane_only\.outputs\.suppress != 'true'/);
  assert.match(yml, /action_shows=\$\{ACTION_SHOWS#,\}/);
});

test('(a)(c) Express retry-check syncs leases and reads the variables before dispatching', () => {
  const yml = read('.github/workflows/opening-night-express-retry-check.yml');
  const job = yml.split(/^jobs:\n/m)[1].match(/^  ([a-z][\w-]*):\n/m)[1];
  const steps = stepsOf(yml, job);
  const i = (re) => steps.findIndex((s) => re.test(s.name));
  const sync = steps.findIndex((s) => /opening-night-lease-sync/.test(s.body));
  const vars = i(/Read lane-only variables/);
  const dispatch = i(/Dispatch due retries/);
  assert.ok(sync >= 0 && vars > sync && dispatch > vars, `order ${sync} ${vars} ${dispatch}`);
  assert.match(steps[vars].body, /secrets\.REVIEW_TEXTS_TOKEN/);
});

test('(a) Express retry dispatch holds lane-only shows without marking them attempted; a failed check dispatches', () => {
  const src = read('scripts/express-retry-queue.js');
  const fn = src.slice(src.indexOf('async function cmdDispatchDue'));
  const held = fn.indexOf('const laneHeld = laneHoldCheck();');
  assert.ok(held > 0);
  const thin = fn.indexOf('if (laneHeld(entry.showId)) continue;');
  assert.ok(thin > held && thin < fn.indexOf('dispatchExpressRetry(entry.showId'), 'thin-coverage loop checks before dispatching');
  const refetch = fn.indexOf('} else if (laneHeld(showId)) {');
  assert.ok(refetch > held, 'refetch loop checks too');
  assert.match(fn.slice(refetch, refetch + 80), /continue;/, 'held entries are skipped, not marked attempted');
  const check = src.slice(src.indexOf('function laneHoldCheck'), src.indexOf('async function cmdDispatchDue'));
  assert.match(check, /return \(\) => false;/, 'decider construction failure dispatches as usual');
  assert.match(check, /return false;/, 'a per-show decide error dispatches as usual');
  // Manual Express runs and the day-after fire do not go through this queue.
  assert.doesNotMatch(read('.github/workflows/opening-night-express.yml'), /lane-only-markets/);
});

test('(b) lane-live writes the explicit marker on exit 3, from the step output, on main only', () => {
  const steps = stepsOf(read('.github/workflows/opening-night-lane-live.yml'), 'night');
  const lane = steps.findIndex((s) => s.name === 'Run the lane');
  const mark = steps.findIndex((s) => s.name === 'Record lane stood down (BRO-6620)');
  assert.ok(lane >= 0 && mark > lane);
  const m = steps[mark];
  assert.match(m.cond, /always\(\) && steps\.lane\.outputs\.exit == '3'/);
  assert.match(m.cond, /github\.ref == 'refs\/heads\/main'/);
  assert.match(m.body, /continue-on-error: true/);
  assert.match(m.body, /lane-only-markets\.js mark .*--holder=\$\{OPENING_NIGHT_LANE_HOLDER\}/);
  assert.match(m.body, /git add data\/opening-night\/lane-stood-down\//);
  assert.match(m.body, /push-with-retry\.sh 5 main/);
  assert.match(steps[lane].body, /echo "exit=\$\{RC\}" >> "\$GITHUB_OUTPUT"/);
});

test('the marker directory is committed, not gitignored', () => {
  const r = spawnSync('git', ['check-ignore', '-q', 'data/opening-night/lane-stood-down/x__2026-11-05.json'], { cwd: repo });
  assert.equal(r.status, 1, 'git check-ignore must not match the marker path');
});

// --- plan v2 step 2: a lane exit 3 inside the press window pages ---
test('standDownPage: exit 3 pages inside [embargo - 3h, embargo + 6h], a notice outside, and pages when it cannot tell', () => {
  const p = (now, show = BWAY, n = '2026-11-05') => lom.standDownPage({ show, night: n, now }).page;
  assert.equal(p('2026-11-06T00:00:00Z'), true, 'window opens 3h before the 03:00Z embargo');
  assert.equal(p('2026-11-06T09:00:00Z'), true, 'window closes 6h after');
  assert.equal(p('2026-11-05T23:59:59Z'), false, 'before the window: notice');
  assert.equal(p('2026-11-06T09:00:01Z'), false, 'after the window: notice');
  assert.equal(p('2026-11-06T03:00:00Z', null), true, 'unknown show pages');
  assert.equal(p('2026-11-06T03:00:00Z', BWAY, 'tonight'), true, 'bad night pages');
  assert.equal(p('2026-11-06T03:00:00Z', { ...BWAY, category: 'nowhere', market: 'nowhere' }), true, 'unknown embargo pages');
});

test('CLI stood-down: pages (dry run) inside the window, a notice outside, never a page outside', { skip: !realBway && 'no Broadway show in data (core data absent?)' }, () => {
  const run = (now) => spawnSync(process.execPath, ['scripts/lane-only-markets.js', 'stood-down', `--show=${realBway.id}`, `--night=${night}`, `--now=${now}`, '--dry-run'], { cwd: repo, encoding: 'utf8' });
  const inside = run('2026-11-06T03:30:00Z');
  assert.equal(inside.status, 0, inside.stdout + inside.stderr);
  assert.match(inside.stdout, /::error::opening-night lane stood down/);
  assert.match(inside.stdout, /page=dry-run/);
  const outside = run('2026-11-05T12:00:00Z');
  assert.equal(outside.status, 0);
  assert.match(outside.stdout, /::notice::.*no page/);
  assert.doesNotMatch(outside.stdout, /page=/);
});

test('lane-live pages on exit 3 after the marker, on main, with the run URL, and does not swallow a failed page', () => {
  const steps = stepsOf(read('.github/workflows/opening-night-lane-live.yml'), 'night');
  const mark = steps.findIndex((s) => s.name === 'Record lane stood down (BRO-6620)');
  const pg = steps.findIndex((s) => s.name === 'Page if the lane stood down inside the press window (BRO-6620)');
  const ledger = steps.findIndex((s) => s.name === 'Commit alert ledger');
  assert.ok(mark >= 0 && pg > mark && ledger > pg, 'page after the marker, before the alert ledger commit');
  const s = steps[pg];
  assert.match(s.cond, /always\(\) && steps\.lane\.outputs\.exit == '3'/);
  assert.match(s.cond, /github\.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(s.body, /continue-on-error/);
  assert.match(s.body, /lane-only-markets\.js stood-down "--show=\$\{SHOW\}" "--night=\$\{NIGHT\}" "--run-url=\$\{RUN_URL\}"/);
  const release = steps.findIndex((s2) => s2.name === 'Release night lease');
  assert.ok(release > pg && /always\(\)/.test(steps[release].cond), 'the lease release still runs on exit 3');
});
