#!/usr/bin/env node
'use strict';
/**
 * morning-digest-compare.js — cutover tooling for BRO-6230 (Mac-to-cloud Phase 2a).
 * Delete it with the dry-run job once the morning digest sends from GitHub
 * Actions and the Mac job is retired.
 *
 * It answers one question: does the digest the Action builds match the one the
 * Mac sent this morning?
 *
 *   node scripts/morning-digest-compare.js --fetch-mac --out=DIR
 *       Finds today's (ET) "Morning digest" email to OWNER_EMAIL in Resend history
 *       and writes DIR/mac-meta.json ({found, id, created_at, subject, reason}) and,
 *       when Resend still holds the body, DIR/mac.html. Missing is not an error
 *       (exit 0, found:false): the compare step then says there is nothing to compare.
 *   node scripts/morning-digest-compare.js --diff --mac=FILE --action=FILE [--log=FILE] [--pubkey-b64=B64]
 *       Prints a summary that is safe for a public log (line counts and which
 *       section headings each side has; headings are template text plus a few
 *       short status lines such as the CI trunk line, digits masked)
 *       and, with --pubkey-b64, the full line diff sealed to that key between the
 *       run-script markers (decode with cloud-run-script.js's extractOutput + sealed-output open).
 *       --log adds the digest run's own output to the sealed text only.
 *
 * Env: RESEND_API_KEY (full access: list + GET /emails/{id}), OWNER_EMAIL.
 * Exit: 0 done, 2 bad arguments or a Resend read failure.
 */
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `morning-digest-compare.js (BRO-6230 cutover tooling)
  --fetch-mac --out=DIR                              today's Mac digest from Resend into DIR
  --diff --mac=FILE --action=FILE [--log=FILE] [--pubkey-b64=B64]
                                                     public summary + sealed full diff (+ log)
  --help, -h                                         show this message`;

const BEGIN = '=== RUN-SCRIPT OUTPUT BEGIN ===';
const END = '=== RUN-SCRIPT OUTPUT END ===';

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ', middot: '·', mdash: '—', rarr: '→' };

/** Visible text of an HTML email, one block element per line. Pure. */
function htmlToLines(html) {
  return String(html || '')
    .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|table|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#?\w+);/g, (m, e) => {
      if (e in ENTITIES) return ENTITIES[e];
      const n = /^#\d+$/.test(e) ? Number(e.slice(1)) : NaN;
      return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    })
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** Section headings: <h1>-<h4>, or the digest's bold 14px+ title paragraphs. Pure. */
function headings(html) {
  const out = [];
  const re = /<(h[1-4]|p)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    if (m[1].toLowerCase() === 'p' && !/font-size:\s*(1[4-9]|[2-9]\d)px[^"]*font-weight:\s*[6-9]00/.test(m[2])) continue;
    // Titles carry live counts ("3 decisions"); keep the shape so they compare.
    const t = shapeKey(htmlToLines(m[3]).join(' '));
    if (t && t.length <= 80) out.push(t);
  }
  return out;
}

// Numbers and times move between 07:30 and whenever the Action runs; comparing
// on a digit-free key shows structural drift instead of every changed count.
const DATE_WORDS = /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\b|\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b/g;
function shapeKey(line) {
  return line.replace(/\d+([.,:]\d+)*/g, '#').replace(DATE_WORDS, '@').replace(/# (\w+?)s\b/g, '# $1');
}

/**
 * Compare the two digests. Pure.
 * @returns {{public:string, full:string, macOnly:number, actionOnly:number, same:number}}
 */
function compareDigests(macHtml, actionHtml) {
  const mac = htmlToLines(macHtml);
  const act = htmlToLines(actionHtml);
  const actKeys = new Set(act.map(shapeKey));
  const macKeys = new Set(mac.map(shapeKey));
  const macOnly = mac.filter((l) => !actKeys.has(shapeKey(l)));
  const actionOnly = act.filter((l) => !macKeys.has(shapeKey(l)));
  const same = mac.length - macOnly.length;
  const hm = headings(macHtml);
  const ha = headings(actionHtml);
  const pub = [
    `Mac digest: ${mac.length} lines; Action digest: ${act.length} lines.`,
    `Same shape: ${same}; only in Mac: ${macOnly.length}; only in Action: ${actionOnly.length}.`,
    `Headings only in Mac: ${hm.filter((h) => !ha.includes(h)).join(' | ') || '(none)'}`,
    `Headings only in Action: ${ha.filter((h) => !hm.includes(h)).join(' | ') || '(none)'}`,
  ].join('\n');
  const full = [pub, '', '--- only in Mac ---', ...macOnly, '', '--- only in Action ---', ...actionOnly].join('\n');
  return { public: pub, full, macOnly: macOnly.length, actionOnly: actionOnly.length, same };
}

/** Today's newest Mac-sent digest among Resend rows. Pure. */
function pickTodaysDigest(emails, now = new Date()) {
  const { classifySubject, dayKeyET } = require('./lib/scheduled-email-count-rules');
  const today = dayKeyET(now.toISOString());
  const hits = (emails || []).filter((e) => {
    const s = classifySubject(e.subject);
    return s && s.key === 'morning-digest' && dayKeyET(e.created_at) === today;
  });
  hits.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  return { today, email: hits[0] || null };
}

async function fetchMac({ outDir, apiKey, ownerEmail, now = new Date(), fetchImpl = fetch, listImpl = null }) {
  fs.mkdirSync(outDir, { recursive: true });
  const write = (meta) => fs.writeFileSync(path.join(outDir, 'mac-meta.json'), JSON.stringify(meta, null, 2) + '\n');
  if (!apiKey || !ownerEmail) { write({ found: false, reason: 'RESEND_API_KEY or OWNER_EMAIL not set' }); return 2; }
  const list = listImpl || require('./lib/resend-owner-emails.js').fetchOwnerEmailsSince;
  let emails;
  try {
    emails = await list({ apiKey, ownerEmail, sinceMs: now.getTime() - 30 * 3600e3, strict: true });
  } catch (err) {
    write({ found: false, reason: `Resend list failed: ${String(err.message).slice(0, 160)}` });
    return 2;
  }
  const { today, email } = pickTodaysDigest(emails, now);
  if (!email) { write({ found: false, reason: `no Morning digest to the owner on ${today} (ET) yet` }); return 0; }
  const meta = { found: true, id: email.id, created_at: email.created_at, subject: email.subject, body: false };
  try {
    const { fetchEmailById } = require('./lib/resend-owner-emails.js');
    const body = await fetchEmailById({ apiKey, id: email.id, fetchImpl });
    if (body && typeof body.html === 'string' && body.html.length) {
      fs.writeFileSync(path.join(outDir, 'mac.html'), body.html);
      meta.body = true;
    } else {
      meta.reason = 'Resend returned no html for this email (past retention?)';
    }
  } catch (err) {
    meta.reason = `Resend GET /emails/{id} failed: ${String(err.message).slice(0, 120)}`;
  }
  write(meta);
  return 0;
}

function sealedBlock(text, pubB64) {
  const { seal } = require('./lib/sealed-output');
  const pem = Buffer.from(pubB64, 'base64').toString('utf8');
  if (!pem.includes('BEGIN PUBLIC KEY')) throw new Error('--pubkey-b64 is not a PEM public key');
  const blob = JSON.stringify(seal(text, pem));
  const parts = [];
  for (let i = 0; i < blob.length; i += 60000) parts.push(blob.slice(i, i + 60000));
  return [BEGIN, ...parts, END].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['fetch-mac']) {
    if (!args.out || args.out === true) { console.error(USAGE); return 2; }
    const code = await fetchMac({ outDir: args.out, apiKey: process.env.RESEND_API_KEY, ownerEmail: process.env.OWNER_EMAIL });
    const meta = JSON.parse(fs.readFileSync(path.join(args.out, 'mac-meta.json'), 'utf8'));
    console.log(`[compare] Mac digest: ${meta.found ? `found, sent ${meta.created_at}, body ${meta.body ? 'saved' : 'missing'}` : 'not found'}${meta.reason ? ` (${meta.reason})` : ''}`);
    return code;
  }
  if (args.diff) {
    if (typeof args.action !== 'string' || !fs.existsSync(args.action)) { console.error('[compare] --action file missing'); return 2; }
    const hasMac = typeof args.mac === 'string' && fs.existsSync(args.mac);
    if (!hasMac) console.log('[compare] no Mac digest body to compare against; sealing the Action side only.');
    const res = compareDigests(hasMac ? fs.readFileSync(args.mac, 'utf8') : '', fs.readFileSync(args.action, 'utf8'));
    console.log(res.public);
    let full = res.full;
    if (typeof args.log === 'string' && fs.existsSync(args.log)) full += `\n\n--- digest run output ---\n${fs.readFileSync(args.log, 'utf8')}`;
    if (typeof args['pubkey-b64'] === 'string' && args['pubkey-b64']) console.log(sealedBlock(full, args['pubkey-b64']));
    else console.log('[compare] no --pubkey-b64, so the line-level diff is not printed (public log).');
    return 0;
  }
  console.error(USAGE);
  return 2;
}

if (require.main === module) {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }
  main().then((c) => process.exit(c), (err) => { console.error(`[compare] ${err.message}`); process.exit(2); });
}

module.exports = { parseArgs, htmlToLines, headings, shapeKey, compareDigests, pickTodaysDigest, fetchMac, sealedBlock, BEGIN, END };
