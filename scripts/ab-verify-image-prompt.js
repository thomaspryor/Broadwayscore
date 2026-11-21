#!/usr/bin/env node
// venue-write-guard-ok: reads venue from shows.json into verifier options; writes nothing.
/**
 * A/B the show-image verifier: the prompt before BRO-5022 vs the current one.
 *
 * Cases: tests/fixtures/verify-image-ab/cases.json, hand-labelled from contact
 * sheets (known-good live posters across markets and closed London rows, and
 * the wrong art the Google Images tier put on closed rows: the Avengers film
 * poster on Beckett's Endgame, a university Noises Off, other companies'
 * stagings, same-title films).
 *
 * "new" is judged the way production judges it: Google Images hits (cases
 * with a search page) on closed rows in strict mode (applyStrictVerdict),
 * everything else with the default prompt plus creatives/page context and
 * the legacy verdict.
 *
 * Needs GEMINI_API_KEY (run from the cloud with
 *   node scripts/cloud-run-script.js scripts/ab-verify-image-prompt.js).
 * Exit 1 when any known-good image the old prompt accepted is now rejected.
 *
 * Usage: node scripts/ab-verify-image-prompt.js [--old-ref=<sha>] [--limit=N] [--json=out.json]
 */
const fs = require('fs');
const path = require('path');

const USAGE = 'Usage: node scripts/ab-verify-image-prompt.js [--old-ref=<sha>] [--limit=N] [--json=out.json]';
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); process.exit(0); }
const arg = (k, def) => (args.find(a => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=') || def;

// The last commit before BRO-5022 touched verify-image.js.
const OLD_REF = arg('old-ref', '1d0458b5b1e825f357f342f0388313754c9f3f48');
const LIMIT = parseInt(arg('limit', '0'), 10) || 0;
const JSON_OUT = arg('json', '');
const CASES = path.join(__dirname, '..', 'tests', 'fixtures', 'verify-image-ab', 'cases.json');
const LIB = path.join(__dirname, 'lib');

async function fetchBuffer(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return Buffer.from(await r.arrayBuffer());
}

function mimeFor(url) {
  if (/\.webp$/i.test(url)) return 'image/webp';
  if (/\.png$/i.test(url)) return 'image/png';
  return 'image/jpeg';
}

// Load the pre-change verifier next to the live one so its relative requires
// (./models, ./market-label) resolve. Removed in finally.
async function loadOldVerifier() {
  const src = (await fetchBuffer(`https://raw.githubusercontent.com/thomaspryor/Broadwayscore/${OLD_REF}/scripts/lib/verify-image.js`)).toString('utf8');
  const tmp = path.join(LIB, `.ab-old-verify-image-${process.pid}.js`);
  fs.writeFileSync(tmp, src);
  try { return { mod: require(tmp), tmp }; } catch (e) { fs.unlinkSync(tmp); throw e; }
}

const legacyAccept = (r) => r.match === true || !(r.match === false && (r.confidence === 'high' || r.confidence === 'medium'));

async function main() {
  if (!process.env.GEMINI_API_KEY) { console.error('GEMINI_API_KEY is not set'); process.exit(2); }
  const live = require('./lib/verify-image');
  const { cases } = JSON.parse(fs.readFileSync(CASES, 'utf8'));
  const todo = LIMIT ? cases.slice(0, LIMIT) : cases;
  const { mod: old, tmp } = await loadOldVerifier();
  const limiter = live.createRateLimiter(12);
  const rows = [];
  try {
    for (const c of todo) {
      const s = c.show;
      let buf;
      try { buf = await fetchBuffer(c.image); } catch (e) { rows.push({ ...c, error: e.message }); console.log(`! ${s.id}: ${e.message}`); continue; }
      const market = live.resolveMarketSlug(s.category, s.market);
      const base = { year: s.openingDate ? s.openingDate.slice(0, 4) : null, openingDate: s.openingDate, market, venue: s.venue, mimeType: mimeFor(c.image), rateLimiter: limiter };
      const oldRes = await old.verifyImage(buf, s.title, base);
      // Production applies strict mode to Google Images hits on closed rows;
      // cases with a search page are those hits.
      const strict = s.status === 'closed' && !!c.page;
      const newRes = await live.verifyImage(buf, s.title, {
        ...base,
        closingDate: s.status === 'closed' ? s.closingDate : null,
        creatives: live.creativesForVerify(s),
        pageDomain: c.page?.pageDomain || null,
        pageUrl: c.page?.pageUrl || null,
        strict,
      });
      const oldAccept = legacyAccept(oldRes);
      const newVerdict = live.applyStrictVerdict(newRes, { strict });
      const row = {
        id: s.id, label: c.label, strict, image: c.image,
        old: { accept: oldAccept, match: oldRes.match, confidence: oldRes.confidence, issues: oldRes.issues, description: oldRes.description },
        new: { accept: newVerdict.accept, reason: newVerdict.reason, errored: newVerdict.errored, match: newRes.match, confidence: newRes.confidence, workConfirmed: newRes.workConfirmed, productionMatch: newRes.productionMatch, issues: newRes.issues, description: newRes.description },
      };
      rows.push(row);
      console.log(`${c.label.padEnd(4)} ${strict ? 'S' : ' '} old=${oldAccept ? 'ACCEPT' : 'reject'} new=${newVerdict.accept ? 'ACCEPT' : 'reject'}(${newVerdict.reason}) ${s.id} :: ${String(newRes.description).slice(0, 90)}`);
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* gone */ }
  }

  const done = rows.filter(r => !r.error);
  const good = done.filter(r => r.label === 'good');
  const bad = done.filter(r => r.label === 'bad');
  const errored = done.filter(r => r.new.errored);
  const regressions = good.filter(r => r.old.accept && !r.new.accept && !r.new.errored);
  const sum = {
    cases: todo.length, scored: done.length, fetchErrors: rows.length - done.length, verifierErrors: errored.length,
    good: { n: good.length, oldAccepted: good.filter(r => r.old.accept).length, newAccepted: good.filter(r => r.new.accept).length },
    bad: { n: bad.length, oldRejected: bad.filter(r => !r.old.accept).length, newRejected: bad.filter(r => !r.new.accept).length },
    regressions: regressions.map(r => `${r.id} (${r.new.reason}: ${String(r.new.description).slice(0, 80)})`),
  };
  console.log('\nSUMMARY ' + JSON.stringify(sum, null, 2));
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ sum, rows }, null, 2));
  process.exit(regressions.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
