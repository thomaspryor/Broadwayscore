// verify-sent-vs-state.mjs — self-heal data/newsletter-state.json's
// featuredShowIds against what was ACTUALLY sent in Resend.
//
// WHY THIS EXISTS (2026-08-16, #the-pass duplicate)
// generate.mjs writes HTML to disk AND commits featuredShowIds to
// data/newsletter-state.json in the same run. create-broadcast-draft.mjs
// separately PATCHes that HTML up to the live Resend draft. Those two steps
// are usually chained by refresh-drafts.sh, but nothing enforces it — a
// regeneration that updates state.json without a matching PATCH (or a PATCH
// that fails silently) leaves the two out of sync. On 2026-08-03 this
// happened: the LAST regeneration for the Broadway edition swapped "The
// Pass" out of featuredShowIds, but the Resend draft was never re-PATCHed to
// match, so subscribers got an email containing "The Pass" that state.json
// had no record of. The following week's anti-repeat guard (which trusts
// state.json, not Resend) saw no prior feature and let it re-air.
//
// This script re-derives ground truth from the actual SENT broadcast HTML
// (every /show/{slug} link in it) and reconciles state.json's featuredShowIds
// for that issue to match. Run --check in CI/cron to catch drift early;
// --fix to correct data/newsletter-state.json in place.
//
// Usage:
//   node scripts/newsletter/verify-sent-vs-state.mjs [--fix] [--edition=broadway|west-end]
// Exit 0: no drift found (or --fix applied and now consistent).
// Exit 1: drift found and not fixed (no --fix), or a fetch/read error.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..', '..');

const KEY = process.env.RESEND_API_KEY;
if (!KEY) { console.error('No RESEND_API_KEY'); process.exit(1); }

const argv = process.argv.slice(2);
const doFix = argv.includes('--fix');
const editionArg = (argv.find((a) => a.startsWith('--edition=')) || '').split('=')[1];

const NAME_PREFIXES = {
  broadway: 'Scorecard Weekly — ',
  'west-end': 'West End Weekly — ',
};
const EDITIONS = editionArg ? [editionArg] : ['broadway', 'west-end'];

const STATE_PATH = path.join(repo, 'data/newsletter-state.json');
const SHOWS_PATH = path.join(repo, 'data/shows.json');

function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

async function resendGet(url) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`Resend GET ${url} failed: ${r.status} ${await r.text()}`);
  return r.json();
}

// Every /show/{slug} link in the sent HTML, query-string stripped, deduped.
function extractSentSlugs(html) {
  const slugs = new Set();
  const re = /\/show\/([a-z0-9-]+)(?:[?"])/gi;
  let m;
  while ((m = re.exec(html))) slugs.add(m[1].toLowerCase());
  return slugs;
}

async function main() {
  const { shows } = loadJson(SHOWS_PATH, { shows: [] });
  const slugToId = new Map(shows.filter((s) => s && s.slug).map((s) => [s.slug, s.id]));

  const state = loadJson(STATE_PATH, { issues: [] });
  let anyDrift = false;
  let fixedAny = false;

  const broadcastsBody = await resendGet('https://api.resend.com/broadcasts');
  const all = (broadcastsBody && broadcastsBody.data) || [];

  for (const edition of EDITIONS) {
    const prefix = NAME_PREFIXES[edition];
    if (!prefix) { console.error(`Unknown edition: ${edition}`); process.exitCode = 1; continue; }

    // The most recently SENT broadcast for this edition, by sent_at.
    const sentBroadcasts = all
      .filter((b) => b && b.status === 'sent' && b.name && b.name.startsWith(prefix))
      .sort((a, b) => (b.sent_at || '').localeCompare(a.sent_at || ''));
    const latest = sentBroadcasts[0];
    if (!latest) { console.log(`[${edition}] no sent broadcast found — nothing to verify`); continue; }

    const weekStartMatch = latest.name.match(/(\d{4}-\d{2}-\d{2})\s*$/);
    const weekStart = weekStartMatch ? weekStartMatch[1] : null;
    if (!weekStart) { console.error(`[${edition}] could not parse weekStart from broadcast name "${latest.name}"`); process.exitCode = 1; continue; }

    const full = await resendGet(`https://api.resend.com/broadcasts/${latest.id}`);
    const sentSlugs = extractSentSlugs(String(full.html || ''));
    const sentIds = new Set([...sentSlugs].map((s) => slugToId.get(s)).filter(Boolean));
    const unmappedSlugs = [...sentSlugs].filter((s) => !slugToId.has(s));

    const issueIdx = state.issues.findIndex(
      (i) => i && i.weekStart === weekStart && (i.edition || 'broadway') === edition
    );
    const stateIds = new Set(issueIdx === -1 ? [] : (state.issues[issueIdx].featuredShowIds || []));

    const missing = [...sentIds].filter((id) => !stateIds.has(id));   // sent but not recorded
    const extra = [...stateIds].filter((id) => !sentIds.has(id));     // recorded but never sent

    if (!missing.length && !extra.length) {
      console.log(`[${edition}] ${weekStart}: state.json matches what was actually sent (${sentIds.size} shows). Clean.`);
      continue;
    }

    anyDrift = true;
    console.log(`[${edition}] ${weekStart}: DRIFT vs actual sent broadcast (id=${latest.id})`);
    if (missing.length) console.log(`  missing from state.json (sent but not recorded — will re-air next issue): ${missing.join(', ')}`);
    if (extra.length) console.log(`  in state.json but never sent (phantom suppression): ${extra.join(', ')}`);
    if (unmappedSlugs.length) console.log(`  note: ${unmappedSlugs.length} /show/ slug(s) in the HTML had no shows.json match: ${unmappedSlugs.join(', ')}`);

    if (doFix) {
      const corrected = [...sentIds];
      if (issueIdx === -1) {
        state.issues.push({ weekStart, edition, moverShowIds: [], announcedClosingShowIds: [], featuredShowIds: corrected });
      } else {
        state.issues[issueIdx].featuredShowIds = corrected;
      }
      fixedAny = true;
      console.log(`  FIXED: featuredShowIds now matches the ${sentIds.size} shows actually sent.`);
    }
  }

  if (fixedAny) {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
    console.log(`Wrote ${STATE_PATH}`);
  }

  if (anyDrift && !doFix) process.exit(1);
}

main().catch((e) => { console.error(e.stack || e); process.exit(1); });
