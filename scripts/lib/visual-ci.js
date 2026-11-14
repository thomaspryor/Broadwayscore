'use strict';
/**
 * visual-ci.js (BRO-7495, Phase 2): pure helpers for the CI before/after check that can ship a
 * pixel-identical change without asking the owner. Everything here is a decision function so the
 * tests require() the real code (CLAUDE.md 15). Nothing in this file touches git, Linear or the network.
 *
 * Trust split (plan review 2026-11-14):
 *   - visual-identical-ci.yml (push to visual-hold/**, worker-authored YAML, NO secrets) only captures PNGs.
 *   - visual-identical-record.yml (workflow_run, main's code, holds the secret) recomputes the patch, plans the
 *     coverage itself, compares the PNGs itself and posts ONE signed "Visual CI result VQK<mac>" comment.
 *   - the lander alone decides to auto-ship, and only while the repo variable VISUAL_AUTO_SHIP is "on"
 *     and today is on or after AUTO_NOT_BEFORE.
 */
const crypto = require('crypto');

const AUTO_NOT_BEFORE = '2026-11-19';
const CI_DOMAIN = 'owner-visual-ci:v1:';
const CI_PREFIX = 'Visual CI result VQK';
const CI_LINE_RE = /^VISUAL-CI: outcome=(identical|different|incomplete|blocked) base=([0-9a-f]{40}) digest=([0-9a-f]{16})\s*$/m;
const CI_TTL_MS = 14 * 24 * 60 * 60 * 1000;
// The check may take this long (one Next build per side, then the captures) before the owner is asked anyway.
const CI_PENDING_MS = 75 * 60 * 1000;

// A diff touching any of these can change behaviour or the check itself in ways a screenshot cannot show.
const NEVER_AUTO_RE = /^(\.github\/|scripts\/|config\/|next\.config\.|package(-lock)?\.json$|middleware\.|src\/app\/api\/)/;
// Files whose change can alter what a page looks like.
const SURFACE_RE = /^(src\/|public\/|tailwind\.config|postcss\.config)/;
// Changes that can restyle many pages: capture the broad floor set too.
const BROAD_RE = /\.(css|scss)$|^tailwind\.config|^postcss\.config|(^|\/)layout\.tsx$|^src\/components\/(layout|shared|show-cards)\//;
// Drift that can change pixels between the capture base and today's main.
const DRIFT_RE = /^(src\/|public\/|tailwind\.config|postcss\.config|next\.config\.|package(-lock)?\.json$)/;
const FLOOR_ROUTES = ['/', '/browse'];
const UGC_RE = /(my-?shows|ugc|rating|diary|watchlist)/i;
const UGC_ROUTES = ['/my-shows?mock=1&tab=diary', '/test/rating-editor-fixture'];
const READY = {
  '/my-shows?mock=1&tab=diary': '[data-testid="my-shows-content"][data-ready="true"]',
  '/test/rating-editor-fixture': '[data-testid="rating-editor"]',
};
// Interactive states, reused from tests/e2e/ugc-visual-baselines.spec.ts (list view toggle).
const STATES = {
  '/my-shows?mock=1&tab=diary': [{ name: 'list view', click: 'button[aria-label="List view"]:visible', waitFor: '[data-testid="my-shows-content"]' }],
};
const MAX_ROUTES = 12;
// Strict compare for auto-ship: no tolerance at all.
const STRICT = { channelDelta: 0, maxDiffPixels: 0 };

/** True when auto-ship may act: the repo variable is exactly "on" AND the arming date has passed. */
function autoShipOn(env = process.env, now = Date.now()) {
  return String(env.VISUAL_AUTO_SHIP || '').trim().toLowerCase() === 'on' && now >= Date.parse(`${AUTO_NOT_BEFORE}T00:00:00Z`);
}

/** Added or removed lines that touch a mask hook or a <time> element: masked regions hide changes from the pixel compare. */
function maskTouched(diffText) {
  return String(diffText || '').split('\n').some((l) => /^[+-](?![+-])/.test(l) && /data-visual-mask|<time[\s>]/.test(l));
}

/**
 * What the CI must capture for this change, derived from the card's own verdict.json and the diff.
 * Returns { blocked: reason } when the change cannot be proven by screenshots, else
 * { routes, states, ready, elements }.
 */
function planCapture({ changedFiles, verdict, diffText }) {
  const files = Array.isArray(changedFiles) ? changedFiles.filter(Boolean) : [];
  if (!files.length) return { blocked: 'no changed files' };
  const never = files.find((f) => NEVER_AUTO_RE.test(f));
  if (never) return { blocked: `the change touches ${never}, which a screenshot cannot vouch for` };
  const surface = files.filter((f) => SURFACE_RE.test(f));
  if (!surface.length) return { blocked: 'the change touches no file that can alter how a page looks' };
  if (maskTouched(diffText)) return { blocked: 'the change edits a masked or time-based region' };
  const v = verdict && typeof verdict === 'object' ? verdict : {};
  const routes = new Set((Array.isArray(v.paths) ? v.paths : []).filter((p) => typeof p === 'string' && /^\/[A-Za-z0-9/_\-.?=&%]*$/.test(p)));
  if (surface.some((f) => BROAD_RE.test(f))) FLOOR_ROUTES.forEach((r) => routes.add(r));
  if (surface.some((f) => UGC_RE.test(f))) UGC_ROUTES.forEach((r) => routes.add(r));
  const elements = (Array.isArray(v.elements) ? v.elements : []).filter((e) => typeof e === 'string' && e && e.length < 200);
  if (!routes.size) return { blocked: 'no page to capture (the visual check named none)' };
  if (routes.size > MAX_ROUTES) return { blocked: `${routes.size} pages is more than the check captures (${MAX_ROUTES})` };
  if (!elements.length) return { blocked: 'the visual check named no changed element to look for' };
  const list = [...routes].sort();
  const states = {}; const ready = {};
  for (const r of list) { if (STATES[r]) states[r] = STATES[r]; if (READY[r]) ready[r] = READY[r]; }
  return { routes: list, states, ready, elements };
}

/** The pair keys a complete capture must hold: every route x width x (page + each state). */
function expectedPairs(plan, widths) {
  const out = [];
  for (const route of plan.routes || []) for (const width of widths) for (const name of ['', ...((plan.states[route] || []).map((s) => s.name))]) out.push({ route, width, state: name });
  return out;
}

const pairKey = (p) => `${p.route}|${p.width}|${p.state || ''}`;

/**
 * pairs: [{route,width,state,status:'same'|'different'|'error',reason}] from the TRUSTED compare;
 * elementsFound: selectors seen on the head page in at least one capture.
 * outcome: identical | different | incomplete | blocked. Only 'identical' may ever ship anything.
 */
function evaluate({ plan, pairs, canaryOk, elementsFound, widths }) {
  if (!plan || plan.blocked) return { outcome: 'blocked', reasons: [plan && plan.blocked ? plan.blocked : 'no plan'], digest: digestOf([]) };
  const list = Array.isArray(pairs) ? pairs : [];
  const digest = digestOf(list);
  if (canaryOk !== true) return { outcome: 'incomplete', reasons: ['the self-test could not prove a real change would be noticed'], digest };
  const have = new Map(list.map((p) => [pairKey(p), p]));
  const missing = expectedPairs(plan, widths).filter((e) => !have.has(pairKey(e)));
  if (missing.length) return { outcome: 'incomplete', reasons: missing.slice(0, 5).map((m) => `${m.route} @ ${m.width}${m.state ? ` (${m.state})` : ''}: no capture`), digest };
  const errors = list.filter((p) => p.status === 'error');
  if (errors.length) return { outcome: 'incomplete', reasons: errors.slice(0, 5).map((p) => `${p.route} @ ${p.width}${p.state ? ` (${p.state})` : ''}: ${p.reason || 'error'}`), digest };
  const diff = list.filter((p) => p.status !== 'same');
  if (diff.length) return { outcome: 'different', reasons: diff.slice(0, 5).map((p) => `${p.route} @ ${p.width}${p.state ? ` (${p.state})` : ''}: ${p.reason || 'differs'}`), digest };
  const seen = new Set(elementsFound || []);
  const unseen = (plan.elements || []).filter((e) => !seen.has(e));
  if (unseen.length) return { outcome: 'incomplete', reasons: unseen.slice(0, 5).map((e) => `the changed element ${e} never appeared on the new page`), digest };
  return { outcome: 'identical', reasons: [], digest };
}

function digestOf(pairs) {
  const rows = (pairs || []).map((p) => `${pairKey(p)}=${p.status}`).sort().join('\n');
  return crypto.createHash('sha256').update(rows).digest('hex').slice(0, 16);
}

const ciMac = (secret, id, patch, outcome, base, digest) => crypto.createHmac('sha256', secret).update(`${CI_DOMAIN}${id}:${patch}:${outcome}:${base}:${digest}`).digest('hex').slice(0, 32);
const ciMarker = (mac) => `${CI_PREFIX}${mac}`;

const OUTCOME_TEXT = {
  identical: 'every before/after picture matched exactly',
  different: 'the pictures differ, as expected for a visible change',
  incomplete: 'the pages could not all be captured, so the check proves nothing',
  blocked: 'a screenshot check cannot vouch for this kind of change',
};

/** The comment body the trusted job posts: readable line, machine line, signed marker. */
function buildCiComment({ secret, id, patch, outcome, base, digest, reasons, armed }) {
  const lines = [`Before/after check (CI${armed ? '' : ', trial run, you are still asked as usual'}): ${OUTCOME_TEXT[outcome] || outcome}.`];
  for (const r of (reasons || []).slice(0, 5)) lines.push(`- ${r}`);
  lines.push('', `VISUAL-CI: outcome=${outcome} base=${base} digest=${digest}`, '', ciMarker(ciMac(secret, id, patch, outcome, base, digest)));
  return lines.join('\n');
}

/**
 * Newest valid CI result for this exact patch: the marker must be reproducible from the secret
 * (workers can copy a marker, never mint one) and unexpired. Returns {outcome, base, digest, at} or null.
 */
function findCiResult(commentNodes, secret, id, patch, now = Date.now()) {
  const nodes = Array.isArray(commentNodes) ? commentNodes : [];
  let best = null;
  for (const c of nodes) {
    const body = String(c.body || '').replace(/\\([_*`~\[\]()#-])/g, '$1');
    const m = CI_LINE_RE.exec(body);
    if (!m) continue;
    const [, outcome, base, digest] = m;
    if (!body.includes(ciMarker(ciMac(secret, id, patch, outcome, base, digest)))) continue;
    const at = new Date(c.createdAt).getTime();
    if (!Number.isFinite(at) || now - at > CI_TTL_MS) continue;
    if (!best || at > best.at) best = { outcome, base, digest, at };
  }
  return best;
}

/**
 * Lander-side decision. Pure. Inputs are facts the lander gathered:
 *   ci: findCiResult(...) | null, flagOn: autoShipOn(), emailed: an "Emailed the owner" comment exists,
 *   rejected: the card carries the owner's answer, holdFiles: files changed by the hold vs main,
 *   driftFiles: files changed on main since ci.base.
 * auto only when every check holds; any doubt means the owner is asked as today.
 */
function planAuto({ ci, flagOn, emailed, rejected, holdFiles, driftFiles }) {
  if (!flagOn) return { auto: false, why: 'auto-ship is off' };
  if (!ci) return { auto: false, why: 'no signed CI result for this change' };
  if (ci.outcome !== 'identical') return { auto: false, why: `CI result is ${ci.outcome}` };
  if (rejected) return { auto: false, why: 'the owner already answered' };
  if (emailed) return { auto: false, why: 'the owner was already asked by email' };
  const bad = (holdFiles || []).find((f) => NEVER_AUTO_RE.test(f));
  if (bad) return { auto: false, why: `the change touches ${bad}` };
  if (!Array.isArray(driftFiles)) return { auto: false, why: 'could not tell whether main moved since the check' };
  const drift = driftFiles.find((f) => DRIFT_RE.test(f));
  if (drift) return { auto: false, why: `main changed ${drift} since the check ran` };
  return { auto: true, why: 'every before/after picture matched exactly' };
}

/** Emailer-side: hold the ask while a check that can still clear it is running (only when armed). */
function ciHoldReason({ flagOn, hasVisualBlock, ci, askedAt, now = Date.now(), emailed }) {
  if (!flagOn || !hasVisualBlock || emailed) return null;
  if (ci) return ci.outcome === 'identical' ? { reason: 'auto-shipping', detail: 'the before/after check matched exactly; the lander ships it' } : null;
  if (askedAt != null && now - askedAt < CI_PENDING_MS) return { reason: 'visual-check-pending', detail: `the before/after check is still running (${Math.round((now - askedAt) / 60000)} min)` };
  return null;
}

/**
 * Arming evidence. rows: [{id, at (ms), outcome, owner}] one per CI result; owner is classifyStatus
 * ('approved'|'landed'|'auto'|'rejected'|'waiting'|'void'|'unverified'|'expired'|'none').
 * missing: asks older than the CI window that never got a CI result.
 */
function assessVisualShadow(rows, { now = Date.now(), missing = 0, minDays = 5, minIdentical = 20 } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const days = new Set(list.map((r) => new Date(r.at).toISOString().slice(0, 10)));
  const identical = list.filter((r) => r.outcome === 'identical');
  const approved = identical.filter((r) => r.owner === 'approved' || r.owner === 'landed');
  const rejected = identical.filter((r) => r.owner === 'rejected');
  const count = (o) => list.filter((r) => r.outcome === o).length;
  const problems = [];
  if (days.size < minDays) problems.push(`only ${days.size} day(s) of rows (need ${minDays})`);
  if (approved.length < minIdentical) problems.push(`only ${approved.length} identical row(s) the owner approved (need ${minIdentical})`);
  if (rejected.length) problems.push(`${rejected.length} identical row(s) the owner REJECTED (must be 0): ${rejected.map((r) => r.id).join(', ')}`);
  if (list.length && missing / (list.length + missing) > 0.2) problems.push(`${missing} ask(s) never got a CI result (over 20% of asks)`);
  if (now < Date.parse(`${AUTO_NOT_BEFORE}T00:00:00Z`)) problems.push(`not before ${AUTO_NOT_BEFORE}`);
  return {
    ready: problems.length === 0, problems,
    days: days.size, rows: list.length, identical: identical.length, identicalApproved: approved.length, identicalRejected: rejected.length,
    different: count('different'), incomplete: count('incomplete'), blocked: count('blocked'), missing,
  };
}

module.exports = {
  AUTO_NOT_BEFORE, CI_PREFIX, CI_LINE_RE, CI_PENDING_MS, CI_TTL_MS, NEVER_AUTO_RE, DRIFT_RE, STRICT, FLOOR_ROUTES, UGC_ROUTES,
  autoShipOn, maskTouched, planCapture, expectedPairs, pairKey, evaluate, digestOf, ciMac, ciMarker, buildCiComment, findCiResult, planAuto, ciHoldReason, assessVisualShadow,
};
