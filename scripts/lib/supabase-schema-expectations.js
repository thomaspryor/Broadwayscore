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
// Existence-only for tables, columns, indexes, policies, constraints, views and
// triggers: it proves a migration was APPLIED (the failure class), not that every
// predicate matches. DROP-only statements remove prior expectations so
// superseding migrations (e.g. the fantasy security fixes) don't assert objects
// they themselves deleted.
//
// Functions are the exception. A `CREATE OR REPLACE FUNCTION` migration often
// changes only a body, so "the function exists" is true both before and after
// the migration is applied. That let 20261002_plan_shares_refuse_get.sql sit
// merged but unapplied while the nightly UGC roundtrip paged the owner (Oct
// 2026). Each function with a dollar-quoted body therefore also carries a hash
// of its latest body, compared with the hash of the live pg_proc.prosrc.

'use strict';

const crypto = require('crypto');

const SKIP_ANNOTATION = /--\s*verify-schema:\s*skip/;

// Strip $$..$$ bodies, comments, and string literals so DDL keywords inside
// function bodies or prose can't produce phantom assertions, and so a ';'
// inside a string (COMMENT text, CHECK ... IN ('a;b')) can't fracture the
// statement split. Order matters: dollar bodies first (may contain anything),
// then line comments (often contain apostrophes — "don't" — that would
// otherwise open a phantom string literal), then block comments, then strings.
function stripNoise(sql) {
  let out = sql.replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, "''");
  out = out.replace(/--[^\n]*/g, '');
  out = out.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out.replace(/'(?:[^']|'')*'/g, "''");
  return out;
}

function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

// Whitespace-collapsed md5 of a function body. The live catalog applies the
// same normalization in SQL (see LIVE_CATALOG_QUERY), so reformatting a body
// never reads as drift but any real edit does. ASCII-only on BOTH sides on
// purpose: JS .trim() and Postgres [[:space:]] (locale-aware) would otherwise
// disagree about NBSP / BOM / ideographic space and false-fail forever.
function hashBody(body) {
  return crypto
    .createHash('md5')
    .update(body.replace(/[ \t\n\r\f\v]+/g, ' ').replace(/^ | $/g, ''), 'utf8')
    .digest('hex');
}

// Returns [{name, hash}] for every `CREATE [OR REPLACE] FUNCTION name(...)
// ... AS $tag$ body $tag$` in the file, in source order. Walks the raw text
// (not stripNoise output) because the body is exactly what stripNoise throws
// away. Comments and string literals outside the body are skipped so a
// commented-out CREATE FUNCTION cannot register.
function extractFunctionBodies(sql) {
  const out = [];
  let head = '';
  let i = 0;
  while (i < sql.length) {
    const rest = sql.slice(i, i + 200);
    let m;
    if (rest.startsWith('--')) {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl;
    } else if (rest.startsWith('/*')) {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else if (sql[i] === "'") {
      // E'...' strings honor backslash escapes (E'it\'s'); plain strings do not.
      const isEscape = /(?:^|[^\w$])[Ee]$/.test(head);
      const litRe = isEscape ? /^'(?:[^'\\]|\\[\s\S]|'')*'/ : /^'(?:[^']|'')*'/;
      const lit = litRe.exec(sql.slice(i));
      head += "''";
      i += lit ? lit[0].length : 1;
    } else if (!/[\w$]$/.test(head) && (m = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest))) {
      const close = sql.indexOf(m[0], i + m[0].length);
      if (close === -1) break;
      const body = sql.slice(i + m[0].length, close);
      const fn = /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+("[^"]+"|[\w.]+)\s*\(/i.exec(head);
      if (fn) out.push({ name: unquoteIdent(fn[1]), hash: hashBody(body) });
      head += "''";
      i = close + m[0].length;
    } else if (sql[i] === ';') {
      head = '';
      i += 1;
    } else {
      head += sql[i];
      i += 1;
    }
  }
  return out;
}

function unquoteIdent(raw) {
  if (!raw) return raw;
  let name = raw.trim();
  // Strip schema qualifier; everything this project owns lives in public.
  const dot = name.lastIndexOf('.');
  if (dot !== -1 && !/^".*"$/.test(name)) name = name.slice(dot + 1);
  if (/^".*"$/.test(name)) return name.slice(1, -1);
  // Postgres folds unquoted identifiers to lowercase before storing them in
  // the catalogs — match that, or an unquoted MixedCase name false-fails forever.
  return name.toLowerCase();
}

// key → {kind, name, file}; key doubles as the identity used to diff against
// the live catalog snapshot.
function keyFor(kind, name) {
  return `${kind}:${name}`;
}

function parseStatement(stmt, file, expected) {
  const add = (kind, name, extra) => {
    if (name) expected.set(keyFor(kind, name), { kind, name, file, ...extra });
  };
  const remove = (kind, name) => {
    if (name) expected.delete(keyFor(kind, name));
  };

  let m;
  if ((m = stmt.match(/\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?("[^"]+"|[\w.]+)/i))) {
    const table = unquoteIdent(m[1]);
    remove('table', table);
    // Cascade: expectations scoped to the dropped table (columns `t.col`,
    // policies/triggers/constraints `t:name`, indexes recorded with table=t)
    // would otherwise false-fail forever after a legitimate drop.
    for (const [key, obj] of [...expected]) {
      if (obj.name.startsWith(`${table}.`) || obj.name.startsWith(`${table}:`) || obj.table === table) {
        expected.delete(key);
      }
    }
    return true;
  }
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
    // Constraint (and trigger, below) names are only unique per-table in
    // Postgres, so the key is table-qualified — a same-named constraint on a
    // DIFFERENT table must not satisfy this table's assertion.
    const addCon = /\bADD\s+CONSTRAINT\s+("[^"]+"|[\w]+)/gi;
    while ((c = addCon.exec(body))) {
      add('constraint', `${table}:${unquoteIdent(c[1])}`);
      found = true;
    }
    const dropCon = /\bDROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?("[^"]+"|[\w]+)/gi;
    while ((c = dropCon.exec(body))) {
      remove('constraint', `${table}:${unquoteIdent(c[1])}`);
      found = true;
    }
    // ENABLE ROW LEVEL SECURITY etc. — real DDL, but nothing to assert.
    return found || /\bROW\s+LEVEL\s+SECURITY\b/i.test(body);
  }
  if ((m = stmt.match(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?("[^"]+"|[\w.]+)\s+ON\s+(?:ONLY\s+)?("[^"]+"|[\w.]+)/i))) {
    // Index names are schema-unique so the key stays the bare name; the table
    // is recorded so a DROP TABLE can cascade-remove the expectation.
    add('index', unquoteIdent(m[1]), { table: unquoteIdent(m[2]) });
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
  if ((m = stmt.match(/\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+("[^"]+"|[\w]+)[\s\S]*?\bON\s+("[^"]+"|[\w.]+)/i))) {
    add('trigger', `${unquoteIdent(m[2])}:${unquoteIdent(m[1])}`);
    return true;
  }
  if ((m = stmt.match(/\bDROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?("[^"]+"|[\w]+)\s+ON\s+("[^"]+"|[\w.]+)/i))) {
    remove('trigger', `${unquoteIdent(m[2])}:${unquoteIdent(m[1])}`);
    return true;
  }
  // GRANT/REVOKE/COMMENT: legitimate migration content with no existence
  // assertion. Counts as "understood", so a migration made only of these
  // passes without the skip annotation — there is nothing to verify, and
  // forcing an annotation would just be ceremony.
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
    // Attach the latest in-file body hash. `add` replaced any older entry, so
    // an entry whose file is this one is this file's definition; a later file
    // that redefines the function without a dollar body drops the hash.
    for (const { name: fn, hash } of extractFunctionBodies(sql)) {
      const entry = expected.get(keyFor('function', fn));
      if (entry && entry.file === name) entry.bodyHash = hash;
    }
    // Coverage guard: a function declared here whose dollar-quoted body the
    // extractor could not hash would silently fall back to existence-only (the
    // incident class). Fail loud instead of escaping. Overloads share one hash
    // slot (the last definition wins), so keep new functions to unique names.
    if (/\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.test(stripComments(sql))) {
      for (const obj of expected.values()) {
        if (obj.kind === 'function' && obj.file === name && !obj.bodyHash) {
          errors.push(
            `${name}: function ${obj.name} has no body hash — extractFunctionBodies could not read its ` +
              `dollar-quoted body; extend supabase-schema-expectations.js`
          );
        }
      }
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
// The function hash mirrors hashBody(): ASCII-only whitespace collapse (the \t
// \n escapes are interpreted by the regex engine, hence String.raw) and a
// space-only btrim.
const LIVE_CATALOG_QUERY = String.raw`
SELECT 'table' AS kind, tablename AS name, NULL AS hash FROM pg_tables WHERE schemaname = 'public'
UNION ALL SELECT 'view', viewname, NULL FROM pg_views WHERE schemaname = 'public'
UNION ALL SELECT 'column', table_name || '.' || column_name, NULL FROM information_schema.columns WHERE table_schema = 'public'
UNION ALL SELECT 'constraint', rel.relname || ':' || conname, NULL FROM pg_constraint c JOIN pg_class rel ON rel.oid = c.conrelid JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public'
UNION ALL SELECT 'index', indexname, NULL FROM pg_indexes WHERE schemaname = 'public'
UNION ALL SELECT 'policy', tablename || ':' || policyname, NULL FROM pg_policies WHERE schemaname = 'public'
UNION ALL SELECT 'function', p.proname, md5(btrim(regexp_replace(p.prosrc, '[ \t\n\r\f\v]+', ' ', 'g'), ' ')) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
UNION ALL SELECT 'trigger', c.relname || ':' || t.tgname, NULL FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND NOT t.tgisinternal
`.trim();

function diffAgainstLive(expected, liveRows) {
  const live = new Set(liveRows.map((r) => keyFor(r.kind, r.name)));
  const missing = [];
  for (const [key, obj] of expected) {
    if (!live.has(key)) missing.push(obj);
  }
  return missing;
}

// Functions that exist live but whose body hash matches none of the live
// overloads of that name: the migration declaring the current body was never
// applied (or the function was edited by hand). Overloads share a proname, so
// the expected hash only has to match one live row.
function diffFunctionBodies(expected, liveRows) {
  const liveHashes = new Map();
  for (const r of liveRows) {
    if (r.kind !== 'function') continue;
    if (!liveHashes.has(r.name)) liveHashes.set(r.name, new Set());
    liveHashes.get(r.name).add(r.hash);
  }
  const drifted = [];
  for (const obj of expected.values()) {
    if (obj.kind !== 'function' || !obj.bodyHash) continue;
    const hashes = liveHashes.get(obj.name);
    if (hashes && !hashes.has(obj.bodyHash)) drifted.push(obj);
  }
  return drifted;
}

module.exports = {
  deriveExpectations,
  diffAgainstLive,
  diffFunctionBodies,
  LIVE_CATALOG_QUERY,
  // exported for tests
  stripNoise,
  parseStatement,
  extractFunctionBodies,
  hashBody,
};
