#!/usr/bin/env node
/**
 * supabase-custom-domain.mjs — set up and operate the Supabase custom auth
 * domain (BRO-4894), run by .github/workflows/supabase-custom-domain.yml.
 *
 * Why: Google's account chooser named the Supabase host
 * ("Sign in to continue to <ref>.supabase.co") and about 40% of Google
 * sign-ins backed out there. With a custom domain the chooser names
 * auth.broadwayscorecard.com instead. DNS lives in Vercel, the owner is not
 * technical, and the only tokens exist as GitHub secrets, so every step runs
 * from the workflow.
 *
 * Steps, in the order Supabase documents them (docs/guides/platform/custom-domains):
 *   dns         CNAME <host> -> <ref>.supabase.co in Vercel, then wait until a
 *               public resolver answers with it (Supabase checks that first).
 *   initialize  Register the hostname with Supabase; it answers with the TXT
 *               verification records, which are added to Vercel too.
 *   reverify    Ask Supabase to check DNS again and issue the certificate.
 *               Exit 0 when verified (ready to activate), 2 while pending.
 *   activate    Switch auth to the custom host. Refused unless CONFIRM is
 *               ACTIVATE, the hostname is verified, and Google accepts
 *               https://<host>/auth/v1/callback as a redirect (probed live:
 *               a redirect_uri_mismatch page means the owner has not added
 *               it to the OAuth client yet, and activating would break every
 *               Google sign-in on the web).
 *   create      dns, then initialize, then one reverify.
 *   status      Read-only: Supabase's view plus the Vercel records on the name.
 *   delete      Remove the custom hostname and the records this script made.
 *               Refused unless CONFIRM is DELETE.
 *
 * The old <ref>.supabase.co host keeps working after activation (Supabase
 * docs), so client code needs no change for sign-in to recover.
 *
 * Env: SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF, VERCEL_TOKEN,
 *      VERCEL_TEAM_ID (optional), CUSTOM_HOSTNAME, ACTION, CONFIRM,
 *      GOOGLE_OAUTH_CLIENT_ID (optional fallback for the probe),
 *      GITHUB_STEP_SUMMARY (optional).
 * Exit: 0 done / ready, 1 failed or refused, 2 pending (run again later).
 */
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createRecord, deleteRecord, listRecords, planDns, recordsToDelete, DEFAULT_TEAM_ID } from './lib/vercel-dns.mjs';

export const ZONE = 'broadwayscorecard.com';
const SUPABASE_API = 'https://api.supabase.com';
export const ACTIONS = ['status', 'dns', 'initialize', 'reverify', 'activate', 'create', 'delete'];
const CNAME_WAIT_MS = 6 * 60 * 1000;
const CNAME_POLL_MS = 20 * 1000;

// ─── pure helpers (tested in scripts/supabase-custom-domain.test.mjs) ───

/** One label under the zone, never the apex or www. Returns the label. */
export function validateHostname(host) {
  const h = String(host || '').trim().toLowerCase().replace(/\.$/, '');
  const m = h.match(/^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.broadwayscorecard\.com$/);
  if (!m) throw new Error(`hostname must be one label under ${ZONE}, e.g. auth.${ZONE} (got "${host}")`);
  if (m[1] === 'www') throw new Error('www is the website, pick another label');
  return m[1];
}

/** Relative name inside the zone: "_acme-challenge.auth.broadwayscorecard.com." -> "_acme-challenge.auth". */
export function relativeName(name) {
  const n = String(name || '').trim().replace(/\.$/, '').toLowerCase();
  return n.endsWith(`.${ZONE}`) ? n.slice(0, -(ZONE.length + 1)) : n;
}

/**
 * Every TXT record Supabase wants, from whatever shape its API answers with:
 * objects carrying txt_name/txt_value (SSL validation) or name/type/value
 * with type TXT (ownership verification). Names come back relative to the
 * zone. Tolerant on purpose: a renamed field shows up as "no records" in
 * the run log next to the raw JSON, not as a crash.
 */
export function collectTxtRecords(json) {
  const out = [];
  const seen = new Set();
  const add = (name, value) => {
    if (!name || !value) return;
    const key = `${relativeName(name)}|${String(value).trim()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name: relativeName(name), type: 'TXT', value: String(value).trim() });
  };
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node.txt_name === 'string' && typeof node.txt_value === 'string') add(node.txt_name, node.txt_value);
    if (String(node.type || '').toUpperCase() === 'TXT' && typeof node.name === 'string' && typeof node.value === 'string') add(node.name, node.value);
    for (const v of Object.values(node)) walk(v);
  };
  walk(json);
  return out;
}

/**
 * Where the hostname stands, from Supabase's custom-hostname response.
 * Supabase reports a numbered status ("2_initiated" ... "5_services_reconfigured")
 * plus the certificate state; the exact strings are an assumption checked
 * against the raw JSON the workflow prints.
 *   none      not registered (404 or empty)
 *   failed    validation errors, or the certificate failed
 *   active    5_services_reconfigured: auth answers on the custom host
 *   verified  DNS verified and certificate issued: ready to activate
 *   pending   anything else
 */
export function judgeStatus(json) {
  if (!json || typeof json !== 'object') return { phase: 'none', detail: 'no custom hostname registered' };
  // Supabase's numbered status sits at the top level ({ status, custom_hostname,
  // data: <Cloudflare envelope> }); older shapes put it under data. Take the
  // first value that looks like one.
  const numbered = (v) => (typeof v === 'string' && /^\d_/.test(v) ? v : null);
  const status = numbered(json.status) || numbered(json.data && json.data.status) || '';
  const hostname = json.custom_hostname || (json.data && json.data.custom_hostname) || findKey(json, 'hostname');
  if (!status && !hostname) return { phase: 'none', detail: 'no custom hostname registered' };
  const errors = [];
  for (const k of ['validation_errors', 'verification_errors', 'errors']) {
    for (const list of findAll(json, k)) if (Array.isArray(list)) errors.push(...list);
  }
  const sslObj = findAll(json, 'ssl').find((o) => o && typeof o === 'object' && 'status' in o);
  const ssl = sslObj ? String(sslObj.status || '') : '';
  if (errors.length) return { phase: 'failed', detail: `validation errors: ${errors.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('; ').slice(0, 300)}` };
  if (/fail|timed_out|expired|error/i.test(ssl)) return { phase: 'failed', detail: `certificate ${ssl}` };
  if (/^5_/.test(status)) return { phase: 'active', detail: `${status}, certificate ${ssl || 'n/a'}` };
  if (/^4_/.test(status) || (/^3_/.test(status) && /active/i.test(ssl))) return { phase: 'verified', detail: `${status}, certificate ${ssl || 'n/a'}` };
  return { phase: 'pending', detail: `${status || 'unknown status'}, certificate ${ssl || 'pending'}` };
}

/** Every value stored under `key` anywhere in the tree (shape-tolerant reads). */
export function findAll(node, key, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => findAll(n, key, out)); return out; }
  for (const [k, v] of Object.entries(node)) {
    if (k === key) out.push(v);
    findAll(v, key, out);
  }
  return out;
}

function findKey(node, key) {
  return findAll(node, key).find((v) => typeof v === 'string') || null;
}

/** 0 done, 1 broken, 2 pending: what a workflow run should exit with. */
export function exitCodeFor(action, phase) {
  if (phase === 'failed') return 1;
  if (action === 'status') return 0;
  if (action === 'activate') return phase === 'active' ? 0 : 1;
  if (action === 'delete') return phase === 'none' ? 0 : 1;
  // dns, initialize, reverify, create: done once verified (or already active)
  return phase === 'verified' || phase === 'active' ? 0 : 2;
}

/** Google's own error markers for a callback the OAuth client does not list. */
export const GOOGLE_MISMATCH_MARKERS = /Error 400: redirect_uri_mismatch|data-error-code="redirect_uri_mismatch"|"redirect_uri_mismatch",/i;
/** Any other Google OAuth error page (invalid_client, disallowed_useragent, ...). */
export const GOOGLE_ERROR_MARKERS = /Error \d{3}: [a-z_]+|\/signin\/oauth\/error|data-error-code=/i;
/** What a real account chooser or sign-in page contains (error pages link to /signin/oauth/error, so that path is not evidence). */
export const GOOGLE_SIGNIN_MARKERS = /Choose an account|identifierId|to continue to/i;
/** A real phone browser: Google serves other agents a different, uninformative page (the 2026-10-09 false pass). */
export const GOOGLE_PROBE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

/**
 * Does Google accept our custom callback? Google's authorize page shows
 * "Error 400: redirect_uri_mismatch" for a callback the OAuth client does
 * not list, and it can serve that page with HTTP 200 (seen live
 * 2026-10-09), so the verdict reads the page, not the status. Only a page
 * that looks like the real account chooser passes; anything else is
 * inconclusive and activation is refused.
 */
export function judgeGoogleRedirectProbe(page) {
  if (!page) return { ok: false, inconclusive: true, reason: 'Google could not be reached' };
  if (page.status === 429 || page.status >= 500) return { ok: false, inconclusive: true, reason: `Google answered HTTP ${page.status}` };
  const body = page.body || '';
  if (GOOGLE_MISMATCH_MARKERS.test(body)) return { ok: false, reason: 'Google rejects the callback (redirect_uri_mismatch): add it to the OAuth client first' };
  const other = body.match(GOOGLE_ERROR_MARKERS);
  if (other) return { ok: false, reason: `Google shows an error page (${other[0].slice(0, 60)})` };
  if (page.status >= 400) return { ok: false, reason: `Google answered HTTP ${page.status}` };
  if (!GOOGLE_SIGNIN_MARKERS.test(body)) return { ok: false, inconclusive: true, reason: 'Google answered with a page that is neither the account chooser nor an error; not activating on a guess' };
  return { ok: true, reason: 'Google shows its account chooser for the callback' };
}

/** The callback the Google OAuth client must list before activation. */
export function googleCallbackUrl(host) {
  return `https://${host}/auth/v1/callback`;
}

/**
 * Plain words for the owner's run summary: what happened and what comes
 * next. Phases are judgeStatus() phases; 'dns' is the CNAME-only step.
 */
export function nextStep(action, phase, host) {
  if (phase === 'failed') return 'Something is wrong (details above). Nothing changed for visitors. Fix what it names (a missing secret, a DNS conflict, a Supabase refusal), or ask for help, then run the same step again.';
  if (action === 'delete') return phase === 'none' ? 'The custom domain is gone. Sign-in is back on the Supabase address. Nothing else to do.' : 'The custom domain is still there; run delete again or ask for help.';
  if (phase === 'active') return `Done. Google's sign-in screen now names ${host}. Nothing else to do.`;
  if (phase === 'verified') return `Verified and ready. Add ${googleCallbackUrl(host)} to the Google OAuth client (Google Cloud console > APIs & Services > Credentials > the web client > Authorized redirect URIs, keep the existing one too), then run activate with confirm ACTIVATE.`;
  if (action === 'dns') return phase === 'pending' ? 'The DNS record is in Vercel but the internet does not show it yet. Wait a few minutes, then run create again (or initialize).' : 'DNS is set. Run create again (or initialize).';
  if (action === 'status' && phase === 'none') return 'Nothing is set up yet. Run create.';
  return 'Waiting for Supabase to confirm DNS and issue the certificate (up to 30 minutes). Nothing is broken. Run reverify until it says verified.';
}

/** Values of keys that look like credentials are blanked before printing. */
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = /token|secret|pass|key|private|credential/i.test(k) ? '[redacted]' : redact(v);
    return out;
  }
  return value;
}

export function wantedRecords(label, projectRef, txts = []) {
  return [{ name: label, type: 'CNAME', value: `${projectRef}.supabase.co`, comment: 'Supabase custom domain (BRO-4894)' }, ...txts.map((t) => ({ ...t, comment: 'Supabase custom domain verification (BRO-4894)' }))];
}

// ─── side effects ───

const log = (...a) => console.log(...a);
const summaryLines = [];
function summary(line) { summaryLines.push(line); log(line); }
function flushSummary() {
  if (process.env.GITHUB_STEP_SUMMARY && summaryLines.length) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Supabase custom domain\n\n${summaryLines.map((l) => `- ${l}`).join('\n')}\n`);
  }
}

async function supabase(method, path, { token, ref, body, quiet = false } = {}) {
  const res = await fetch(`${SUPABASE_API}/v1/projects/${ref}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 500) }; }
  if (quiet) log(`Supabase ${method} ${path} -> HTTP ${res.status} (body not printed)`);
  else log(`Supabase ${method} ${path} -> HTTP ${res.status}\n${JSON.stringify(redact(json), null, 2)}`);
  return { status: res.status, json };
}

async function resolveCname(host) {
  try {
    const res = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(host)}&type=CNAME`, { signal: AbortSignal.timeout(15000) });
    const json = await res.json();
    return (json.Answer || []).filter((a) => a.type === 5).map((a) => String(a.data).replace(/\.$/, '').toLowerCase());
  } catch {
    return [];
  }
}

async function ensureRecords(ctx, wanted) {
  const existing = await listRecords(ZONE, ctx.vercel);
  const plan = planDns(existing, wanted);
  for (const w of plan.skip) summary(`DNS ${w.type} ${w.name} already set`);
  if (plan.conflicts.length) {
    for (const c of plan.conflicts) summary(`DNS conflict on ${c.wanted.name}: ${c.existing.map((r) => `${r.type} ${r.value} (id ${r.id})`).join(', ')} stands in the way of ${c.wanted.type} ${c.wanted.value}. Remove it in Vercel (Domains > ${ZONE} > DNS records) and run again.`);
    throw new Error('DNS conflict');
  }
  for (const w of plan.create) {
    const id = await createRecord(ZONE, w, ctx.vercel);
    summary(`DNS ${w.type} ${w.name} -> ${w.value} created (id ${id})`);
  }
  return plan;
}

/** The Management API answers "nothing configured" as HTTP 400 with this message (seen live 2026-10-09), not 404. */
export function isNotConfigured(status, json) {
  if (status === 404) return true;
  return status === 400 && /no custom hostname/i.test(String(json && json.message || ''));
}

async function getStatus(ctx) {
  const r = await supabase('GET', '/custom-hostname', ctx.sb);
  if (isNotConfigured(r.status, r.json)) return { phase: 'none', detail: 'no custom hostname registered', json: null };
  if (r.status >= 400) throw new Error(`Supabase custom-hostname read failed: HTTP ${r.status}${r.json && r.json.message ? ` ${r.json.message}` : ''}`);
  return { ...judgeStatus(r.json), json: r.json };
}

async function actStatus(ctx) {
  const st = await getStatus(ctx);
  summary(`Supabase: ${st.phase} (${st.detail})`);
  const existing = await listRecords(ZONE, ctx.vercel);
  const mine = existing.filter((r) => { const n = String(r.name).toLowerCase(); return n === ctx.label || n.endsWith(`.${ctx.label}`); });
  summary(mine.length ? `Vercel records on ${ctx.label}: ${mine.map((r) => `${r.type} ${r.name} = ${r.value}`).join('; ')}` : `Vercel has no records on ${ctx.label}`);
  const seen = await resolveCname(ctx.host);
  summary(seen.length ? `public DNS answers CNAME ${seen.join(', ')}` : 'public DNS shows no CNAME yet');
  return st.phase;
}

async function actDns(ctx) {
  await ensureRecords(ctx, wantedRecords(ctx.label, ctx.ref));
  const target = `${ctx.ref}.supabase.co`;
  const started = Date.now();
  while (Date.now() - started < CNAME_WAIT_MS) {
    const seen = await resolveCname(ctx.host);
    if (seen.includes(target)) { summary(`public DNS now answers CNAME ${ctx.host} -> ${target}`); return true; }
    await new Promise((r) => setTimeout(r, CNAME_POLL_MS));
  }
  summary(`public DNS does not show the CNAME yet after ${CNAME_WAIT_MS / 60000} min; wait a few minutes and run this step again`);
  return false;
}

async function actInitialize(ctx) {
  // Re-running is safe: an existing registration is read, not re-created
  // (re-registering could hand out new TXT values and restart verification).
  const current = await getStatus(ctx);
  if (current.phase !== 'none') {
    summary(`Supabase already has the hostname (${current.phase}); not registering again`);
    const known = collectTxtRecords(current.json);
    if (known.length) await ensureRecords(ctx, known);
    return current.phase;
  }
  const r = await supabase('POST', '/custom-hostname/initialize', { ...ctx.sb, body: { custom_hostname: ctx.host } });
  if (r.status >= 400) throw new Error(`Supabase initialize refused: HTTP ${r.status}${r.json && r.json.message ? ` ${r.json.message}` : ''}`);
  const txts = collectTxtRecords(r.json);
  const st = judgeStatus(r.json);
  if (!txts.length && st.phase !== 'verified' && st.phase !== 'active') {
    // Verification needs those records; carrying on would only ever end in
    // "pending". The raw JSON above shows the shape that was not recognised.
    throw new Error('Supabase returned no TXT verification records (see the raw JSON above); DNS left unchanged');
  }
  if (txts.length) await ensureRecords(ctx, txts);
  summary(`Supabase: ${st.phase} (${st.detail})`);
  return st.phase;
}

async function actReverify(ctx) {
  const r = await supabase('POST', '/custom-hostname/reverify', ctx.sb);
  if (r.status >= 400) throw new Error(`Supabase reverify refused: HTTP ${r.status}`);
  // Supabase may hand out fresh TXT values on a reverify; keep DNS in step.
  const txts = collectTxtRecords(r.json);
  if (txts.length) await ensureRecords(ctx, txts);
  const st = judgeStatus(r.json);
  summary(`Supabase: ${st.phase} (${st.detail})`);
  return st.phase;
}

async function googleClientId(ctx) {
  if (process.env.GOOGLE_OAUTH_CLIENT_ID) return process.env.GOOGLE_OAUTH_CLIENT_ID;
  // The auth config carries SMTP and provider secrets: never printed.
  const r = await supabase('GET', '/config/auth', { ...ctx.sb, quiet: true });
  return r.json && r.json.external_google_client_id ? String(r.json.external_google_client_id).split(',')[0].trim() : null;
}

async function probeGoogle(ctx) {
  const clientId = await googleClientId(ctx);
  if (!clientId) return { ok: false, inconclusive: true, reason: 'no Google client id found (set GOOGLE_OAUTH_CLIENT_ID)' };
  const redirect = `https://${ctx.host}/auth/v1/callback`;
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirect)}&response_type=code&scope=email%20profile`;
  try {
    const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': GOOGLE_PROBE_UA, 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(30000) });
    const body = (await res.text()).slice(0, 300000);
    return judgeGoogleRedirectProbe({ status: res.status, body });
  } catch (e) {
    return { ok: false, inconclusive: true, reason: `Google fetch failed: ${String(e && e.message || e).slice(0, 120)}` };
  }
}

async function actActivate(ctx) {
  if (ctx.confirm !== 'ACTIVATE') throw new Error('refused: CONFIRM must be the word ACTIVATE');
  const st = await getStatus(ctx);
  summary(`Supabase before activation: ${st.phase} (${st.detail})`);
  if (st.phase === 'active') return 'active';
  if (st.phase !== 'verified') throw new Error(`refused: hostname is ${st.phase}, not verified; run reverify until it is`);
  const g = await probeGoogle(ctx);
  summary(`Google callback probe: ${g.reason}`);
  if (!g.ok) throw new Error(`refused: ${g.reason}`);
  const r = await supabase('POST', '/custom-hostname/activate', ctx.sb);
  if (r.status >= 400) throw new Error(`Supabase activate refused: HTTP ${r.status}`);
  // Judge the stored state, not the POST echo, so a thin reply cannot turn a
  // successful activation into a red run.
  const after = await getStatus(ctx);
  summary(`Supabase after activation: ${after.phase} (${after.detail})`);
  try {
    const h = await fetch(`https://${ctx.host}/auth/v1/health`, { signal: AbortSignal.timeout(20000) });
    summary(`https://${ctx.host}/auth/v1/health -> HTTP ${h.status}`);
  } catch (e) {
    summary(`https://${ctx.host}/auth/v1/health not reachable yet: ${String(e && e.message || e).slice(0, 100)}`);
  }
  return after.phase;
}

async function actDelete(ctx) {
  if (ctx.confirm !== 'DELETE') throw new Error('refused: CONFIRM must be the word DELETE');
  const r = await supabase('DELETE', '/custom-hostname', ctx.sb);
  const absent = isNotConfigured(r.status, r.json);
  if (r.status >= 400 && !absent) throw new Error(`Supabase delete refused: HTTP ${r.status}`);
  summary(absent ? 'Supabase had no custom hostname' : 'Supabase custom hostname removed');
  const existing = await listRecords(ZONE, ctx.vercel);
  const mine = recordsToDelete(existing, wantedRecords(ctx.label, ctx.ref)).concat(
    existing.filter((rec) => String(rec.type).toUpperCase() === 'TXT' && /^(_acme-challenge|_cf-custom-hostname)\./.test(String(rec.name).toLowerCase()) && String(rec.name).toLowerCase().endsWith(`.${ctx.label}`)),
  );
  for (const rec of mine) {
    await deleteRecord(ZONE, rec.id, ctx.vercel);
    summary(`DNS ${rec.type} ${rec.name} removed`);
  }
  return 'none';
}

export async function run(env = process.env) {
  const action = String(env.ACTION || 'status').trim();
  if (!ACTIONS.includes(action)) throw new Error(`ACTION must be one of ${ACTIONS.join(', ')}`);
  const host = String(env.CUSTOM_HOSTNAME || `auth.${ZONE}`).trim().toLowerCase();
  const label = validateHostname(host);
  for (const k of ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_PROJECT_REF', 'VERCEL_TOKEN']) {
    if (!env[k]) throw new Error(`${k} is not set`);
  }
  const ctx = {
    host,
    label,
    ref: env.SUPABASE_PROJECT_REF,
    confirm: String(env.CONFIRM || '').trim(),
    sb: { token: env.SUPABASE_ACCESS_TOKEN, ref: env.SUPABASE_PROJECT_REF },
    vercel: { token: env.VERCEL_TOKEN, teamId: env.VERCEL_TEAM_ID || DEFAULT_TEAM_ID },
  };
  summary(`action ${action} on ${host} (project ${ctx.ref})`);
  let phase;
  let dnsOnly = action === 'dns';
  switch (action) {
    case 'status': phase = await actStatus(ctx); break;
    case 'dns': phase = (await actDns(ctx)) ? 'verified' : 'pending'; break;
    case 'initialize': phase = await actInitialize(ctx); break;
    case 'reverify': phase = await actReverify(ctx); break;
    case 'activate': phase = await actActivate(ctx); break;
    case 'delete': phase = await actDelete(ctx); break;
    case 'create': {
      const visible = await actDns(ctx);
      if (!visible) { phase = 'pending'; dnsOnly = true; break; }
      await actInitialize(ctx);
      phase = await actReverify(ctx);
      break;
    }
    default: throw new Error('unreachable');
  }
  const code = action === 'dns' ? (phase === 'verified' ? 0 : 2) : exitCodeFor(action, phase);
  summary(`result: ${phase}; exit ${code}${code === 2 ? ' (pending: run the next step later)' : ''}`);
  summary(`Next: ${nextStep(dnsOnly ? 'dns' : action, phase, host)}`);
  summary(`Google callback for this domain: ${googleCallbackUrl(host)}`);
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().then((code) => { flushSummary(); process.exit(code); }, (e) => {
    summary(`failed: ${String(e && e.message || e)}`);
    summary(`Next: ${nextStep(String(process.env.ACTION || 'status'), 'failed', String(process.env.CUSTOM_HOSTNAME || `auth.${ZONE}`))}`);
    flushSummary();
    process.exit(1);
  });
}
