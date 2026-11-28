// BRO-3889: scripts/check-alert-condition-absent.js exit contract — 0 not
// firing, 1 firing, 2 usage, 3 cannot tell (never a vacuous pass). Runs the
// REAL script as a child process against throwaway ledgers via
// ALERT_LEDGER_PATH (the router's own override), so the tracked
// data/audit/alert-ledger.json is never read or touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { realNowMs } from '../helpers/clock-shift.mjs';

const require = createRequire(import.meta.url);
const SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'scripts', 'check-alert-condition-absent.js');
const { alertAbsentCheckCmd } = require('../../scripts/lib/health-row-check-cmd.js');
const { QUIET_WINDOW_H } = require('../../scripts/check-alert-condition-absent.js');

const H = 36e5;
// Stamps are read by a child process that runs on the REAL clock (the clock-shift
// preload is not inherited), so stamp from the real clock too or a +Nd audit shift
// makes every ledger entry look future-dated.
const iso = (hoursAgo) => new Date(realNowMs() - hoursAgo * H).toISOString();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-absent-'));

function writeLedger(name, conditions) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, typeof conditions === 'string' ? conditions : JSON.stringify({ conditions }));
  return p;
}

// Run exactly the command the router writes into the card.
function run(ledgerPath, conditionKey) {
  const argv = alertAbsentCheckCmd(conditionKey).split(' ').slice(2);
  return spawnSync(process.execPath, [SCRIPT, ...argv], {
    env: { ...process.env, ALERT_LEDGER_PATH: ledgerPath }, encoding: 'utf8',
  });
}

const FRESH = { 'heartbeat:x': { status: 'open', lastSeen: iso(1) } };
const ledger = writeLedger('ledger.json', {
  ...FRESH,
  'cron-health-chronic:Firing Cron': { status: 'open', lastSeen: iso(5) },
  'gap:resolved-show/nytimes--a.json': { status: 'resolved', lastSeen: iso(400), resolvedAt: iso(300) },
  'backstop:quiet': { status: 'open', lastSeen: iso(QUIET_WINDOW_H + 24) },
  'land:refired-after-resolve': { status: 'resolved', lastSeen: iso(2), resolvedAt: iso(10) },
  'odd:status': { status: 'snoozed', lastSeen: iso(2) },
  [`long:${'é'.repeat(150)}`]: { status: 'open', lastSeen: iso(3) },
});

test('exit 1 while the condition is open and fired inside the quiet window', () => {
  const r = run(ledger, 'cron-health-chronic:Firing Cron');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /still firing/);
});

test('exit 0 once resolveCondition marked it resolved', () => {
  const r = run(ledger, 'gap:resolved-show/nytimes--a.json');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PASS/);
});

test('exit 3 (not a pass) for an open condition that merely went quiet', () => {
  assert.equal(run(ledger, 'backstop:quiet').status, 3);
});

test('a long multi-byte key still matches its full ledger entry through the clamp', () => {
  assert.equal(run(ledger, `long:${'é'.repeat(150)}`).status, 1);
});

test('exit 3, never a vacuous pass, when it cannot tell', () => {
  assert.equal(run(ledger, 'gap:not-in-ledger.json').status, 3, 'unknown key');
  assert.equal(run(ledger, 'land:refired-after-resolve').status, 3, 'seen after resolvedAt');
  assert.equal(run(ledger, 'odd:status').status, 3, 'unrecognised status');
  assert.equal(run(path.join(dir, 'missing.json'), 'backstop:quiet').status, 3, 'missing ledger');
  assert.equal(run(writeLedger('bad.json', '{not json'), 'backstop:quiet').status, 3, 'unreadable ledger');
  const stale = writeLedger('stale.json', { 'gap:old.json': { status: 'resolved', lastSeen: iso(100), resolvedAt: iso(90) } });
  assert.equal(run(stale, 'gap:old.json').status, 3, 'ledger with no write in 48h');
});

test('exit 2 on usage errors', () => {
  const env = { ...process.env, ALERT_LEDGER_PATH: ledger };
  assert.equal(spawnSync(process.execPath, [SCRIPT], { env }).status, 2);
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--key-b64', 'not/valid'], { env }).status, 2);
});

test('read-only: the ledger is byte-identical after a run', () => {
  const before = fs.readFileSync(ledger, 'utf8');
  run(ledger, 'cron-health-chronic:Firing Cron');
  assert.equal(fs.readFileSync(ledger, 'utf8'), before);
});

// BRO-6387: a long key whose 120-char cut lands on a space produced a token the
// checker trimmed, so it never matched its own ledger entry (always exit 3).
test('long key clamped at a space round-trips through its own encoded command', () => {
  const { rowMatchKey } = require('../../scripts/lib/health-row-check-cmd.js');
  const key = 'time-bomb-tests:unit:tests/unit/opening-night-orchestrator-cron.test.mjs::cutoff boundary: just under counts, just over does not';
  const tok = alertAbsentCheckCmd(key).split('--key-b64 ')[1];
  const decoded = Buffer.from(tok, 'base64url').toString('utf8');
  assert.equal(rowMatchKey(decoded.trim()), rowMatchKey(key));
  assert.equal(rowMatchKey(rowMatchKey(key)), rowMatchKey(key), 'idempotent');
  const l = writeLedger('clamp.json', { [key]: { status: 'resolved', lastSeen: iso(5), resolvedAt: iso(1) } });
  assert.equal(run(l, key).status, 0);
});

// BRO-6208: the digest's "Dispatch a fix" key `digest-needs-you:<title>` is never
// a ledger key; it must match the underlying rows by title, not always exit 3.
test('digest-needs-you key matches ledger rows by title (resolved passes, open fails)', () => {
  const key = 'digest-needs-you:Tour candidate: Mexodus national tour';
  const row = (status) => ({ status, title: 'Tour candidate: Mexodus national tour', lastSeen: iso(5), ...(status === 'resolved' ? { resolvedAt: iso(1) } : {}) });
  assert.equal(run(writeLedger('dn-res.json', { 'tour-candidate:mexodus:2026-07-08': row('resolved'), other: { status: 'open', title: 'x', lastSeen: iso(1) } }), key).status, 0);
  assert.equal(run(writeLedger('dn-open.json', { 'tour-candidate:mexodus:2026-07-08': { ...row('open'), lastSeen: iso(1) } }), key).status, 1);
  assert.equal(run(writeLedger('dn-none.json', { other: { status: 'open', title: 'x', lastSeen: iso(1) } }), key).status, 3);
});

test('BRO-6435: a resolved row with no resolvedAt is absent by its lastSeen; with no timestamps it is unknown', () => {
  const { classifyEntry } = require('../../scripts/check-alert-condition-absent.js');
  const v = classifyEntry({ status: 'resolved', lastSeen: iso(200) }, realNowMs());
  assert.equal(v.verdict, 'absent');
  assert.match(v.why, /lastSeen used/);
  assert.equal(classifyEntry({ status: 'resolved', resolvedAt: 'junk' }, realNowMs()).verdict, 'unknown');
  assert.equal(classifyEntry({ status: 'resolved', lastSeen: iso(2), resolvedAt: iso(10) }, realNowMs()).verdict, 'unknown', 'seen after resolve stays unknown');
});

// BRO-7685: the router decorates resurfaced/escalated digest lines
// ("<title> (still open — BRO-N)", "<title> — escalated after N notifications",
// "<title> — still happening after N days") and older digests built the dispatch
// key from that decorated title. Keys go through alertAbsentCheckCmd (run()), so
// long titles are clamped exactly as on a real card, often mid-decoration.
test('digest-needs-you key matches its row through router decorations, clamped or not', () => {
  const { undecoratedDigestTitle, digestKeyMatchesTitle } = require('../../scripts/check-alert-condition-absent.js');
  const titles = [
    'LLM scoring daily spend over budget',
    'Opening night poller: SERP ledger backoff has kept Bright Data idle for 3 runs', // ~80 chars
    'Coverage verdict: 4 Broadway shows have fewer reviews than the aggregators list for them after the opening window', // >103 chars
  ];
  const decorations = [' (still open — BRO-6732)', ' — escalated after 12 notifications', ' — still happening after 9 days', ''];
  let n = 0;
  for (const title of titles) {
    for (const deco of decorations) {
      const key = `digest-needs-you:${title}${deco}`;
      const row = { status: 'resolved', title, lastSeen: iso(5), resolvedAt: iso(1) };
      const res = run(writeLedger(`deco-res-${n}.json`, { 'some:condition': row }), key);
      assert.equal(res.status, 0, `${JSON.stringify(key)} should PASS: ${res.stderr}`);
      const open = run(writeLedger(`deco-open-${n}.json`, { 'some:condition': { status: 'open', title, lastSeen: iso(1) } }), key);
      assert.equal(open.status, 1, `${JSON.stringify(key)} should FAIL while open`);
      n++;
    }
  }
  assert.equal(undecoratedDigestTitle('Foo (still open — BRO-12)'), 'Foo');
  assert.equal(undecoratedDigestTitle('Foo — escalated after 3 notifications'), 'Foo');
  assert.equal(undecoratedDigestTitle('Foo (still open) bar'), 'Foo (still open) bar', 'only a trailing router decoration is stripped');
  // No false match: a different row, or the plain title as a prefix of another.
  assert.equal(digestKeyMatchesTitle('digest-needs-you:Foo bar', 'Foo'), false);
  assert.equal(digestKeyMatchesTitle('digest-needs-you:Foo', 'Foo bar'), false);
});

// The digest keys the dispatch link on the undecorated title: call the real
// composer and decode the conditionKey it put into the link (CLAUDE.md §15).
test('send-morning-digest builds digest-needs-you keys from the undecorated title', () => {
  const { composeDigestEmail } = require('../../scripts/send-morning-digest.js');
  const noCfg = path.join(dir, 'no-dispatch-config.json');
  const q = { title: 'LLM scoring daily spend over budget (still open — BRO-6732)', description: 'x', severity: 'warning', conditionKey: 'llm-scoring:daily-cost-breach' };
  try { composeDigestEmail({ sections: { health: { queued: [q] } }, dispatchSecret: 'test-secret', dispatchConfigPath: noCfg, reportOnly: true, skipMacLocal: true }); } catch { /* links are attached before rendering */ }
  assert.ok(q.actionUrl, 'dispatch link attached');
  const u = new URL(q.actionUrl);
  assert.equal(u.searchParams.get('conditionKey'), 'digest-needs-you:LLM scoring daily spend over budget');
  assert.match(u.searchParams.get('title'), /still open — BRO-6732/, 'card title keeps the decoration');
});

// BRO-8426: an opening-night check's own conditionKey is answered by re-running
// the check on current data, not by waiting out the 168h ledger window. BRO-7669
// set isRevival on The Ugly One a day after the alert; the ledger row stayed open
// and the nightly recheck read the landed fix as "still firing".
// reviews.json has the real shape: { _meta, reviews: [flat rows with showId] }.
const OTHER_REVIEW = { showId: 'some-other-show', outletId: 'nytimes', criticName: 'A', assignedScore: 80, url: 'https://x/1' };
function runReplay(ledgerPath, conditionKey, shows, { texts = true, reviews = [OTHER_REVIEW] } = {}) {
  const tag = Math.random().toString(36).slice(2);
  const showsPath = path.join(dir, `shows-${tag}.json`);
  fs.writeFileSync(showsPath, JSON.stringify({ shows }));
  const reviewsPath = path.join(dir, `reviews-${tag}.json`);
  fs.writeFileSync(reviewsPath, JSON.stringify({ _meta: {}, reviews }));
  const textsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-absent-texts-'));
  fs.mkdirSync(path.join(textsDir, 'some-other-show'));
  if (texts) for (const s of shows) fs.mkdirSync(path.join(textsDir, s.id), { recursive: true });
  const argv = alertAbsentCheckCmd(conditionKey).split(' ').slice(2);
  return spawnSync(process.execPath, [SCRIPT, ...argv], {
    env: { ...process.env, ALERT_LEDGER_PATH: ledgerPath, ALERT_REPLAY_SHOWS_PATH: showsPath, ALERT_REPLAY_REVIEWS_PATH: reviewsPath, ALERT_REPLAY_REVIEW_TEXTS_DIR: textsDir },
    encoding: 'utf8',
  });
}

const REVIVAL_KEY = 'opening-night-revival-unverified-ugly-2026';
const replayLedger = writeLedger('replay-ledger.json', {
  ...FRESH,
  // Fired 6h ago and never resolved: the ledger alone says "firing".
  [REVIVAL_KEY]: { status: 'open', lastSeen: iso(6) },
});
const ugly = (extra = {}) => ({ id: 'ugly-2026', title: 'The Ugly One', status: 'open', openingDate: '2026-11-20', market: 'west-end', category: 'off-west-end', ...extra });

test('replay: exit 0 when the owning check passes now, although the ledger row is still open', () => {
  const r = runReplay(replayLedger, REVIVAL_KEY, [ugly({ isRevival: true })]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /re-ran the revival-unverified check/);
});

test('replay: exit 1 when the owning check still fails on current data', () => {
  const r = runReplay(replayLedger, REVIVAL_KEY, [ugly(), { id: 'ugly-1999', title: 'The Ugly One', status: 'closed', market: 'west-end', category: 'off-west-end', openingDate: '1999-01-01' }]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /re-ran the revival-unverified check.*isRevival is not true/);
});

test('replay: falls back to the ledger when it cannot decide (show gone, or review corpus absent)', () => {
  assert.equal(runReplay(replayLedger, REVIVAL_KEY, [ugly({ id: 'other-show' })]).status, 1, 'show missing -> ledger says firing');
  assert.equal(runReplay(replayLedger, REVIVAL_KEY, [ugly()], { texts: false }).status, 1, "show's texts absent (partial corpus) -> no vacuous pass, ledger says firing");
  assert.equal(runReplay(replayLedger, REVIVAL_KEY, [ugly({ isRevival: true })], { texts: false }).status, 0, 'a settling flag needs no texts');
  assert.equal(runReplay(replayLedger, REVIVAL_KEY, [ugly({ status: 'closed' })]).status, 1, 'closed show: the check skips, so ledger decides');
  assert.equal(runReplay(replayLedger, REVIVAL_KEY, [ugly({ isRevival: true })], { reviews: [] }).status, 1, 'empty reviews doc -> cannot decide');
});

// Ship-check P0: the raw reviews.json document was passed as reviewsDoc, so
// every reviewsDoc[show.id] check read "No reviews yet" and passed vacuously.
test('replay: reviews are grouped by show, so a violating review still fires', () => {
  const key = 'opening-night-assigned-score-schema-ugly-2026';
  const l = writeLedger('schema-ledger.json', { ...FRESH, [key]: { status: 'open', lastSeen: iso(3) } });
  const bad = { showId: 'ugly-2026', outletId: 'guardian', criticName: 'B', assignedScore: '2/4 stars', url: 'https://x/2' };
  const firing = runReplay(l, key, [ugly()], { reviews: [OTHER_REVIEW, bad] });
  assert.equal(firing.status, 1, firing.stderr);
  assert.match(firing.stderr, /re-ran the assigned-score-schema check.*expected number/);
  const fixed = runReplay(l, key, [ugly()], { reviews: [OTHER_REVIEW, { ...bad, assignedScore: 50 }] });
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.match(fixed.stdout, /All 1 review\(s\) have numeric assignedScore/);
});

test('replay: ALERT_REPLAY_DISABLED=1 restores the ledger-only verdict', () => {
  const argv = alertAbsentCheckCmd(REVIVAL_KEY).split(' ').slice(2);
  const r = spawnSync(process.execPath, [SCRIPT, ...argv], { env: { ...process.env, ALERT_LEDGER_PATH: replayLedger, ALERT_REPLAY_DISABLED: '1' }, encoding: 'utf8' });
  assert.equal(r.status, 1, 'ledger row is open and fresh');
});

test('replay: only exact opening-night-<check>-<show> keys of listed checks are replayed', () => {
  const { replayTarget } = require('../../scripts/check-alert-condition-absent.js');
  assert.deepEqual(replayTarget(REVIVAL_KEY) && replayTarget(REVIVAL_KEY).showId, 'ugly-2026');
  assert.equal(replayTarget('opening-night-fulltext-mentions-show:ugly-2026'), null);
  assert.equal(replayTarget('opening-night-remediation-exhausted-empty-cast:ugly-2026'), null);
  assert.equal(replayTarget('opening-night-revival-unverified-'), null);
});

test('replay: every listed check exists and emits exactly opening-night-<name>-<show.id>', () => {
  const { REPLAYABLE_OPENING_NIGHT_CHECKS } = require('../../scripts/check-alert-condition-absent.js');
  const checksDir = path.join(path.dirname(SCRIPT), 'lib', 'opening-night-checks');
  for (const { name } of REPLAYABLE_OPENING_NIGHT_CHECKS) {
    const src = fs.readFileSync(path.join(checksDir, `${name}.check.js`), 'utf8');
    const keys = [...src.matchAll(/conditionKey:\s*`([^`]*)`/g)].map(m => m[1]);
    assert.ok(keys.length > 0, `${name} emits a conditionKey`);
    for (const k of keys) assert.ok(k.startsWith(`opening-night-${name}-$`), `${name} key "${k}" must be opening-night-${name}-\${show.id}`);
  }
});
