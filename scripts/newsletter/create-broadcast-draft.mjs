// Create a Resend BROADCAST DRAFT for the weekly newsletter. NEVER SENDS.
//
// This is the sanctioned rule-16/rule-17-safe wrapper for the weekly newsletter
// (CLAUDE.md §17 + cloud-memory/email-broadcast-rules.md). It mirrors the
// fantasy path (scripts/fantasy-weekly-email.js --draft): it creates a broadcast
// in DRAFT state and stops. The owner reviews the draft in the Resend dashboard
// and clicks Send there. THERE IS NO SEND PATH IN THIS SCRIPT — no flag, no
// branch, calls POST /broadcasts only, never POST /broadcasts/{id}/send.
//
// Why this exists: "Scorecard Weekly — <date>" broadcasts were created ad-hoc
// every week (manual UI paste, or a one-off API call from a Claude session).
// That meant re-deriving the audience id, the from address, the unsubscribe
// handling, and the lock every single time — and getting it subtly wrong. This
// commits the recipe once.
//
// Usage:
//   node scripts/newsletter/create-broadcast-draft.mjs <weekStart YYYY-MM-DD> [options]
//
// Options:
//   --create                Actually create the draft. WITHOUT this flag the
//                           script is a DRY RUN that only prints what it would do.
//   --status                Read-only: GET /broadcasts, print one word to stdout —
//                           "draft" (unsent, safe to refresh), "sent" (already went
//                           out, do not touch), or "none" (no broadcast with this
//                           name yet). Makes no POST/PATCH call. Does not need the
//                           generated HTML/meta files (unlike --create). Used by
//                           newsletter-draft-refresh.yml to decide whether a
//                           Sunday re-generate is worthwhile before paying for it.
//   --audience=<key>        general (default) | west-end | test. MUST agree
//                           with NEWSLETTER_EDITION (test is exempt): a WE
//                           draft needs BOTH NEWSLETTER_EDITION=west-end (for
//                           WE HTML + sender + broadcast name) AND
//                           --audience=west-end — the script hard-fails on a
//                           mismatch instead of drafting hybrid output.
//   --subject="..."         Override the subject (defaults to meta.json subject).
//   --name="..."            Override the broadcast name (default "Scorecard Weekly — <weekStart>").
//   --out-dir=<path>        Where the generated HTML/meta live (default:
//                           $NEWSLETTER_OUT_DIR or ~/Documents/claude-outputs/newsletter-mocks).
//
// Required env: RESEND_API_KEY. NEWSLETTER_EDITION=west-end for the WE weekly
// (must match the edition generate.mjs ran with — checked via meta.edition).
//
// The HTML is consumed verbatim: the generator emits {{{RESEND_UNSUBSCRIBE_URL}}}
// as the unsubscribe link, and Resend substitutes that token per-recipient at
// broadcast send time. (send-test.mjs replaces it with a real URL because
// transactional sends don't get that substitution — broadcasts do, so we leave
// the token in place here.)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..', '..');
const cjsRequire = createRequire(import.meta.url);
const { buildFromAddress, buildReplyToAddress, resolveNewsletterEdition } = cjsRequire(path.join(repo, 'scripts/lib/email-templates'));
const { shallowFetchArgs } = cjsRequire(path.join(repo, 'scripts/lib/shallow-fetch-args.js'));
// NOTE: deliberately NO send-lock here. The GitHub-backed send-lock (used by the
// actual SEND wrappers) commits data/email-send.lock to the public repo's main
// branch on acquire AND release — 2 commits per run, each tripping CI/deploys.
// This wrapper only ever creates a DRAFT (never sends), so the double-send race
// the lock guards against cannot happen; duplicate drafts are prevented instead
// by the idempotent find-by-name update below + the CI concurrency group.

// --- Audiences (verified live 2026-06-14 via GET /audiences) -------------------
// General is the weekly newsletter list. west-end is the smaller WE list.
// "test" is the dedicated Broadcast Test audience — the ONLY safe place to point
// a throwaway draft (rule 17: never test against a real subscriber audience).
const AUDIENCES = {
  general: { id: '472ec5ef-d7cc-4c48-8007-c0a6a302e7a4', label: 'General' },
  'west-end': { id: '0b17260b-6a72-4a5a-a700-7b7526f18d87', label: 'West End' },
  test: { id: 'b1255239-ad6e-415f-b837-4536c05c6d9b', label: 'Broadcast Test' },
};
const RESEND_BROADCASTS_URL = ['https://api.resend.com', 'broadcasts'].join('/');

// --- Arg parsing ---------------------------------------------------------------
const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('--'));
const flags = {};
for (const a of argv.filter((a) => a.startsWith('--'))) {
  const eq = a.indexOf('=');
  if (eq === -1) flags[a.slice(2)] = true;
  else flags[a.slice(2, eq)] = a.slice(eq + 1);
}

const weekStart = positional[0];
if (!weekStart || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
  console.error('Usage: node scripts/newsletter/create-broadcast-draft.mjs <weekStart YYYY-MM-DD> [--create] [--audience=general|west-end|test] [--subject="..."]');
  process.exit(1);
}
const isCreate = flags.create === true;
// Edition (NEWSLETTER_EDITION) drives the default audience + broadcast name so
// the West End weekly can't collide with the Broadway one in Resend (find-by-
// name would otherwise UPDATE the wrong draft). Explicit --audience wins.
const EDITION = resolveNewsletterEdition(process.env.NEWSLETTER_EDITION); // throws on typos/unknown editions
// Sender display name follows the edition — the WE weekly must arrive from
// "West End Scorecard", not "Broadway Scorecard" (2026-07-12 incident: the WE
// weekly went to subscribers with the Broadway sender). Shared helper keeps
// the mapping in one place with send-opening-night-broadcast.js.
const FROM_EMAIL = buildFromAddress(EDITION);
// Replies to the weekly go to a mailbox that actually receives (see
// buildReplyToAddress) — without this header they'd bounce off the send-only
// `updates@` sender and the owner would never see subscriber replies.
const REPLY_TO = buildReplyToAddress();
const audienceKey = (flags.audience || (EDITION === 'west-end' ? 'west-end' : 'general')).toString();
const audience = AUDIENCES[audienceKey];
if (!audience) {
  console.error(`Unknown audience "${audienceKey}". Valid: ${Object.keys(AUDIENCES).join(', ')}`);
  process.exit(1);
}
// Edition and audience must agree (test audience exempt). A local
// `--audience=west-end` run without NEWSLETTER_EDITION would otherwise draft
// Broadway-edition HTML with a Broadway sender to the WE list — AND, because
// the broadcast name is edition-derived, lookupByName() would find the
// existing BROADWAY draft and PATCH its audience over to West End.
const editionIsWE = EDITION === 'west-end';
if (audienceKey !== 'test' && editionIsWE !== (audienceKey === 'west-end')) {
  console.error(`Edition/audience mismatch: NEWSLETTER_EDITION=${EDITION} but --audience=${audienceKey}.`);
  console.error('The generated HTML, sender name, and broadcast name all follow the edition —');
  console.error(`re-run with NEWSLETTER_EDITION=${audienceKey === 'west-end' ? 'west-end' : 'broadway'} (and regenerate via generate.mjs under that edition first).`);
  process.exit(1);
}

// `name` only depends on EDITION + weekStart (not on the generated HTML/meta), so
// --status can look up the broadcast before generate.mjs has run at all.
const name = (flags.name || (EDITION === 'west-end' ? `West End Weekly — ${weekStart}` : `Scorecard Weekly — ${weekStart}`)).toString();

function apiHeaders() {
  return { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' };
}

async function apiJSON(method, url, payload) {
  const opt = { method, headers: apiHeaders() };
  if (payload !== undefined) opt.body = JSON.stringify(payload);
  const res = await fetch(url, opt);
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    throw new Error(`Resend ${res.status} on ${method}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }
  return body;
}

// Look up broadcasts with this exact name, split by status. Returns the single
// existing DRAFT (so a re-run UPDATES it in place rather than duplicating) plus
// any already-SENT/scheduled broadcasts for the same week (so we can refuse to
// re-draft an issue that already went out — relevant now that CI auto-creates a
// draft every week). SENT broadcasts are never modified by this script.
async function lookupByName() {
  const list = await apiJSON('GET', RESEND_BROADCASTS_URL);
  const all = (list && list.data) || [];
  const named = all.filter((b) => b && b.name === name);
  const drafts = named.filter((b) => b.status === 'draft');
  const sent = named.filter((b) => b.status !== 'draft');
  if (drafts.length > 1) {
    throw new Error(`${drafts.length} draft broadcasts named "${name}" exist — refusing to guess which to update. Resolve in the Resend UI.`);
  }
  return { draft: drafts[0] || null, sent };
}

if (flags.status) {
  if (!process.env.RESEND_API_KEY) {
    console.error('RESEND_API_KEY is required for --status.');
    process.exit(1);
  }
  (async () => {
    try {
      const { draft, sent } = await lookupByName();
      if (sent.length) { console.log('sent'); return; }
      if (draft) { console.log('draft'); return; }
      console.log('none');
    } catch (e) {
      console.error(`Status check failed: ${e.message}`);
      process.exitCode = 1;
    }
  })();
} else {

const outDir = (flags['out-dir'] || process.env.NEWSLETTER_OUT_DIR
  || path.join(os.homedir(), 'Documents/claude-outputs/newsletter-mocks')).toString();
const htmlPath = path.join(outDir, `A-${weekStart}.html`);
const metaPath = path.join(outDir, `A-${weekStart}.meta.json`);
if (!fs.existsSync(htmlPath) || !fs.existsSync(metaPath)) {
  console.error(`Missing generated files for ${weekStart} in ${outDir}`);
  console.error(`Expected: ${path.basename(htmlPath)} + ${path.basename(metaPath)}`);
  console.error('Run scripts/newsletter/generate.mjs first (with SUBJECT_OVERRIDE/LEDE_OVERRIDE if needed).');
  process.exit(1);
}

let html = fs.readFileSync(htmlPath, 'utf8');
// Strip the pre-send-check soft-issue banner before it can reach a SUBSCRIBER
// draft (task #746). pre-send-check.mjs injects the banner into the generated
// HTML so the owner sees warnings in the preview email — but this script
// PATCHes that same file into the real audience broadcast, and on 2026-08-02
// the operator had to hand-strip the banner twice on a live send night. The
// banner is owner-review chrome, never subscriber content; the issues it
// carried are still visible in pre-send-check's console output and CI
// annotations. Builder + stripper share scripts/lib/pre-send-banner.js so
// the markup and the strip regex can never drift apart.
{
  const { stripPreSendBanner } = cjsRequire(path.join(repo, 'scripts/lib/pre-send-banner.js'));
  const res = stripPreSendBanner(html);
  if (res.stripped) {
    html = res.html;
    console.warn('⚠️  Stripped pre-send soft-issue banner from draft HTML before PATCH (subscribers must never see it — task #746). Review the pre-send-check output for the underlying issues.');
  }
}
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
const subject = (flags.subject || meta.subject || '').toString().trim();

// --- Sanity gates (fail loudly before any API call) ----------------------------
const problems = [];
if (!subject) problems.push('Subject is empty (no meta.subject and no --subject).');
// The out-dir slug (A-<weekStart>) is shared across editions, so a WE draft
// run can silently pick up Broadway HTML generated earlier (or vice versa).
// generate.mjs stamps meta.edition; legacy metas without it are Broadway.
const metaEdition = (meta.edition || 'broadway');
if (metaEdition !== EDITION) {
  problems.push(`Generated HTML is the "${metaEdition}" edition but NEWSLETTER_EDITION=${EDITION} — re-run generate.mjs under this edition first.`);
}
if (/^scorecard weekly:/i.test(subject)) problems.push('Subject uses the banned "Scorecard Weekly:" prefix (see pre-send-check.mjs).');
if (!html.includes('{{{RESEND_UNSUBSCRIBE_URL}}}')) problems.push('HTML is missing the {{{RESEND_UNSUBSCRIBE_URL}}} token — Resend needs it to render an unsubscribe link.');
if (problems.length) {
  console.error('Refusing to proceed:');
  for (const p of problems) console.error('  • ' + p);
  process.exit(1);
}

function summary() {
  console.error('Newsletter broadcast draft');
  console.error(`  weekStart : ${weekStart}`);
  console.error(`  audience  : ${audience.label} (${audience.id})`);
  console.error(`  name      : ${name}`);
  console.error(`  subject   : ${subject}`);
  console.error(`  from      : ${FROM_EMAIL}`);
  console.error(`  reply-to  : ${REPLY_TO}`);
  console.error(`  html      : ${htmlPath} (${html.length} bytes)`);
}

// Data-freshness gate. The newsletter reads data/reviews.json + data/shows.json,
// which are usually symlinks into the local broadway-scorecard-data checkout. If
// that checkout is behind origin, the draft is built on stale data and recent
// reviews silently go missing — e.g. a show that just opened (Romeo & Juliet)
// shows zero reviews, so it can't be an Outlier or Mover. CI avoids this by
// checking out fresh core data every run; a local session has no such guard.
// This refuses to create/update a draft while the data repo is behind origin.
function dataRepoStaleness() {
  let dir;
  try {
    dir = path.dirname(fs.realpathSync(path.join(repo, 'data/reviews.json')));
    // Depth-bound the fetch when that checkout is SHALLOW (task #420/#466).
    // .github/actions/checkout-core-data clones the data repo with --depth 1,
    // and from a shallow clone a fetch with no cut-off makes upload-pack send
    // the whole repository rather than the delta — a multi-GB transfer inside
    // a 30s timeout, i.e. this staleness probe silently always fails in CI.
    // A complete clone (a local session) correctly gets no extra flags.
    let isShallow = false;
    try {
      isShallow = execFileSync('git', ['-C', dir, 'rev-parse', '--is-shallow-repository'], { encoding: 'utf8', timeout: 10000 }).trim() === 'true';
    } catch { /* fail open — treat as complete */ }
    const oldestCommitEpoch = isShallow
      ? Number(execFileSync('git', ['-C', dir, 'log', '-1', '--format=%ct', 'HEAD'], { encoding: 'utf8', timeout: 10000 }).trim())
      : 0;
    const depthArgs = shallowFetchArgs({ isShallow, oldestCommitEpoch });
    // unbounded-fetch-ok: depthArgs IS the bound; the lint can't evaluate a spread.
    execFileSync('git', ['-C', dir, 'fetch', ...depthArgs, '--quiet'], { stdio: 'ignore', timeout: 30000 });
    const behind = parseInt(execFileSync('git', ['-C', dir, 'rev-list', '--count', 'HEAD..@{u}'], { encoding: 'utf8' }).trim(), 10);
    return { dir, behind: Number.isFinite(behind) ? behind : null };
  } catch (e) {
    return { dir: dir || null, behind: null, error: e.message };
  }
}

(async () => {
  summary();

  if (!isCreate) {
    console.error('\n[DRY RUN] No draft created. Re-run with --create to create the draft in Resend.');
    return;
  }

  if (!process.env.RESEND_API_KEY) {
    console.error('\nRESEND_API_KEY is required for --create.');
    process.exit(1);
  }

  // Freshness gate is a LOCAL-dev guard (a developer's data checkout can lag
  // origin). In CI the core data is freshly checked out every run, so the gate
  // is both unnecessary and unreliable (no upstream ref to diff against) — skip it.
  if (process.env.CI) {
    console.error('  freshness : CI run — core data freshly checked out, gate skipped');
  } else {
    const fresh = dataRepoStaleness();
    if (fresh.behind && fresh.behind > 0 && !flags['allow-stale']) {
      console.error(`\n✗ Local data is ${fresh.behind} commit(s) behind origin: ${fresh.dir}`);
      console.error('  reviews.json/shows.json are stale — recent reviews (e.g. a just-opened show) would be MISSING from the draft.');
      console.error('  Fix:');
      console.error(`    git -C ${fresh.dir} pull --ff-only`);
      console.error(`    node scripts/newsletter/generate.mjs ${weekStart}    # regenerate on fresh data`);
      console.error('    (then re-run this command)');
      console.error('  Override (NOT recommended): add --allow-stale.');
      process.exit(1);
    }
    if (fresh.behind == null) {
      console.error(`  freshness : could not verify (${fresh.error || 'unknown'}) — proceeding`);
    } else {
      console.error('  freshness : data repo up to date with origin');
    }
  }

  try {
    const payload = { audience_id: audience.id, from: FROM_EMAIL, reply_to: REPLY_TO, subject, html, name };
    const { draft, sent } = await lookupByName();
    if (sent.length) {
      // The owner already sent this week's issue — do not create a confusing
      // post-send draft. (Never modify the sent broadcast.)
      console.error(`\nA broadcast named "${name}" is already ${sent[0].status} (not a draft). Skipping — refusing to re-draft an issue that already went out.`);
      return;
    }
    let id;
    if (draft) {
      await apiJSON('PATCH', `${RESEND_BROADCASTS_URL}/${draft.id}`, payload);
      id = draft.id;
      console.error(`\n✓ Existing draft updated: ${id}`);
    } else {
      const result = await apiJSON('POST', RESEND_BROADCASTS_URL, payload);
      id = result && result.id;
      console.error(`\n✓ Draft created: ${id}`);
    }
    console.error(`  Review & send in Resend: https://resend.com/broadcasts/${id}`);
    console.error('  This script did NOT send. Open the link, review, and hit Send in the Resend UI.');
  } catch (e) {
    console.error(`\n✗ Draft create/update failed: ${e.message}`);
    process.exitCode = 1;
  }
})();

}
