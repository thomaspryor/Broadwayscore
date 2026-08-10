// Derives the set of schema objects the committed migrations expect to exist
// in prod. Pure parsing — no network. Consumed by scripts/verify-supabase-schema.js
// (CI: verify-schema.yml on migration pushes + weekly, supabase-functions.yml
// before function deploys).
//
// This replaces the hand-maintained check_table/check_column list that used to
// live inline in supabase-functions.yml: that list covered 3 of 12 migrations
// and required a second hand-edit per migration — the forgetting-class that let
// 20260809_watchlist_showtime.sql sit unapplied until the nightly UGC roundtrip
// paged the owner (run 31344422375). Here every migration file MUST yield at
// least one assertion or parsing fails loud, so a new migration cannot silently
// escape verification. A migration that genuinely creates nothing checkable
// (pure GRANT/COMMENT/data fix) opts out with a `-- verify-schema: skip` line.
//
// Deliberately existence-only: it proves a migration was APPLIED (the failure
// class), not that every predicate/body matches. DROP-only statements remove
// prior expectations so superseding migrations (e.g. the fantasy security
// fixes) don't assert objects they themselves deleted.

'use strict';

const SKIP_ANNOTATION = /--\s*verify-schema:\s*skip/;

// Strip -- comments and $$..$$ / $tag$..$tag$ bodies so DDL keywords inside
// function bodies or comment prose can't produce phantom assertions.
function stripNoise(sql) {
  let out = sql.replace(/--[^\n]*/g, '');
  out = out.replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "''");
  return out;
}

function unquoteIdent(raw) {
  if (!raw) return raw;
  let name = raw.trim().replace(/^"(.*)"$/, '$1');
  // Strip schema qualifier; everything this project owns lives in public.
  const dot = name.lastIndexOf('.');
  if (dot !== -1) name = name.slice(dot + 1).replace(/^"(.*)"$/, '$1');
  return name;
}

// key → {kind, name, file}; key doubles as the identity used to diff against
// the live catalog snapshot.
function keyFor(kind, name) {
  return `${kind}:${name}`;
}

function parseStatement(stmt, file, expected) {
  const add = (kind, name) => {
    if (name) expected.set(keyFor(kind, name), { kind, name, file });
  };
  const remove = (kind, name) => {
    if (name) expected.delete(keyFor(kind, name));
  };

  let m;
  if ((m = stmt.match(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("[^"]+"|[\w.]+)/i))) {
    const table = unquoteIdent(m[1]);
    add('table', table);
    // Columns of a fresh table are implied by the table's existence; the
    // interesting column assertions are the ALTER TABLE ADD COLUMN ones below.
    return true;
  }
  if ((m = stmt.match(/\bALTER\s+TABLE\s+(?:ONLY\s+)?("[^"]+"|[\w.]+)([\s\S]*)/i))) {
    const table = unquoteIdent(m[1]);
    const body = m[2];
    let found = false;
    let c;
    const addCol = /\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?("[^"]+"|[\w]+)/gi;
    while ((c = addCol.exec(body))) {
      add('column', `${table}.${unquoteIdent(c[1])}`);
      found = true;
    }
    const dropCol = /\bDROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?("[^"]+"|[\w]+)/gi;
    while ((c = dropCol.exec(body))) {
      remove('column', `${table}.${unquoteIdent(c[1])}`);
      found = true;
    }
    const addCon = /\bADD\s+CONSTRAINT\s+("[^"]+"|[\w]+)/gi;
    while ((c = addCon.exec(body))) {
      add('constraint', unquoteIdent(c[1]));
      found = true;
    }
    const dropCon = /\bDROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?("[^"]+"|[\w]+)/gi;
    while ((c = dropCon.exec(body))) {
      remove('constraint', unquoteIdent(c[1]));
      found = true;
    }
    // ENABLE ROW LEVEL SECURITY etc. — real DDL, but nothing to assert.
    return found || /\bROW\s+LEVEL\s+SECURITY\b/i.test(body);
  }
  if ((m = stmt.match(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?("[^"]+"|[\w.]+)/i))) {
    add('index', unquoteIdent(m[1]));
    return true;
  }
  if ((m = stmt.match(/\bDROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?("[^"]+"|[\w.]+)/i))) {
    remove('index', unquoteIdent(m[1]));
    return true;
  }
  if ((m = stmt.match(/\bCREATE\s+POLICY\s+("[^"]+"|[\w]+)\s+ON\s+("[^"]+"|[\w.]+)/i))) {
    add('policy', `${unquoteIdent(m[2])}:${unquoteIdent(m[1])}`);
    return true;
  }
  if ((m = stmt.match(/\bDROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?("[^"]+"|[\w]+)\s+ON\s+("[^"]+"|[\w.]+)/i))) {
    remove('policy', `${unquoteIdent(m[2])}:${unquoteIdent(m[1])}`);
    return true;
  }
  if ((m = stmt.match(/\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+("[^"]+"|[\w.]+)\s*\(/i))) {
    add('function', unquoteIdent(m[1]));
    return true;
  }
  if ((m = stmt.match(/\bDROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?("[^"]+"|[\w.]+)/i))) {
    remove('function', unquoteIdent(m[1]));
    return true;
  }
  if ((m = stmt.match(/\bCREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+("[^"]+"|[\w.]+)/i))) {
    add('view', unquoteIdent(m[1]));
    return true;
  }
  if ((m = stmt.match(/\bDROP\s+VIEW\s+(?:IF\s+EXISTS\s+)?("[^"]+"|[\w.]+)/i))) {
    remove('view', unquoteIdent(m[1]));
    return true;
  }
  if ((m = stmt.match(/\bCREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+("[^"]+"|[\w]+)/i))) {
    add('trigger', unquoteIdent(m[1]));
    return true;
  }
  if ((m = stmt.match(/\bDROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?("[^"]+"|[\w]+)/i))) {
    remove('trigger', unquoteIdent(m[1]));
    return true;
  }
  // GRANT/REVOKE/COMMENT/INSERT/UPDATE: legitimate migration content with no
  // existence assertion. Counts as "understood" so a migration made only of
  // these still needs the explicit skip annotation to document that intent.
  return /^\s*(GRANT|REVOKE|COMMENT)\b/i.test(stmt);
}

// files: [{name, sql}] sorted by filename (timestamp order — later migrations
// supersede earlier ones). Returns {expected: Map, skipped: [name], errors: [msg]}.
function deriveExpectations(files) {
  const expected = new Map();
  const skipped = [];
  const errors = [];
  for (const { name, sql } of files) {
    if (SKIP_ANNOTATION.test(sql)) {
      skipped.push(name);
      continue;
    }
    const before = expected.size;
    let sawAssertion = false;
    const statements = stripNoise(sql).split(';');
    for (const stmt of statements) {
      if (!stmt.trim()) continue;
      if (parseStatement(stmt, name, expected)) sawAssertion = true;
    }
    // A migration the parser can't see into would silently escape
    // verification — the exact failure class this module exists to close.
    if (!sawAssertion && expected.size === before) {
      errors.push(
        `${name}: no verifiable DDL recognized — extend supabase-schema-expectations.js ` +
          `or annotate the file with "-- verify-schema: skip" if it truly creates nothing checkable`
      );
    }
  }
  return { expected, skipped, errors };
}

// Single catalog snapshot query; returns rows of {kind, name} matching keyFor().
const LIVE_CATALOG_QUERY = `
SELECT 'table' AS kind, tablename AS name FROM pg_tables WHERE schemaname = 'public'
UNION ALL SELECT 'view', viewname FROM pg_views WHERE schemaname = 'public'
UNION ALL SELECT 'column', table_name || '.' || column_name FROM information_schema.columns WHERE table_schema = 'public'
UNION ALL SELECT 'constraint', conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public'
UNION ALL SELECT 'index', indexname FROM pg_indexes WHERE schemaname = 'public'
UNION ALL SELECT 'policy', tablename || ':' || policyname FROM pg_policies WHERE schemaname = 'public'
UNION ALL SELECT 'function', p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
UNION ALL SELECT 'trigger', t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND NOT t.tgisinternal
`.trim();

function diffAgainstLive(expected, liveRows) {
  const live = new Set(liveRows.map((r) => keyFor(r.kind, r.name)));
  const missing = [];
  for (const [key, obj] of expected) {
    if (!live.has(key)) missing.push(obj);
  }
  return missing;
}

module.exports = {
  deriveExpectations,
  diffAgainstLive,
  LIVE_CATALOG_QUERY,
  // exported for tests
  stripNoise,
  parseStatement,
};
