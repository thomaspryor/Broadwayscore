#!/usr/bin/env node
'use strict';
/**
 * rejudge-settled-pending.js (BRO-8090): re-judge _pending stubs the OLD rules settled, with the corrected rules.
 *   A) "not this show (url-token-mismatch)" on an OPAQUE url  -> un-settle (back to a fetch candidate)
 *   B) "outside this production's window" where exactly one same-title sibling's window holds the date
 *        -> rehome to the sibling's _pending (or settle as duplicate when the sibling already holds the url)
 * Nothing is deleted. Dry by default.
 *   node scripts/rejudge-settled-pending.js --root=<review-texts root> [--apply] [--limit=N] [--sample=N]
 *   --shows-json / --reviews-json override data/shows.json / data/reviews.json.
 */
const fs = require('fs');
const path = require('path');
const { isOpaqueSlug } = require('./lib/show-match-verifier');
const { listShowDirs } = require('./lib/list-show-dirs');
const { resolveOutOfWindowStub, rehomeStubFile, siblingHoldsSameUrl } = require('./lib/pending-sibling-productions');
const { buildHeldUrlIndex, normalizeReviewUrl, showEra, triagePendingStub, sameTitleShowsFrom, stubDateIso } = require('./lib/pending-triage');

const OUT_OF_WINDOW_RE = /outside this production's window|date-out-of-window/;
const REASON_DATE_RE = /(?:published|publishDate)\s+(\d{4}-\d{2}-\d{2})/;

/** A bare host or "/" is a venue/outlet homepage, not an article: it stays settled. */
function hasArticlePath(url) { try { return new URL(String(url)).pathname.replace(/\//g, '').length > 0; } catch { return false; } }

/** Decide one settled stub. Pure over its inputs. Returns {action:'unsettle'|'rehome'|'duplicate'|'keep', ...}. */
function rejudgeSettledStub({ stub, show, allShows, hasCopy = () => false, holdsUrl = () => false, sameTitleShows, heldIndex }) {
  const reason = String((stub && stub.promoteSkippedReason) || '');
  if (!reason) return { action: 'keep', why: 'not settled' };
  if (stub.promoteSettled === 'sibling') return { action: 'keep', why: 'already settled onto a sibling' };
  if (/url-token-mismatch/.test(reason) && isOpaqueSlug(stub.url) && hasArticlePath(stub.url)) return { action: 'unsettle', why: 'opaque url settled by url-token-mismatch' };
  // BRO-8023 no-fetch cousins: the url's own date, or a sibling's venue in the slug. Re-run the corrected triage on the
  // stub with its settle stripped; only a rehome / sibling-duplicate verdict changes anything.
  if (/^url date \S+ is more than a year outside|^url names the .* production \(/.test(reason)) {
    const bare = { ...stub }; for (const k of ['promoteSkippedReason', 'promoteSkippedAt', 'promoteSettled', 'promoteSettledSibling']) delete bare[k];
    const v = triagePendingStub(bare, { showId: show.id, show, allShows, sameTitleShows: sameTitleShows || sameTitleShowsFrom(show, allShows), siblingHasCopy: hasCopy, heldIndex: heldIndex || undefined });
    if (v.verdict === 'rehome') return { action: 'rehome', sibling: v.sibling, date: v.publishDate || null };
    if (v.verdict === 'junk' && v.sibling) return { action: 'duplicate', sibling: v.sibling, date: null };
    return { action: 'keep', why: `triage-${v.verdict}` };
  }
  if (OUT_OF_WINDOW_RE.test(reason)) {
    const m = reason.match(REASON_DATE_RE);
    const date = m ? m[1] : stubDateIso(stub.publishDate);
    if (!date) return { action: 'keep', why: 'no date in settle reason' };
    const r = resolveOutOfWindowStub({ show, allShows, publishDate: date, stub, hasCopy, holdsUrl });
    if (r.kind === 'rehome') return { action: 'rehome', sibling: r.sibling, date };
    if (r.kind === 'duplicate') return { action: 'duplicate', sibling: r.sibling, date };
    return { action: 'keep', why: r.kind };
  }
  return { action: 'keep', why: 'other settle' };
}

const USAGE = `Usage: node scripts/rejudge-settled-pending.js --root=<review-texts root> [--apply] [--limit=N] [--sample=N]
  [--actions=<jsonl out>] [--shows-json=<path>] [--reviews-json=<path>]
Re-judges _pending stubs settled by the pre-BRO-8090 rules. Dry by default; --apply moves/unsettles files.`;

function main() {
  if (require('./lib/cli-help.js').hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }
  const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v === undefined ? true : v]; }));
  const root = args.root; if (!root) { console.error('--root required'); process.exit(2); }
  const apply = !!args.apply; const limit = Number(args.limit) || Infinity; const sampleN = Number(args.sample) || 0;
  const rd = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  const sj = rd(args['shows-json'] || path.join(__dirname, '../data/shows.json')); const allShows = sj.shows || sj;
  const byId = new Map(allShows.map((s) => [s.id, s]));
  let held = null;
  try { const rj = rd(args['reviews-json'] || path.join(__dirname, '../data/reviews.json')); held = buildHeldUrlIndex(rj.reviews || rj); } catch (e) { console.error(`held index unavailable: ${e.message}`); }
  // --apply moves files on these two inputs: a cloud stub shows.json or a missing held-url index would turn
  // duplicates into rehomes (a second copy under the sibling). Refuse rather than guess.
  if (apply && (!held || allShows.length < 1000)) { console.error(`refusing --apply: ${!held ? 'held-url index unavailable' : `shows.json has only ${allShows.length} shows`}`); process.exit(2); }
  const now = new Date().toISOString();
  const tally = {}; const actions = []; let changed = 0;
  for (const showId of listShowDirs(path.join(root, '_pending'), { silent: true }).sort()) {
    const dir = path.join(root, '_pending', showId);
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      let stub; try { stub = rd(path.join(dir, file)); } catch { continue; }
      if (!stub.promoteSkippedReason) continue;
      const show = byId.get(showId); if (!show) continue;
      const v = rejudgeSettledStub({ stub, show, allShows,
        hasCopy: (sid) => siblingHoldsSameUrl({ root, toShowId: sid, file, url: stub.url }),
        holdsUrl: (sid) => !!(held && (held.get(normalizeReviewUrl(stub.url)) || new Set()).has(sid)), heldIndex: held });
      const key = `${v.action}${v.why ? `:${v.why}` : ''}|${showEra(showId)}`;
      tally[key] = (tally[key] || 0) + 1;
      if (v.action === 'keep' || changed >= limit) continue;
      actions.push({ showId, file, url: stub.url, ...v });
      if (!apply) { changed++; continue; }
      if (v.action === 'unsettle') {
        for (const k of ['promoteSkippedReason', 'promoteSkippedAt', 'promoteSettled', 'promoteSettledSibling', 'pendingFetchAttemptedAt', 'pendingFetchAttemptResult']) delete stub[k];
        stub.unsettledAt = now; stub.unsettledBy = 'BRO-8090 opaque-url';
        fs.writeFileSync(path.join(dir, file), JSON.stringify(stub, null, 2));
      } else if (v.action === 'rehome') {
        const out = rehomeStubFile({ root, file, fromShowId: showId, toShowId: v.sibling, data: stub, publishDate: v.date, nowIso: now });
        if (out === 'sibling-copy-settled') { tally[`keep:sibling copy settled|${showEra(showId)}`] = (tally[`keep:sibling copy settled|${showEra(showId)}`] || 0) + 1; continue; }
        if (out !== 'rehomed') { stub.promoteSettled = 'sibling'; stub.promoteSettledSibling = v.sibling; stub.promoteSkippedReason += `; belongs to ${v.sibling}, whose _pending copy carries it (BRO-8090)`; fs.writeFileSync(path.join(dir, file), JSON.stringify(stub, null, 2)); }
      } else if (v.action === 'duplicate') {
        stub.promoteSettled = 'sibling'; stub.promoteSettledSibling = v.sibling; stub.promoteSkippedReason += `; belongs to ${v.sibling}, which already holds this url (BRO-8090)`;
        fs.writeFileSync(path.join(dir, file), JSON.stringify(stub, null, 2));
      }
      changed++;
    }
  }
  console.log(JSON.stringify({ apply, changed, tally }, null, 2));
  if (sampleN) {
    const pick = [...actions].sort(() => Math.random() - 0.5).slice(0, sampleN);
    for (const a of pick) console.log(`SAMPLE ${a.action} ${a.showId}/${a.file} ${a.sibling ? `-> ${a.sibling} ` : ''}${a.date || ''} ${a.url}`);
  }
  if (args.actions) fs.writeFileSync(args.actions, actions.map((a) => JSON.stringify(a)).join('\n'));
}
if (require.main === module) main();
module.exports = { rejudgeSettledStub };
