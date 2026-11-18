'use strict';
/**
 * BRO-7748: delivers the opening-night lane's near-miss and found-not-live alerts while the night is still running.
 * Two immediate channels: the press-night Discord webhook (DISCORD_WEBHOOK_ALERTS, the secret the lane workflow already
 * wires to its failure notices) and a comment on the opening-night coordinator card (coordinator-registry.js), which
 * the coordinator session reads. No daily-digest route: a next-morning line cannot get a review live tonight.
 *
 * Lives outside scripts/lib/opening-night-lane/ on purpose: the CLI passes it in, so the Linear client and https code
 * stay out of rehearsal.laneCodeHash (same reason driver.buildRealLaneDeps takes routeAlert from the CLI).
 * Each channel is tried on its own; one failing never hides the other, and neither throws into the lane.
 */
const https = require('https');
const { formatPressSignals } = require('./opening-night-lane/near-miss');

function coordinatorCard() {
  const reg = require('./coordinator-registry').REGISTRY || [];
  const e = reg.find((x) => x.area === 'opening-night');
  return e ? e.card : null;
}

function postDiscord(webhook, content) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ content: content.slice(0, 1990) });
    const u = new URL(webhook);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 15000 }, (res) => {
      res.resume();
      res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300 ? resolve(true) : reject(new Error(`discord HTTP ${res.statusCode}`))));
    });
    req.on('timeout', () => req.destroy(new Error('discord timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

// The lane awaits the alert inside a pass: no channel may hold the pass longer than this, retries included.
const CHANNEL_CAP_MS = 45 * 1000;
function capped(p, ms, what) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} took over ${ms / 1000}s`)), ms); })]).finally(() => clearTimeout(t));
}

async function commentOnCard(card, body) {
  const linear = require('./linear-client');
  const issue = await linear.getIssue(card);
  if (!issue || !issue.id) throw new Error(`coordinator card ${card} not found`);
  await linear.createComment(issue.id, body);
  return true;
}

/**
 * @param {{env?: object, log?: Function, discord?: Function, comment?: Function, card?: string|null, runUrl?: string}} [opts]
 *   discord(webhook, text) and comment(card, body) are injectable for tests.
 * @returns {(signals: {show, night, nearMisses, gaps}) => Promise<{discord: boolean, comment: boolean, text: string|null}>}
 */
function createPressSignalsNotifier({ env = process.env, log = console.log, discord = postDiscord, comment = commentOnCard, card = coordinatorCard(), runUrl, capMs = CHANNEL_CAP_MS } = {}) {
  const run = runUrl || (env.GITHUB_RUN_ID && env.GITHUB_REPOSITORY ? `https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null);
  return async ({ show, night, nearMisses = [], gaps = [] }) => {
    const msg = formatPressSignals(show, night, { nearMisses, gaps });
    if (!msg) return { discord: false, comment: false, text: null };
    const text = `${msg.title}\n${msg.description}${run ? `\nlane run: ${run}` : ''}`;
    log(`[press-signals] ${text}`);
    const out = { discord: false, comment: false, text };
    if (env.DISCORD_WEBHOOK_ALERTS) {
      try { out.discord = await capped(discord(env.DISCORD_WEBHOOK_ALERTS, text), capMs, 'discord'); } catch (e) { log(`[press-signals] discord failed: ${String(e && e.message).slice(0, 160)}`); }
    } else log('[press-signals] DISCORD_WEBHOOK_ALERTS not set; Discord skipped');
    if (card && env.LINEAR_API_KEY) {
      try { out.comment = await capped(comment(card, `${text}\n\nPosted by the opening-night lane (BRO-7748). The lane did not admit these; one command above adds each.`), capMs, 'card comment'); } catch (e) { log(`[press-signals] ${card} comment failed: ${String(e && e.message).slice(0, 160)}`); }
    } else log(`[press-signals] no ${card ? 'LINEAR_API_KEY' : 'coordinator card'}; card comment skipped`);
    if (!out.discord && !out.comment) console.error(`::error::press-night alert reached no channel: ${msg.title}`);
    return out;
  };
}

module.exports = { createPressSignalsNotifier, coordinatorCard };
