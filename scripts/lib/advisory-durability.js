'use strict';
/**
 * BRO-7190: WAKEPROMISE / OPENCLAIM advisory hits (verify-edits.sh) used to land only in
 * ~/.claude/state/*.jsonl, which dies with a cloud container, so the hit rate behind
 * PROMISE_GATE_MODE=block / OPENCLAIM_GATE_MODE=block never accumulated. Each hit is now also
 * a comment on the collector card, the same durable channel pause-report-guard.js uses.
 *
 * A record holds only: kind, pattern name, card ids, session id, timestamp. Never message text.
 *
 *   node scripts/lib/advisory-durability.js record --kind=WAKEPROMISE --session=ID [--cards=BRO-1,BRO-2] [--pattern=promise]
 *   node scripts/lib/advisory-durability.js --query [--days=30]     (hit counts from the card comments)
 */
const path = require('path');
const { execFileSync } = require('child_process');

const COLLECTOR_CARD = 'BRO-7190';
const KINDS = Object.freeze(['WAKEPROMISE', 'OPENCLAIM']);
const MARKER_SUFFIX = '-ADVISORY:';
const DEFAULT_PATTERN = { WAKEPROMISE: 'promise', OPENCLAIM: 'open-claim' };

// Strict shapes, not scrubbing: input that does not look like an id is dropped whole, so prose can never ride along.
const PATTERN_NAMES = Object.freeze(['promise', 'open-claim']);
const asId = (s, max) => { const v = String(s == null ? '' : s); return v.length <= max && /^[0-9A-Za-z_-]+$/.test(v) ? v : ''; };

/** @returns {{kind,pattern,cards,session,at}|null} null for an unknown kind. */
function buildRecord({ kind, session, cards, pattern, now } = {}) {
  if (!KINDS.includes(kind)) return null;
  const list = (Array.isArray(cards) ? cards : String(cards || '').split(','))
    .map((c) => String(c).trim()).filter((c) => /^[A-Z]{2,6}-\d{1,6}$/.test(c)).slice(0, 10);
  return {
    kind,
    pattern: PATTERN_NAMES.includes(pattern) ? pattern : DEFAULT_PATTERN[kind],
    cards: list,
    session: asId(session, 64) || 'nosession',
    at: new Date(now == null ? Date.now() : now).toISOString(),
  };
}

const formatComment = (rec) => `${rec.kind}${MARKER_SUFFIX} ${JSON.stringify(rec)}`;

/** Inverse of formatComment; null when the body is not one of ours. */
function parseComment(body) {
  const m = /\b(WAKEPROMISE|OPENCLAIM)-ADVISORY: (\{[^\n]*\})/.exec(String(body || ''));
  if (!m) return null;
  try {
    const rec = JSON.parse(m[2]);
    return rec && rec.kind === m[1] ? rec : null;
  } catch { return null; }
}

function defaultPost(card, comment) {
  const root = process.env.CLAUDE_PROJECT_DIR || path.join(__dirname, '..', '..');
  execFileSync('timeout', ['10', 'node', path.join(root, 'scripts', 'linear-brain.js'), 'update', card, '--comment', comment],
    { stdio: 'ignore', timeout: 12000, cwd: root });
}

/**
 * Write one durable record. Fail-open: never throws. No network without LINEAR_API_KEY.
 * @param {object} p buildRecord input
 * @param {{post?: Function, env?: object, card?: string}} [opts] post(card, comment) is injectable for tests
 * @returns {{ok: boolean, reason?: string, record?: object}}
 */
function recordAdvisory(p, opts = {}) {
  try {
    const env = opts.env || process.env;
    const rec = buildRecord(p);
    if (!rec) return { ok: false, reason: 'bad-kind' };
    if (!env.LINEAR_API_KEY) return { ok: false, reason: 'no-key', record: rec };
    (opts.post || defaultPost)(opts.card || COLLECTOR_CARD, formatComment(rec));
    return { ok: true, record: rec };
  } catch (e) {
    return { ok: false, reason: 'post-failed' };
  }
}

/** Hit counts from comment bodies (or {body} rows). One hit per distinct kind+session+timestamp. */
function countHits(bodies) {
  const out = { total: 0, byKind: { WAKEPROMISE: 0, OPENCLAIM: 0 }, sessions: { WAKEPROMISE: 0, OPENCLAIM: 0 }, firstAt: null, lastAt: null };
  const seen = new Set();
  const sess = { WAKEPROMISE: new Set(), OPENCLAIM: new Set() };
  for (const b of bodies || []) {
    const rec = parseComment(typeof b === 'string' ? b : b && b.body);
    if (!rec) continue;
    const key = `${rec.kind}|${rec.session}|${rec.at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.total += 1;
    out.byKind[rec.kind] += 1;
    sess[rec.kind].add(rec.session);
    if (rec.at && (!out.firstAt || rec.at < out.firstAt)) out.firstAt = rec.at;
    if (rec.at && (!out.lastAt || rec.at > out.lastAt)) out.lastAt = rec.at;
  }
  for (const k of KINDS) out.sessions[k] = sess[k].size;
  return out;
}

async function query(days) {
  const linear = require('./linear-client.js');
  const sinceIso = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const rows = [];
  for (const k of KINDS) rows.push(...await linear.listRecentCommentsContaining({ sinceIso, text: k + MARKER_SUFFIX, max: 5000 }));
  return countHits(rows);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const arg = (n) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : undefined; };
  if (args[0] === 'record') {
    const r = recordAdvisory({ kind: arg('kind'), session: arg('session'), cards: arg('cards'), pattern: arg('pattern') });
    process.exit(r.ok ? 0 : 1);
  } else if (args.includes('--query')) {
    query(Number(arg('days')) || 30).then((r) => console.log(JSON.stringify(r, null, 2)), (e) => { console.error(e.message); process.exit(1); });
  } else {
    console.error('Usage: advisory-durability.js record --kind=WAKEPROMISE|OPENCLAIM --session=ID [--cards=BRO-1] | --query [--days=30]');
    process.exit(2);
  }
}

module.exports = { buildRecord, formatComment, parseComment, recordAdvisory, countHits, query, COLLECTOR_CARD, KINDS, MARKER_SUFFIX };
