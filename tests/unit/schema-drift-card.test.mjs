// BRO-6666: the verify-schema failure card names the unapplied migrations and the apply command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { parseVerifyLog, buildCard, buildUnparsedCard, classifyMigration, applyCommand, KEY_LINE } = require('../../scripts/lib/schema-drift-card.js');
const { startNowUnpickableReason } = require('../../scripts/lib/cloud-worker-pick.js');

const LOG = [
  'Derived 120 schema assertions from 40 migrations',
  '::error::missing in prod: column watchlist.curtain_time (declared by 20261030_a.sql)',
  '::error::apply it: gh workflow run apply-migration.yml -f migration=supabase/migrations/20261030_a.sql -f confirm=APPLY',
  '::error::function body drift: public.f in prod differs from the latest definition in 20261028_b.sql',
  '::error::re-apply or reconcile: gh workflow run apply-migration.yml -f migration=supabase/migrations/20261028_b.sql -f confirm=APPLY',
].join('\n');

test('parses missing objects and drifted functions per migration, sorted', () => {
  const e = parseVerifyLog(LOG);
  assert.deepEqual(e.map((x) => x.file), ['20261028_b.sql', '20261030_a.sql']);
  assert.deepEqual(e[1].missing, ['column watchlist.curtain_time']);
  assert.deepEqual(e[0].drifted, ['public.f']);
});

test('policy names containing spaces keep their detail line', () => {
  const e = parseVerifyLog('::error::missing in prod: policy fantasy_leagues:Anon can read leagues (declared by 20261030_a.sql)');
  assert.deepEqual(e[0].missing, ['policy fantasy_leagues:Anon can read leagues']);
});

test('a failure with no migration lines (API outage) yields no entries', () => {
  assert.deepEqual(parseVerifyLog('::error::Management API query failed: HTTP 500'), []);
});

test('card carries the key, apply command, safe VERIFY and is pickable', () => {
  const card = buildCard({ entries: parseVerifyLog(LOG), runUrl: 'https://x/run/1', readSql: () => 'alter table t add column if not exists c int;' });
  assert.ok(card.description.includes(KEY_LINE));
  assert.ok(card.description.includes(applyCommand('20261030_a.sql')));
  assert.match(card.description, /^VERIFY: node --test tests\/unit\/schema-drift-card\.test\.mjs$/m);
  assert.match(card.description, /additive-only/);
  assert.equal(startNowUnpickableReason({ ...card, priority: 2, mode: 'dispatch' }), null);
});

test('classifier flags destructive and function changes, ignores comments', () => {
  assert.match(classifyMigration('drop table x;'), /needs review/);
  assert.match(classifyMigration('create or replace function f() returns int as $$ select 1 $$ language sql;'), /needs review/);
  for (const sql of ['update public.t set x=1;', 'alter table t enable row level security;', 'alter table t add constraint c check (x>0);', 'drop trigger tg on t;', 'insert into t values (1);', 'create trigger tg before insert on t for each row execute function f();']) {
    assert.match(classifyMigration(sql), /needs review/, sql);
  }
  assert.match(classifyMigration('-- drop table x\ncreate table if not exists t(id int);'), /additive-only/);
});

test('unparsed-failure card is pickable and carries the key', () => {
  const card = buildUnparsedCard({ tail: '::error::Management API query failed: HTTP 401', runUrl: 'https://x/run/2' });
  assert.ok(card.description.includes(KEY_LINE));
  assert.equal(startNowUnpickableReason({ ...card, priority: 2, mode: 'dispatch' }), null);
});

test('parser contract: verifier still prints the lines the parser reads', () => {
  const src = readFileSync(new URL('../../scripts/verify-supabase-schema.js', import.meta.url), 'utf8');
  assert.ok(src.includes('missing in prod: ${obj.kind} ${obj.name} (declared by ${file})'));
  assert.ok(src.includes('function body drift: ${name} in prod differs from the latest definition in ${file}'));
  assert.ok(src.includes('apply-migration.yml -f migration=supabase/migrations/${file} -f confirm=APPLY'));
});
