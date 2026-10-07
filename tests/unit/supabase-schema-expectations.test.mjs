// Edge cases for the migration→expected-schema parser behind verify-schema.yml
// and supabase-functions.yml's pre-deploy gate. These lock in the ship-check
// hardening (2026-08-09): a parser regression here degrades the drift check
// back into the silent false-pass/false-fail classes the review found.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { deriveExpectations } = require('../../scripts/lib/supabase-schema-expectations.js');

test('semicolon inside a string literal does not fracture the statement split', () => {
  const r = deriveExpectations([{ name: 'a.sql', sql: `
COMMENT ON COLUMN watchlist.x IS 'part one; part two';
ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS solo_col TEXT;
` }]);
  assert.ok(r.expected.has('column:watchlist.solo_col'));
  assert.equal(r.errors.length, 0);
});

test('unquoted identifiers fold to lowercase (pg catalog storage); quoted preserve case', () => {
  const r = deriveExpectations([{ name: 'b.sql', sql: `
CREATE TABLE IF NOT EXISTS FooBar (id int);
CREATE POLICY "Keep My Case" ON FooBar FOR SELECT USING (true);
` }]);
  assert.ok(r.expected.has('table:foobar'));
  assert.ok(r.expected.has('policy:foobar:Keep My Case'));
});

test('DROP TABLE cascades columns, policies, triggers, constraints and indexes', () => {
  const r = deriveExpectations([
    { name: 'c1.sql', sql: `
CREATE TABLE t1 (id int);
ALTER TABLE t1 ADD COLUMN c TEXT;
ALTER TABLE t1 ADD CONSTRAINT t1_check CHECK (c IS NOT NULL);
CREATE INDEX idx_t1_c ON t1 (c);
CREATE POLICY "p" ON t1 FOR SELECT USING (true);
CREATE TRIGGER trg BEFORE INSERT ON t1 EXECUTE FUNCTION f();
CREATE TABLE keepme (id int);
` },
    { name: 'c2.sql', sql: `DROP TABLE IF EXISTS t1; ALTER TABLE keepme ADD COLUMN k TEXT;` },
  ]);
  const leftover = [...r.expected.keys()].filter((k) => k.includes('t1'));
  assert.deepEqual(leftover, []);
  assert.ok(r.expected.has('table:keepme'));
  assert.ok(r.expected.has('column:keepme.k'));
});

test('trigger and constraint keys are table-qualified', () => {
  const r = deriveExpectations([{ name: 'd.sql', sql: `
CREATE TABLE t2 (id int);
ALTER TABLE t2 ADD CONSTRAINT shared_name CHECK (id > 0);
CREATE TRIGGER shared_trg BEFORE INSERT ON t2 EXECUTE FUNCTION f();
` }]);
  assert.ok(r.expected.has('constraint:t2:shared_name'));
  assert.ok(r.expected.has('trigger:t2:shared_trg'));
});

test('GRANT-only migration passes without a skip annotation', () => {
  const r = deriveExpectations([{ name: 'e.sql', sql: `GRANT SELECT ON keepme TO anon;` }]);
  assert.equal(r.errors.length, 0);
});

test('a migration with no recognizable DDL errors loud (forgetting-class floor)', () => {
  const r = deriveExpectations([{ name: 'f.sql', sql: `SELECT do_something_weird();` }]);
  assert.equal(r.errors.length, 1);
});

test('verify-schema: skip annotation opts a file out explicitly', () => {
  const r = deriveExpectations([{ name: 'g.sql', sql: `-- verify-schema: skip\nSELECT 1;` }]);
  assert.equal(r.errors.length, 0);
  assert.deepEqual(r.skipped, ['g.sql']);
});

test('block comments containing DDL keywords produce no phantom assertions', () => {
  const r = deriveExpectations([{ name: 'h.sql', sql: `
/* CREATE TABLE phantom (id int); */
CREATE TABLE real_table (id int);
` }]);
  assert.ok(!r.expected.has('table:phantom'));
  assert.ok(r.expected.has('table:real_table'));
});

// push_tokens is owned by the iOS repo (BroadwayScorecard-app), whose
// 20260812094500 migration dropped "Anon can insert push tokens" because it let
// any signed-in user attach a device token to another account. Web migrations
// only mirror that state for verify-schema. A web migration that "restores" the
// open policy to turn verify-schema green re-opens the hole (nearly shipped
// 2026-10-02, BRO-4525); this pins the mirrored set to the iOS one.
test('real web migrations expect exactly the iOS-owned push_tokens policies', () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../supabase/migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    .map((name) => ({ name, sql: fs.readFileSync(path.join(dir, name), 'utf8') }));
  const r = deriveExpectations(files);
  const pushPolicies = [...r.expected.keys()].filter((k) => k.startsWith('policy:push_tokens:')).sort();
  assert.deepEqual(pushPolicies, [
    'policy:push_tokens:push_tokens_claim_update',
    'policy:push_tokens:push_tokens_owner_insert',
  ]);
});

// apply-migration.yml applies ONE file by name, so a later file that drops the
// open policy doesn't protect against someone applying an earlier file that
// creates it. A merge of main on 2026-10-02 silently brought the deleted
// 20261002_push_tokens_insert_policy.sql back and the test above still passed.
test('no web migration after the iOS fix re-creates the open push_tokens insert policy', () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../supabase/migrations');
  const offenders = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.sql') && f >= '20260812')
    .filter((f) => /create\s+policy\s+"Anon can insert push tokens"/i.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  assert.deepEqual(offenders, []);
});

// ── function body drift (UGC roundtrip page, Oct 2026) ─────────────────────
// A body-only CREATE OR REPLACE FUNCTION migration leaves the function's
// existence unchanged, so the existence check passed while the migration was
// unapplied. The verifier now also compares a hash of the latest body.
const {
  extractFunctionBodies,
  hashBody,
  diffFunctionBodies,
} = require('../../scripts/lib/supabase-schema-expectations.js');

const fnSql = (body, name = 'my_fn') => `
CREATE OR REPLACE FUNCTION public.${name}(p int) RETURNS int
LANGUAGE plpgsql AS $$
${body}
$$;
`;

test('dollar tags with digits ($b2$) are hashed like $$ bodies', () => {
  const sql = 'CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $b2$ SELECT 1 $b2$;';
  assert.deepEqual(extractFunctionBodies(sql), [{ name: 'f', hash: hashBody('SELECT 1') }]);
});

test("E'..\\'..' strings and $ inside identifiers do not hide a later function", () => {
  const esc = "SELECT E'it\\'s -- x'; CREATE FUNCTION g() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;";
  assert.equal(extractFunctionBodies(esc).length, 1);
  const ident = 'CREATE TABLE t$a$ (id int); CREATE FUNCTION h() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;';
  assert.equal(extractFunctionBodies(ident).length, 1);
});

test('hash is ASCII-whitespace only so JS and Postgres agree (NBSP is content)', () => {
  assert.notEqual(hashBody(' SELECT 1'), hashBody('SELECT 1'));
  assert.notEqual(hashBody('SELECT　1'), hashBody('SELECT 1'));
});

test('live catalog query normalizes with the same ASCII rule (no [[:space:]])', () => {
  const { LIVE_CATALOG_QUERY } = require('../../scripts/lib/supabase-schema-expectations.js');
  assert.ok(LIVE_CATALOG_QUERY.includes("'[ \\t\\n\\r\\f\\v]+'"));
  assert.ok(!LIVE_CATALOG_QUERY.includes('[[:space:]]'));
  assert.ok(LIVE_CATALOG_QUERY.includes("btrim(regexp_replace(p.prosrc"));
});

test('coverage guard: a function whose dollar body cannot be hashed errors loud', () => {
  // Single-quoted body in a file that also uses a dollar quote: no hash attaches.
  const sql = "CREATE FUNCTION k() RETURNS int LANGUAGE sql AS 'SELECT 1'; DO $$ BEGIN NULL; END $$;";
  const r = deriveExpectations([{ name: 'k.sql', sql }]);
  assert.ok(r.errors.some((e) => e.includes('function k has no body hash')));
});

test('later migration redefining a function body replaces the expected hash', () => {
  const r = deriveExpectations([
    { name: 'a.sql', sql: fnSql('BEGIN RETURN 1; END;') },
    { name: 'b.sql', sql: fnSql('BEGIN RETURN 2; END;') },
  ]);
  const entry = r.expected.get('function:my_fn');
  assert.equal(entry.file, 'b.sql');
  assert.equal(entry.bodyHash, hashBody('BEGIN RETURN 2; END;'));
});

test('diffFunctionBodies flags a live body that is still the old migration', () => {
  const r = deriveExpectations([
    { name: 'a.sql', sql: fnSql('BEGIN RETURN 1; END;') },
    { name: 'b.sql', sql: fnSql('BEGIN RETURN 2; END;') },
  ]);
  const stale = [{ kind: 'function', name: 'my_fn', hash: hashBody('BEGIN RETURN 1; END;') }];
  const fresh = [{ kind: 'function', name: 'my_fn', hash: hashBody('BEGIN RETURN 2; END;') }];
  assert.deepEqual(diffFunctionBodies(r.expected, stale).map((o) => o.file), ['b.sql']);
  assert.equal(diffFunctionBodies(r.expected, fresh).length, 0);
});

test('whitespace-only reformatting is not drift', () => {
  assert.equal(hashBody('BEGIN\n  RETURN   1;\r\nEND;\n'), hashBody('BEGIN RETURN 1; END;'));
});

test('overloads: expected hash only needs to match one live overload', () => {
  const r = deriveExpectations([{ name: 'a.sql', sql: fnSql('SELECT 2') }]);
  const rows = [
    { kind: 'function', name: 'my_fn', hash: hashBody('SELECT 1') },
    { kind: 'function', name: 'my_fn', hash: hashBody('SELECT 2') },
  ];
  assert.equal(diffFunctionBodies(r.expected, rows).length, 0);
});

test('a missing function is the existence check\'s job, not drift', () => {
  const r = deriveExpectations([{ name: 'a.sql', sql: fnSql('SELECT 1') }]);
  assert.equal(diffFunctionBodies(r.expected, []).length, 0);
});

test('commented-out and string-embedded CREATE FUNCTION do not register', () => {
  const sql = `
-- CREATE FUNCTION ghost() RETURNS int AS $$ SELECT 1 $$;
/* CREATE FUNCTION ghost2() RETURNS int AS $$ SELECT 1 $$; */
COMMENT ON FUNCTION real_fn() IS 'CREATE FUNCTION ghost3() AS';
${fnSql('SELECT 9', 'real_fn')}`;
  assert.deepEqual(extractFunctionBodies(sql).map((f) => f.name), ['real_fn']);
});

test('real migrations: get_shared_plans expects the refuse-GET body from 20261002', () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../supabase/migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    .map((name) => ({ name, sql: fs.readFileSync(path.join(dir, name), 'utf8') }));
  const entry = deriveExpectations(files).expected.get('function:get_shared_plans');
  assert.ok(entry, 'get_shared_plans should be expected');
  assert.match(entry.file, /^20261002_plan_shares_refuse_get/);
  assert.ok(entry.bodyHash, 'body hash should be captured');
  const old = files.find((f) => f.name.startsWith('20261001_plan_shares'));
  const oldHash = extractFunctionBodies(old.sql).find((f) => f.name === 'get_shared_plans').hash;
  assert.notEqual(entry.bodyHash, oldHash);
});
