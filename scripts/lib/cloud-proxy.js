/**
 * Route ScrapingBee calls through the cloud sandbox's egress proxy (BRO-6258).
 *
 * In a claude.ai cloud session Node's https module connects directly and
 * ignores HTTPS_PROXY. Direct egress to app.scrapingbee.com answers
 * "403 Blocked by egress policy", while the same call through the session's
 * proxy returns 200 (the other providers happen to be reachable directly, so
 * only ScrapingBee broke). Requiring this module patches https.request/get so
 * a request to a ScrapingBee host with no explicit agent uses the proxy. It is
 * a no-op everywhere else (Mac, GitHub Actions), and when https-proxy-agent
 * is not installed.
 *
 * Covers https.get/https.request callers and global fetch. axios already
 * honors HTTPS_PROXY on its own, so it needs no patch.
 */
const https = require('https');

// Optional packages, loaded only in a cloud session. The name is passed as a variable
// so require-graph tests (morning-digest-action.yml runs without npm ci) see no package import.
const optionalRequire = (name) => require(name);

const PROXIED_HOST_RE = /(^|\.)scrapingbee\.com$/i;

/**
 * Pure: should a request to `host` go through the sandbox proxy?
 * @param {string} host
 * @param {Record<string,string|undefined>} env
 */
function shouldProxy(host, env = process.env) {
  if (env.CLAUDE_CODE_REMOTE !== 'true') return false;
  if (!(env.HTTPS_PROXY || env.https_proxy)) return false;
  return PROXIED_HOST_RE.test(String(host || ''));
}

function hostOf(arg) {
  if (!arg) return '';
  if (typeof arg === 'string') { try { return new URL(arg).hostname; } catch { return ''; } }
  if (arg instanceof URL) return arg.hostname;
  return String(arg.hostname || arg.host || '').replace(/:\d+$/, '');
}

let _agent;
function proxyAgent(env = process.env) {
  if (_agent === undefined) {
    try {
      const { HttpsProxyAgent } = optionalRequire('https-proxy-agent');
      _agent = new HttpsProxyAgent(env.HTTPS_PROXY || env.https_proxy);
    } catch { _agent = null; }
  }
  return _agent;
}

/** Pure-ish: add `agent` to the (url|options, options?, cb?) args when needed. */
function withProxyAgent(args, env = process.env) {
  const urlish = typeof args[0] === 'string' || args[0] instanceof URL;
  const optIdx = urlish ? (typeof args[1] === 'object' && args[1] !== null ? 1 : -1) : 0;
  const host = hostOf(args[0]);
  if (!shouldProxy(host, env)) return args;
  const agent = proxyAgent(env);
  if (!agent) return args;
  const out = args.slice();
  if (optIdx === -1) out.splice(1, 0, { agent });
  else if (!('agent' in out[optIdx])) out[optIdx] = { ...out[optIdx], agent };
  return out;
}

function install() {
  if (https.request.__bro6258) return;
  const origRequest = https.request;
  const origGet = https.get; // wrapped, not rebuilt on request: a stubbed https.get (tests) must keep working
  const request = function (...args) { return origRequest.apply(this, withProxyAgent(args)); };
  const get = function (...args) { return origGet.apply(this, withProxyAgent(args)); };
  request.__bro6258 = true;
  https.request = request;
  https.get = get;
  installFetch();
}

/** Global fetch (provider-billing.js) also ignores HTTPS_PROXY: add a dispatcher for ScrapingBee. */
function installFetch(env = process.env) {
  if (typeof globalThis.fetch !== 'function' || globalThis.fetch.__bro6258) return;
  let dispatcher;
  try {
    const { ProxyAgent } = optionalRequire('undici');
    dispatcher = new ProxyAgent(env.HTTPS_PROXY || env.https_proxy);
  } catch { return; }
  const origFetch = globalThis.fetch;
  const wrapped = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    let host = '';
    try { host = new URL(url).hostname; } catch { /* leave unproxied */ }
    if (shouldProxy(host, env) && !(init && init.dispatcher)) init = { ...init, dispatcher };
    return origFetch.call(this, input, init);
  };
  wrapped.__bro6258 = true;
  globalThis.fetch = wrapped;
}

if (process.env.CLAUDE_CODE_REMOTE === 'true') install();

module.exports = { shouldProxy, withProxyAgent, install, PROXIED_HOST_RE };
