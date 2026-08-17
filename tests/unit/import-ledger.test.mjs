// tests/unit/import-ledger.test.mjs — S3-T2 of the Notion→Linear cutover.
//
// The ledger is the only thing standing between "we migrated 1,831 cards" and
// "we think we migrated 1,831 cards". Its two acceptance criteria are both
// about loss: nothing from the legacy file may disappear in the migration, and
// two writers running at once must not clobber each other during a multi-hour
// import that overlaps CI commits every ~30 minutes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ledger = require(path.join(REPO, 'scripts/lib/import-ledger.js'));

const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), 'import-ledger-')), 'ledger.jsonl');

test('a later row supersedes an earlier one for the same pageId', () => {
  // This is what makes an append-only log usable as a mutable map — and why a
  // correction is a new row, never an edit, so --rollback still has the
  // history it needs.
  const p = tmp();
  ledger.appendRow(p, ledger.makeRow({ pageId: 'page-1', linearId: 'l1', identifier: 'BRO-1', title: 'first' }));
  ledger.appendRow(p, ledger.makeRow({ pageId: 'page-1', linearId: 'l1', identifier: 'BRO-1', title: 'corrected' }));
  const rows = ledger.readRows(p);
  assert.equal(rows.length, 2, 'both rows are kept — nothing is rewritten');
  assert.equal(ledger.indexByPageId(rows).get('page-1').title, 'corrected');
});

test('a torn line is reported, not silently swallowed', () => {
  const p = tmp();
  ledger.appendRow(p, ledger.makeRow({ pageId: 'page-1', identifier: 'BRO-1' }));
  writeFileSync(p, `${readFileSync(p, 'utf8')}{"pageId":"page-2","ident`); // killed mid-append
  const stats = ledger.ledgerStats(p);
  assert.equal(stats.rows, 1);
  assert.equal(stats.malformed, 1, 'a ledger that quietly drops rows is worse than one that admits it');
});

test('every legacy entry survives migration, including unresolvable ones', () => {
  // The acceptance criterion is checked by BRO IDENTIFIER, because dropping the
  // rows whose page could not be recovered would satisfy a pageId-shaped
  // ledger while losing real Linear issues.
  const legacy = {
    2: { linearId: 'l2', identifier: 'BRO-11', title: 'A', project: 'Archive', retiredReason: 'notion_done' },
    7: { linearId: 'l7', identifier: 'BRO-12', title: 'B', project: 'Infrastructure' },
    9: { linearId: 'l9', identifier: 'BRO-13', title: 'C', project: 'iOS' },
  };
  const resolve = (taskId) => (taskId === '9' ? null : `page-${taskId}`); // 9's mirror file was pruned
  const { rows, unresolved } = ledger.migrateLegacy(legacy, resolve);

  assert.equal(rows.length, 3);
  const byIdent = ledger.indexByIdentifier(rows);
  for (const ident of ['BRO-11', 'BRO-12', 'BRO-13']) {
    assert.ok(byIdent.has(ident), `${ident} was lost in migration`);
  }
  assert.equal(byIdent.get('BRO-11').retiredReason, 'notion_done', 'retire reasons must survive');
  assert.equal(byIdent.get('BRO-11').project, 'Archive');
  assert.equal(byIdent.get('BRO-13').pageId, null);
  assert.deepEqual(unresolved.map((u) => u.identifier), ['BRO-13']);
  // taskId is kept as provenance so a legacy row stays traceable to its origin.
  assert.equal(byIdent.get('BRO-11').taskId, '2');
});

test('migrated rows carry a fixed timestamp, not "now"', () => {
  // They describe work that happened before this migration; stamping them with
  // the migration time would make the ledger's own history a lie, and would
  // also make the migration non-reproducible.
  const legacy = { 1: { linearId: 'l1', identifier: 'BRO-1', title: 'A' } };
  const a = ledger.migrateLegacy(legacy, () => 'page-1').rows[0];
  const b = ledger.migrateLegacy(legacy, () => 'page-1').rows[0];
  assert.equal(a.at, b.at);
  assert.equal(a.source, 'legacy-migration');
});

test('the anti-join names exactly the pages with no ledger row', () => {
  const rows = [
    ledger.makeRow({ pageId: 'page-1', identifier: 'BRO-1' }),
    ledger.makeRow({ pageId: 'page-2', identifier: 'BRO-2' }),
    ledger.makeRow({ pageId: null, identifier: 'BRO-9' }), // unresolvable: cannot account for anything
  ];
  assert.deepEqual(ledger.unaccountedPageIds(['page-1', 'page-2', 'page-3'], rows), ['page-3']);
  // Deleting a row is the S3-T7a acceptance case.
  assert.deepEqual(ledger.unaccountedPageIds(['page-1', 'page-2'], rows.slice(1)), ['page-1']);
});

test('two concurrent writers both land — no last-writer-wins', async () => {
  // The real scenario: a multi-hour import appending while another process
  // writes the same ledger. The old whole-file rewrite lost entries here and
  // lost them silently, because the file stayed valid JSON.
  //
  // spawn, NOT execFileSync. execFileSync blocks until the child exits, so a
  // `.map(execFileSync)` runs the two writers strictly one after the other and
  // the test passes without ever having raced anything — a false pass that
  // looks exactly like a real one.
  const p = tmp();
  const N = 200;
  // The interleave assertion at the bottom used to be a bet on the scheduler, and
  // the house won on 2026-08-17: node's startup is ~40ms while 200 appends take
  // ~2ms, so writer `a` finished before writer `b` had booted, `switches` came back
  // 1, and CI went red on a run where nothing was actually broken. Two mechanisms
  // make that precondition STRUCTURAL rather than probabilistic:
  //   1. a start barrier — neither child appends until both are live and released;
  //   2. a first-row handshake — each child writes row 0, then blocks until the
  //      OTHER tag's row is on disk before writing rows 1..N-1.
  // (2) guarantees at least two tag switches whenever both children actually run,
  // so the assertion can no longer fail for timing reasons alone. If the writers
  // were ever serialized again (the execFileSync regression this test exists to
  // catch), the handshake cannot be satisfied and the child exits 3 — a loud,
  // specific failure instead of the silent false pass that started all this.
  const barrier = `${p}.barrier`;
  const readyFile = (tag) => `${p}.ready-${tag}`;
  const other = (tag) => (tag === 'a' ? 'b' : 'a');
  // Both waits YIELD rather than spin. A tight `while(!existsSync)` loop pins a
  // core, and on a CPU-starved CI runner two spinning children can starve each
  // other (and the parent) into the very timeout they are meant to prevent.
  // Atomics.wait is the only synchronous sleep available inside `node -e`.
  const sleep1ms = `const _b=new Int32Array(new SharedArrayBuffer(4));const nap=()=>Atomics.wait(_b,0,0,1);`;
  const child = (tag) =>
    `const fs=require('fs');${sleep1ms}` +
    `const l=require(${JSON.stringify(path.join(REPO, 'scripts/lib/import-ledger.js'))});` +
    `fs.writeFileSync(${JSON.stringify(readyFile(tag))},'1');` +
    `while(!fs.existsSync(${JSON.stringify(barrier)})) nap();` +
    `l.appendRow(${JSON.stringify(p)}, l.makeRow({pageId:'${tag}-0',identifier:'${tag}-0'}));` +
    `const dl=Date.now()+20000;` +
    `const saw=()=>{try{return fs.readFileSync(${JSON.stringify(p)},'utf8').includes('"${other(tag)}-0"')}catch(e){return false}};` +
    `while(!saw()){if(Date.now()>dl) process.exit(3); nap();}` +
    `for(let i=1;i<${N};i++) l.appendRow(${JSON.stringify(p)}, l.makeRow({pageId:'${tag}-'+i,identifier:'${tag}-'+i}));`;

  const running = ['a', 'b'].map(
    (tag) =>
      new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, ['-e', child(tag)], { stdio: 'ignore' });
        proc.on('error', reject);
        proc.on('exit', (code) => (code === 0
          ? resolve()
          : reject(new Error(code === 3
            ? `${tag} never saw the other writer's first row — the writers were serialized, so this test raced nothing`
            : `${tag} exited ${code}`))));
      })
  );
  // Release only once BOTH children are spinning on the barrier.
  const deadline = Date.now() + 30_000;
  while (!(existsSync(readyFile('a')) && existsSync(readyFile('b')))) {
    if (Date.now() > deadline) throw new Error('writers never signalled ready — race harness broken');
    await new Promise((r) => setTimeout(r, 5));
  }
  writeFileSync(barrier, '1');
  await Promise.all(running);

  const rows = ledger.readRows(p);
  const stats = ledger.ledgerStats(p);
  assert.equal(stats.malformed, 0, 'interleaved appends must not tear a line');
  assert.equal(rows.length, 2 * N, `expected ${2 * N} rows, got ${rows.length}`);
  const idents = new Set(rows.map((r) => r.identifier));
  assert.equal(idents.size, 2 * N, 'every write from both writers is addressable');
  for (const tag of ['a', 'b']) {
    assert.ok(idents.has(`${tag}-0`) && idents.has(`${tag}-${N - 1}`), `${tag} lost its first or last write`);
  }

  // Proof the test has teeth: if the two writers had run one after the other,
  // the file would be 200 'a' rows then 200 'b' rows and this assertion would
  // fail — which is exactly what the execFileSync version of this test did
  // without anyone noticing. Interleaving is the precondition for the row
  // count above to mean anything.
  const tags = rows.map((r) => r.identifier[0]);
  const switches = tags.reduce((n, t, i) => (i && t !== tags[i - 1] ? n + 1 : n), 0);
  assert.ok(switches > 1, `writers did not actually interleave (${switches} switch(es)) — the race was not exercised`);
});
