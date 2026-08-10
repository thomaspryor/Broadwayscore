// Edge cases for the migration→expected-schema parser behind verify-schema.yml
// and supabase-functions.yml's pre-deploy gate. These lock in the ship-check
// hardening (2026-08-09): a parser regression here degrades the drift check
// back into the silent false-pass/false-fail classes the review found.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

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
