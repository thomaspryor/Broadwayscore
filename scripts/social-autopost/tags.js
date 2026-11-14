/**
 * Official-account tags (BRO-7413, owner Option A from BRO-7244, answered 2026-11-09):
 * tag only the show's own account, only when its Critic Score label is Worth Seeing or
 * better, never a critic or star, never on Facebook. Handles live in data/social-handles.json
 * (verifiedAt per network); a missing handle means no tag. The tag is appended to the finished
 * caption here, never written by the AI writer (ai-captions.js, captions.js stay as they are).
 */

const fs = require('fs');
const path = require('path');
const { getScoreTierId } = require('../lib/score-tiers');
const { LIMITS } = require('./captions');

const HANDLES_FILE = path.join(__dirname, '..', '..', 'data', 'social-handles.json');
const NETWORKS = ['instagram', 'twitter', 'threads', 'bluesky']; // Facebook never gets a tag
const TAG_TIERS = new Set(['must-see', 'recommended', 'worth-seeing']);

function loadHandles(file = HANDLES_FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).shows || {}; } catch { return {}; }
}

// Per-network handle shapes (hand-edited entries bypass the harvester's own checks).
const HANDLE_FORMAT = {
  instagram: /^(?!\.)[A-Za-z0-9._]{1,30}$/,
  twitter: /^[A-Za-z0-9_]{1,15}$/,
  threads: /^(?!\.)[A-Za-z0-9._]{1,30}$/,
  bluesky: /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/,
};

/** The show's verified handle on a network, or null (no entry, no verifiedAt, malformed). */
function handleFor(handles, showId, network) {
  const h = handles && handles[showId] && handles[showId][network];
  const bare = String((h && h.handle) || '').replace(/^@/, '');
  if (!h || !h.verifiedAt || !HANDLE_FORMAT[network] || !HANDLE_FORMAT[network].test(bare)) return null;
  return `@${bare}`;
}

/** Characters a network counts for a caption (X counts every link as 23). */
const countLen = (net, text) => [...(net === 'twitter' ? text.replace(/https?:\/\/\S+/g, 'x'.repeat(23)) : text)].length;

/**
 * Captions with the show's official handles appended, as a new object. score: the rounded
 * Critic Score the post states; category picks the market's tier bands. A tag that would
 * push a caption over its network limit is left off that network.
 */
function withShowTags(captions, show, score, { handles = loadHandles() } = {}) {
  if (!Number.isFinite(score) || !TAG_TIERS.has(getScoreTierId(Math.round(score), show.category))) return captions;
  const out = { ...captions };
  for (const net of NETWORKS) {
    const handle = handleFor(handles, show.id, net);
    if (!handle || typeof out[net] !== 'string' || new RegExp(`${handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9._])`, 'i').test(out[net])) continue;
    const text = `${out[net]}\n\n${handle}`;
    if (countLen(net, text) <= LIMITS[net]) out[net] = text;
  }
  return out;
}

module.exports = { withShowTags, handleFor, loadHandles, NETWORKS, HANDLES_FILE };
