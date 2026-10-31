'use strict';
/**
 * html-handoff.js (BRO-5886): carry page HTML a cloud session fetched itself to
 * execute-approved-fix.yml without putting review text in the public repo.
 *
 * Some sites (bachtrack.com) serve GitHub runners a stub page but load in full
 * from a claude.ai container. The session encrypts the HTML to the public key
 * committed at PUBLIC_KEY_PATH; the private key is the HTML_HANDOFF_PRIVATE_KEY
 * Actions secret (set by html-handoff-key.yml, never in the repo or a log).
 * The plan carries only ciphertext. CI decrypts into a temp file and runs
 * ingest-review-from-url.js --html-file=<tmp> --url=<original>.
 *
 * Envelope: RSA-OAEP-SHA256 wraps a fresh AES-256-GCM key; the HTML is gzipped
 * before encryption. The GCM tag authenticates the ciphertext, and the url is
 * bound in as additional data so an envelope cannot be replayed under another url.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', '..');
const PUBLIC_KEY_PATH = path.join(ROOT, 'scripts', 'lib', 'html-handoff-public-key.pem');
const PRIVATE_KEY_ENV = 'HTML_HANDOFF_PRIVATE_KEY';
const PRIVATE_KEY_FILE_ENV = 'HTML_HANDOFF_KEY_FILE';
const ACTION_TYPE = 'ingest-html-handoff';
const ALG = 'RSA-OAEP-256+A256GCM+gzip';
const MAX_HTML_BYTES = 3 * 1024 * 1024;
const MAX_CIPHERTEXT_B64 = 2 * 1024 * 1024;
const MAX_PLAN_CIPHERTEXT_B64 = 3 * 1024 * 1024; // all handoff envelopes in one plan
const MIN_HTML_BYTES = 500; // ingest-review-from-url.js refuses less as "no usable HTML"

function keyId(publicKeyPem) {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex').slice(0, 16);
}

function loadPublicKey(file = PUBLIC_KEY_PATH) {
  if (!fs.existsSync(file)) throw new Error(`${path.relative(ROOT, file)} is missing: dispatch html-handoff-key.yml once to create the key pair`);
  return fs.readFileSync(file, 'utf8');
}

/**
 * Executor side: the private key from HTML_HANDOFF_KEY_FILE (deleted once read)
 * or, for a local run, HTML_HANDOFF_PRIVATE_KEY (removed from process.env).
 */
function takePrivateKey(env = process.env) {
  let pem = null;
  const file = env[PRIVATE_KEY_FILE_ENV];
  delete env[PRIVATE_KEY_FILE_ENV];
  if (file && fs.existsSync(file)) {
    pem = fs.readFileSync(file, 'utf8');
    fs.rmSync(file, { force: true });
  }
  if (!pem && env[PRIVATE_KEY_ENV]) pem = env[PRIVATE_KEY_ENV];
  delete env[PRIVATE_KEY_ENV];
  return pem && pem.includes('PRIVATE KEY') ? pem : null;
}

function generateKeyPair() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

function encryptHtml(html, url, publicKeyPem) {
  if (typeof html !== 'string' || !html) throw new Error('encryptHtml: html must be a non-empty string');
  const plain = Buffer.from(html, 'utf8');
  if (plain.length > MAX_HTML_BYTES) throw new Error(`encryptHtml: html is ${plain.length} bytes (max ${MAX_HTML_BYTES})`);
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(String(url), 'utf8'));
  const ct = Buffer.concat([cipher.update(zlib.gzipSync(plain)), cipher.final()]);
  const ek = crypto.publicEncrypt({ key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
  return {
    v: 1,
    alg: ALG,
    kid: keyId(publicKeyPem),
    ek: ek.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
}

/** Shape check only (no key needed): what preflight and the executor both refuse before decrypting. */
function envelopeProblem(env) {
  if (!env || typeof env !== 'object') return 'html envelope missing';
  if (env.v !== 1 || env.alg !== ALG) return `unsupported html envelope (v=${env.v}, alg=${env.alg})`;
  for (const k of ['kid', 'ek', 'iv', 'tag', 'ct']) {
    if (typeof env[k] !== 'string' || !env[k]) return `html envelope field ${k} missing`;
  }
  if (env.ct.length > MAX_CIPHERTEXT_B64) return `html envelope ciphertext is ${env.ct.length} chars (max ${MAX_CIPHERTEXT_B64})`;
  return null;
}

function decryptHtml(env, url, privateKeyPem) {
  const problem = envelopeProblem(env);
  if (problem) throw new Error(problem);
  const priv = crypto.createPrivateKey(privateKeyPem);
  const kid = keyId(crypto.createPublicKey(priv).export({ type: 'spki', format: 'pem' }));
  if (env.kid !== kid) throw new Error(`html envelope was encrypted to key ${env.kid}, CI holds ${kid}: re-run make-html-handoff-plan.js against the committed public key`);
  const key = crypto.privateDecrypt({ key: priv, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(env.ek, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(String(url), 'utf8'));
  decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
  const gz = Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()]);
  const plain = zlib.gunzipSync(gz, { maxOutputLength: MAX_HTML_BYTES });
  return plain.toString('utf8');
}

/**
 * The page must say it IS the plan's url: a canonical or og:url that matches.
 * Stricter than the scraper's verifyFetchedUrl, which passes a page with neither
 * tag; here the HTML came from outside CI, so absence is a refusal.
 */
function htmlUrlProblem(html, url, { verify = require('./scraper').verifyFetchedUrl } = {}) {
  if (typeof html !== 'string' || Buffer.byteLength(html, 'utf8') < MIN_HTML_BYTES) return `html is under ${MIN_HTML_BYTES} bytes`;
  const vr = verify(html, url);
  if (!vr || !vr.verified) return `page does not match ${url}: ${(vr && vr.reason) || 'unverified'}${vr && vr.actual ? ` (${vr.actual})` : ''}`;
  if (vr.reason === 'no_canonical') return `page has no canonical or og:url to prove it is ${url}`;
  return null;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CRITIC_RE = /^[\p{L}\p{M}][\p{L}\p{M} .'’-]{0,79}$/u;

/** Field checks shared by the helper (before writing) and the executor (before running). */
function actionProblem(a) {
  if (!a || a.type !== ACTION_TYPE) return `not an ${ACTION_TYPE} action`;
  if (!SLUG_RE.test(String(a.showId || ''))) return `bad showId: ${a.showId}`;
  // new URL() strips tabs/newlines, so check the raw string that reaches argv and the AAD.
  if (/[\s\x00-\x1f\x7f]/.test(String(a.url))) return `url has whitespace or control characters: ${JSON.stringify(a.url)}`;
  let u;
  try { u = new URL(String(a.url)); } catch { return `bad url: ${a.url}`; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return `url must be http(s): ${a.url}`;
  if (a.outlet != null && !SLUG_RE.test(String(a.outlet))) return `bad outlet: ${a.outlet}`;
  if (a.critic != null && !CRITIC_RE.test(String(a.critic))) return `bad critic: ${a.critic}`;
  if (a.publishDate != null && !DATE_RE.test(String(a.publishDate))) return `bad publishDate: ${a.publishDate}`;
  return envelopeProblem(a.html);
}

/** argv for ingest-review-from-url.js (run with execFile, never a shell). */
function ingestArgs(a, htmlFile) {
  const args = ['scripts/ingest-review-from-url.js', `--show=${a.showId}`, `--url=${a.url}`, `--html-file=${htmlFile}`];
  if (a.outlet) args.push(`--outlet=${a.outlet}`);
  if (a.critic) args.push(`--critic=${a.critic}`);
  if (a.publishDate) args.push(`--publish-date=${a.publishDate}`);
  return args;
}

function buildAction({ showId, url, outlet, critic, publishDate, html, publicKeyPem, description }) {
  const a = { type: ACTION_TYPE, showId, url };
  if (outlet) a.outlet = outlet;
  if (critic) a.critic = critic;
  if (publishDate) a.publishDate = publishDate;
  a.description = description || `BRO-5886 html handoff: ingest ${url} from HTML fetched outside CI`;
  a.htmlBytes = Buffer.byteLength(html, 'utf8');
  a.html = encryptHtml(html, url, publicKeyPem);
  const problem = actionProblem(a);
  if (problem) throw new Error(problem);
  return a;
}

/** Plan-level checks: every envelope's shape, the committed key id, and the total size. */
function planHandoffProblems(actions, { publicKeyPem } = {}) {
  // A scrubbed action already ran (a partial plan reset to pending skips it).
  const list = (actions || []).filter((a) => a && a.type === ACTION_TYPE && !isScrubbed(a));
  const problems = [];
  let kid = null;
  if (publicKeyPem) kid = keyId(publicKeyPem);
  let total = 0;
  list.forEach((a, i) => {
    const p = actionProblem(a);
    if (p) problems.push(`${ACTION_TYPE} #${i + 1}: ${p}`);
    else {
      total += a.html.ct.length;
      if (kid && a.html.kid !== kid) problems.push(`${ACTION_TYPE} #${i + 1}: encrypted to key ${a.html.kid}, committed key is ${kid} (rebuild the plan)`);
    }
  });
  if (total > MAX_PLAN_CIPHERTEXT_B64) problems.push(`${ACTION_TYPE}: ${total} ciphertext chars in one plan (max ${MAX_PLAN_CIPHERTEXT_B64}); split it`);
  return problems;
}

/**
 * After a run, drop the ciphertext from the plan so the executor's write-back
 * does not keep it on main. Earlier commits still hold it: there is no forward
 * secrecy, so a leaked private key would open every past handoff.
 */
function isScrubbed(a) {
  return Boolean(a && a.type === ACTION_TYPE && a.html && a.html.scrubbed === true);
}

function scrubAction(a) {
  if (!a || a.type !== ACTION_TYPE || !a.html || typeof a.html.ct !== 'string') return a;
  const sha256 = crypto.createHash('sha256').update(a.html.ct).digest('hex');
  return { ...a, html: { kid: a.html.kid, sha256, scrubbed: true } };
}

/**
 * Executor side. Decrypt, verify the page is the plan's url, write a 0600 temp
 * file, run ingest, remove the file. `run(args)` is injected for tests.
 */
function executeHandoff(a, { privateKeyPem, run, tmpDir = process.env.RUNNER_TEMP || require('os').tmpdir(), verify } = {}) {
  const problem = actionProblem(a);
  if (problem) return { ok: false, reason: `${ACTION_TYPE}: ${problem}` };
  if (!privateKeyPem) return { ok: false, reason: `${ACTION_TYPE}: ${PRIVATE_KEY_ENV} is not set in this run (dispatch html-handoff-key.yml)` };
  let html;
  try { html = decryptHtml(a.html, a.url, privateKeyPem); } catch (e) { return { ok: false, reason: `${ACTION_TYPE}: decrypt failed (${e.message})` }; }
  const urlProblem = htmlUrlProblem(html, a.url, verify ? { verify } : undefined);
  if (urlProblem) return { ok: false, reason: `${ACTION_TYPE}: ${urlProblem}` };
  const dir = fs.mkdtempSync(path.join(tmpDir, 'html-handoff-'));
  const file = path.join(dir, 'page.html');
  try {
    fs.writeFileSync(file, html, { mode: 0o600 });
    run(ingestArgs(a, file));
    return { ok: true, msg: `Ingested ${a.url} for ${a.showId} from handed-off HTML (${html.length} chars)` };
  } catch (e) {
    return { ok: false, reason: `${ACTION_TYPE}: ingest failed (${e.message})` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = {
  isScrubbed, takePrivateKey, PRIVATE_KEY_FILE_ENV,
  ACTION_TYPE, ALG, PUBLIC_KEY_PATH, PRIVATE_KEY_ENV, MAX_HTML_BYTES, MAX_CIPHERTEXT_B64, MAX_PLAN_CIPHERTEXT_B64,
  keyId, loadPublicKey, generateKeyPair, encryptHtml, decryptHtml, envelopeProblem,
  htmlUrlProblem, actionProblem, ingestArgs, buildAction, executeHandoff,
  planHandoffProblems, scrubAction,
};
