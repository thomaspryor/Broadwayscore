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
//
// BRO-4538 adds three settings an unapplied migration can change while every
// object keeps existing: function SET clauses (`SET search_path = ''`, from the
// header or ALTER FUNCTION; key fnconfig fn:setting), view options
// (`WITH (security_invoker = true)` / ALTER VIEW SET; key viewopt view:opt=value)
// and RETURNS TABLE column names (key fnresult fn:a,b,c), which is what a
// `SELECT * FROM fn()` view exposes. CREATE OR REPLACE resets the first two
// in Postgres, so it resets their expectations too. Residual: a view whose
// SELECT list over a base table changes is still existence-only.
//
// Two advisory reports read the same snapshot (warnings, never failures):
// findUnexpectedPolicies() (BRO-4532: live policies no migration declares) and
// findUndeletedUserTables() (BRO-4534: per-user tables, including ones only the
// iOS repo's migrations create, that account deletion would leave behind).

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

// Arming proof (§19): fnconfig/fnresult/viewopt misses fail the job like any
// other missing object. They passed against prod before landing (verify-schema
// dispatch on the branch, run 38219107425: all 87 expected objects present).
const FN_VIEW_KINDS = new Set(['fnconfig', 'viewopt', 'fnresult']);

// Drop every `kind:<owner>:...` expectation (a CREATE OR REPLACE reset or a DROP).
function removeOwned(expected, kinds, owner) {
  for (const [key, obj] of [...expected]) {
    if (kinds.includes(obj.kind) && obj.name.startsWith(`${owner}:`)) expected.delete(key);
  }
}

// Postgres accepts true/on/yes/1 for boolean reloptions and stores the text as
// written; compare the meaning, not the spelling. LIVE_CATALOG_QUERY mirrors this.
function normalizeOptValue(v) {
  const t = String(v).trim().replace(/^'(.*)'$/, '$1').toLowerCase();
  if (['true', 'on', 'yes', '1'].includes(t)) return 'true';
  if (['false', 'off', 'no', '0'].includes(t)) return 'false';
  return t;
}

// `k = v, k2` inside WITH (...) / SET (...) -> [[k, v]]
function parseOptionList(list) {
  return list
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [k, v = 'true'] = part.split('=');
      return [k.trim().toLowerCase(), normalizeOptValue(v)];
    });
}

// Text inside the parentheses that open at or after `from`, balanced, or null.
function balancedParens(text, from) {
  const open = text.indexOf('(', from);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  return null;
}

function splitTopLevel(text) {
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

// Sorted RETURNS TABLE column names (byte order, matching COLLATE "C" in SQL), or null.
function returnsTableColumns(stmt) {
  const m = /\bRETURNS\s+TABLE\s*\(/i.exec(stmt);
  if (!m) return null;
  const inner = balancedParens(stmt, m.index);
  if (inner == null) return null;
  const names = splitTopLevel(inner)
    .map((col) => col.trim().match(/^("[^"]+"|[\w]+)/))
    .filter(Boolean)
    .map((c) => unquoteIdent(c[1]));
  return names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(',');
}

// Function SET clauses (stripNoise has blanked the body, so a SET inside the
// body can't register). `SET x FROM CURRENT` counts as setting x.
function functionSetKeys(stmt) {
  return [...stmt.matchAll(/\bSET\s+([\w.]+)\s*(?:=|\bTO\b|\bFROM\s+CURRENT\b)/gi)].map((m) => m[1].toLowerCase());
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
      if (FN_VIEW_KINDS.has(obj.kind)) continue;
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
    const fn = unquoteIdent(m[1]);
    add('function', fn);
    // CREATE OR REPLACE replaces proconfig and the result type: re-derive both.
    removeOwned(expected, ['fnconfig', 'fnresult'], fn);
    for (const key of functionSetKeys(stmt)) add('fnconfig', `${fn}:${key}`);
    const cols = returnsTableColumns(stmt);
    if (cols) add('fnresult', `${fn}:${cols}`);
    return true;
  }
  if ((m = stmt.match(/\bALTER\s+FUNCTION\s+("[^"]+"|[\w.]+)\s*\(/i))) {
    const fn = unquoteIdent(m[1]);
    const after = stmt.slice(m.index + m[0].length - 1);
    const args = balancedParens(after, 0) ?? '';
    const tail = after.slice(args.length + 2);
    for (const key of functionSetKeys(tail)) add('fnconfig', `${fn}:${key}`);
    for (const r of tail.matchAll(/\bRESET\s+([\w.]+)/gi)) {
      if (r[1].toLowerCase() === 'all') removeOwned(expected, ['fnconfig'], fn);
      else remove('fnconfig', `${fn}:${r[1].toLowerCase()}`);
    }
    return true;
  }
  if ((m = stmt.match(/\bDROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?("[^"]+"|[\w.]+)/i))) {
    const fn = unquoteIdent(m[1]);
    remove('function', fn);
    removeOwned(expected, ['fnconfig', 'fnresult'], fn);
    return true;
  }
  if ((m = stmt.match(/\bCREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+("[^"]+"|[\w.]+)/i))) {
    const view = unquoteIdent(m[1]);
    add('view', view);
    // CREATE OR REPLACE VIEW replaces reloptions with its own WITH list.
    removeOwned(expected, ['viewopt'], view);
    const w = stmt.slice(m.index + m[0].length).match(/^\s*WITH\s*\(([^)]*)\)/i);
    if (w) for (const [k, v] of parseOptionList(w[1])) add('viewopt', `${view}:${k}=${v}`);
    return true;
  }
  if ((m = stmt.match(/\bALTER\s+VIEW\s+(?:IF\s+EXISTS\s+)?("[^"]+"|[\w.]+)\s+(SET|RESET)\s*\(([^)]*)\)/i))) {
    const view = unquoteIdent(m[1]);
    for (const [k, v] of parseOptionList(m[3])) {
      for (const [key, obj] of [...expected]) {
        if (obj.kind === 'viewopt' && obj.name.startsWith(`${view}:${k}=`)) expected.delete(key);
      }
      if (m[2].toUpperCase() === 'SET') add('viewopt', `${view}:${k}=${v}`);
    }
    return true;
  }
  if ((m = stmt.match(/\bDROP\s+VIEW\s+(?:IF\s+EXISTS\s+)?("[^"]+"|[\w.]+)/i))) {
    const view = unquoteIdent(m[1]);
    remove('view', view);
    removeOwned(expected, ['viewopt'], view);
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
// space-only btrim. The first branch casts to text on purpose: UNION ALL takes
// its column type from the first branch, and pg_tables.tablename is type
// "name", which silently truncated every row to 63 bytes (long fnresult keys
// never matched).
const LIVE_CATALOG_QUERY = String.raw`
SELECT 'table'::text AS kind, tablename::text AS name, NULL::text AS hash FROM pg_tables WHERE schemaname = 'public'
UNION ALL SELECT 'view', viewname, NULL FROM pg_views WHERE schemaname = 'public'
UNION ALL SELECT 'column', table_name || '.' || column_name, NULL FROM information_schema.columns WHERE table_schema = 'public'
UNION ALL SELECT 'constraint', rel.relname || ':' || conname, NULL FROM pg_constraint c JOIN pg_class rel ON rel.oid = c.conrelid JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public'
UNION ALL SELECT 'index', indexname, NULL FROM pg_indexes WHERE schemaname = 'public'
UNION ALL SELECT 'policy', tablename || ':' || policyname, cmd || ' TO ' || array_to_string(roles, ',') || ' USING (' || coalesce(qual, '') || ') CHECK (' || coalesce(with_check, '') || ')' FROM pg_policies WHERE schemaname = 'public'
UNION ALL SELECT 'function', p.proname, md5(btrim(regexp_replace(p.prosrc, '[ \t\n\r\f\v]+', ' ', 'g'), ' ')) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
UNION ALL SELECT 'trigger', c.relname || ':' || t.tgname, NULL FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND NOT t.tgisinternal
UNION ALL SELECT 'fnconfig', p.proname || ':' || lower(split_part(cfg, '=', 1)), NULL FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace CROSS JOIN LATERAL unnest(p.proconfig) AS cfg WHERE n.nspname = 'public'
UNION ALL SELECT 'fnresult', p.proname || ':' || (SELECT string_agg(a.n, ',' ORDER BY a.n COLLATE "C") FROM unnest(p.proargnames, p.proargmodes::text[]) AS a(n, m) WHERE a.m = 't'), NULL FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND 't' = ANY(p.proargmodes::text[])
UNION ALL SELECT 'viewopt', c.relname || ':' || lower(split_part(opt, '=', 1)) || '=' || CASE WHEN lower(split_part(opt, '=', 2)) IN ('true', 'on', 'yes', '1') THEN 'true' WHEN lower(split_part(opt, '=', 2)) IN ('false', 'off', 'no', '0') THEN 'false' ELSE lower(split_part(opt, '=', 2)) END, NULL FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN LATERAL unnest(c.reloptions) AS opt WHERE n.nspname = 'public' AND c.relkind = 'v'
UNION ALL SELECT 'usercol', c.table_name || '.' || c.column_name, NULL FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.column_name IN ('user_id', 'created_by') AND c.data_type = 'uuid'
UNION ALL SELECT 'cascadefk', rel.relname || ':' || fn.nspname || '.' || frel.relname, NULL FROM pg_constraint c JOIN pg_class rel ON rel.oid = c.conrelid JOIN pg_namespace n ON n.oid = rel.relnamespace JOIN pg_class frel ON frel.oid = c.confrelid JOIN pg_namespace fn ON fn.oid = frel.relnamespace WHERE n.nspname = 'public' AND c.contype = 'f' AND c.confdeltype = 'c' AND ((fn.nspname = 'auth' AND frel.relname = 'users') OR (fn.nspname = 'public' AND frel.relname = 'profiles'))
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

// For a missing fnconfig/viewopt/fnresult expectation: what prod has for the
// same function/view instead, so the error says what actually differs.
function liveSiblings(obj, liveRows) {
  const owner = obj.name.split(':')[0];
  return liveRows.filter((r) => r.kind === obj.kind && r.name.split(':')[0] === owner).map((r) => r.name).sort();
}

// BRO-4532: live policies no migration declares (and no allowlist entry
// explains). Advisory: printed as warnings by verify-supabase-schema.js.
// An allowlist entry pins the policy's definition by policyDefHash(), so a
// known legacy policy that is later broadened (say USING (true)) warns again.
// @param {Map} expected  from deriveExpectations
// @param {{kind,name,hash}[]} liveRows  policy rows carry the definition in hash
// @param {Object<string,{def:string,why:string}>} known  'table:policy' -> pinned def hash + reason
// @returns {{name,definition,defHash,changed:boolean}[]}  changed = allowlisted but the definition moved
function policyDefHash(definition) {
  return crypto.createHash('sha256').update(String(definition || '')).digest('hex').slice(0, 12);
}

function findUnexpectedPolicies(expected, liveRows, known = {}) {
  const out = [];
  for (const r of liveRows) {
    if (r.kind !== 'policy' || expected.has(keyFor('policy', r.name))) continue;
    const defHash = policyDefHash(r.hash);
    const entry = known[r.name];
    if (entry && entry.def === defHash) continue;
    out.push({ name: r.name, definition: r.hash || '', defHash, changed: !!entry });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// BRO-4534: public base tables with a uuid user_id/created_by column that
// account deletion would leave behind. A table counts as covered when the
// delete-account function names it ('table'), it is exempt with a reason, or a
// FK cascades from auth.users / public.profiles (both deleted by the function).
// Reads the LIVE catalog, so tables created only by the iOS repo's migrations
// are seen too. Advisory first (§19).
// @returns {string[]} sorted table names
function findUndeletedUserTables(liveRows, fnSource, exempt = {}) {
  const userTables = new Set();
  const cascades = new Set();
  for (const r of liveRows) {
    if (r.kind === 'usercol') userTables.add(r.name.split('.')[0]);
    if (r.kind === 'cascadefk') cascades.add(r.name.split(':')[0]);
  }
  return [...userTables]
    .filter((t) => !exempt[t] && !cascades.has(t) && !fnSource.includes(`'${t}'`))
    .sort();
}

module.exports = {
  deriveExpectations,
  diffAgainstLive,
  diffFunctionBodies,
  findUnexpectedPolicies,
  policyDefHash,
  findUndeletedUserTables,
  liveSiblings,
  LIVE_CATALOG_QUERY,
  // exported for tests
  stripNoise,
  parseStatement,
  extractFunctionBodies,
  hashBody,
  returnsTableColumns,
};
