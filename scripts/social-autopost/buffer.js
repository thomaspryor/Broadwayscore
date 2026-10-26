/**
 * Minimal Buffer GraphQL client (https://api.buffer.com, personal API key in
 * BUFFER_API_KEY; create one at publish.buffer.com/settings/api).
 * Docs: developers.buffer.com/llms.txt. GraphQL always answers HTTP 200;
 * failures arrive in `errors` or as a MutationError union member.
 */

const endpoint = () => process.env.BUFFER_API_URL || 'https://api.buffer.com'; // override for local tests (a fake server)
// Buffer `service` values this system posts to, mapped to our caption keys.
const SERVICE_TO_NETWORK = { twitter: 'twitter', bluesky: 'bluesky', threads: 'threads', instagram: 'instagram', facebook: 'facebook' };

// Buffer allows 250 requests a rolling day per key, shared by every session and the
// hourly run. Each answer's headers say what is left; briefs check it before posting.
let lastRate = null;

/**
 * Pure: the tightest quota a response's headers report, {remaining, resetAt (ms)} or null.
 * Reads the structured `Ratelimit: "250-in-1day"; r=0; t=408` lines (one per policy)
 * and falls back to X-Ratelimit-Remaining / X-Ratelimit-Reset (epoch seconds).
 */
function parseRateHeaders(get, now = Date.now()) {
  let best = null;
  for (const line of String(get('ratelimit') || '').split(/,(?=\s*")/)) {
    const r = line.match(/;\s*r=(\d+)/), t = line.match(/;\s*t=(\d+)/);
    if (r && (!best || +r[1] < best.remaining)) best = { remaining: +r[1], resetAt: t ? now + +t[1] * 1000 : null };
  }
  const xr = get('x-ratelimit-remaining');
  if (xr != null && xr !== '' && (!best || +xr < best.remaining)) {
    const reset = +get('x-ratelimit-reset');
    best = { remaining: +xr, resetAt: reset ? reset * 1000 : null };
  }
  return best;
}

/** The quota Buffer reported on its last answer in this process, or null before any call. */
const rateLimit = () => lastRate;

/** Pure: why `need` more requests cannot be made now, or null when the quota allows them. */
function quotaProblem(rate, need) {
  if (!rate) return 'Buffer reported no rate limit, so the remaining quota is unknown';
  if (rate.remaining >= need) return null;
  const when = rate.resetAt ? `; the rolling window frees requests from ${new Date(rate.resetAt).toISOString()}, retry after that` : '';
  return `Buffer has ${rate.remaining} request(s) left under its rate limit and this needs ${need}${when}`;
}

async function gql(query, variables = {}) {
  const key = process.env.BUFFER_API_KEY;
  if (!key) throw new Error('BUFFER_API_KEY not set');
  const res = await fetch(endpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30000),
  });
  lastRate = parseRateHeaders(h => res.headers.get(h)); // no headers: unknown, which a brief refuses
  if (res.status === 429) throw new Error(`Buffer rate limit reached (HTTP 429)${lastRate && lastRate.resetAt ? `; retry after ${new Date(lastRate.resetAt).toISOString()}` : ''}`);
  if (!res.ok) throw new Error(`Buffer HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  if (body.errors && body.errors.length) throw new Error(`Buffer: ${body.errors.map(e => e.message).join('; ')}`);
  return body.data;
}

/** All channels across the account's organizations: [{id, name, service, isQueuePaused, network}] */
async function listChannels() {
  const data = await gql('query { account { organizations { id name } } }');
  const out = [];
  for (const org of data.account.organizations) {
    const d = await gql('query Ch($org: OrganizationId!) { channels(input: { organizationId: $org }) { id name displayName service isQueuePaused isDisconnected isLocked } }', { org: org.id });
    for (const ch of d.channels) out.push({ ...ch, organizationId: org.id, network: SERVICE_TO_NETWORK[ch.service] || null });
  }
  return out;
}

/** Network-specific required metadata (Facebook and Instagram require a post type). */
function metadataFor(network) {
  if (network === 'instagram') return { instagram: { type: 'post', shouldShareToFeed: true } };
  if (network === 'facebook') return { facebook: { type: 'post' } };
  return undefined;
}

/**
 * Schedule one image post on one channel. Returns the Buffer post id.
 * dueAt: Date. Buffer publishes at that time (UTC).
 */
async function createImagePost({ channel, text, imageUrl, altText, dueAt, draft = false }) {
  const input = {
    channelId: channel.id,
    text,
    schedulingType: 'automatic',
    mode: 'customScheduled',
    dueAt: dueAt.toISOString(),
    assets: [{ image: { url: imageUrl, metadata: { altText: altText.slice(0, 1000) } } }],
  };
  if (draft) input.saveToDraft = true;
  const meta = metadataFor(channel.network);
  if (meta) input.metadata = meta;
  const data = await gql(`mutation Create($input: CreatePostInput!) {
    createPost(input: $input) {
      ... on PostActionSuccess { post { id dueAt status } }
      ... on MutationError { message }
    }
  }`, { input });
  const r = data.createPost;
  if (!r || !r.post) throw new Error(`Buffer createPost on ${channel.service}: ${(r && r.message) || 'no post returned'}`);
  return r.post;
}

/**
 * Idempotency: a post for this channel created since `sinceIso` whose
 * text matches every marker pattern (captions.js postMarkers). Guards against a re-run after a crash or a
 * failed history push posting the same thing twice. Returns the post or null.
 */
// The filter is `createdAt: {start}`. The documented `startDate` filter returns no
// posts at all on the live API (checked 2026-10-25), which would silently disable
// this guard.
async function findExistingPost({ channel, markers, sinceIso }) {
  const data = await gql(`query Posts($input: PostsInput!) {
    posts(input: $input, first: 100) { edges { node { id text status dueAt } } }
  }`, { input: { organizationId: channel.organizationId, filter: { channelIds: [channel.id], createdAt: { start: sinceIso } } } });
  const nodes = ((data.posts && data.posts.edges) || []).map(e => e.node);
  return nodes.find(n => n.status !== 'error' && markers.every(m => m.test(n.text || ''))) || null;
}

/** One post's publishing outcome: {id, status, sentAt, dueAt, error, externalLink}, or null once deleted. */
async function getPost(id) {
  try {
    const data = await gql(`query One($input: PostInput!) {
      post(input: $input) { id status sentAt dueAt externalLink error { message } }
    }`, { input: { id } });
    return data.post || null;
  } catch (e) {
    if (/Post not found/i.test(e.message)) return null; // Buffer's answer for a deleted post (checked live 2026-10-25)
    throw e;
  }
}

async function deletePost(id) {
  const data = await gql(`mutation Del($input: DeletePostInput!) {
    deletePost(input: $input) { __typename ... on MutationError { message } }
  }`, { input: { id } });
  const r = data.deletePost;
  if (r && r.message) throw new Error(`Buffer deletePost ${id}: ${r.message}`);
}

/**
 * Live self-test, run once before the first real post: create a DRAFT image
 * post on every channel (drafts are never published), then delete it. Proves
 * the key, the channels, the image hosting and each network's metadata.
 */
async function validateChannels(channels, { imageUrl, altText }) {
  const problems = [];
  for (const ch of channels) {
    try {
      const post = await createImagePost({ channel: ch, text: 'Broadway Scorecard autopost self-test (draft, deleted automatically).', imageUrl, altText, dueAt: new Date(Date.now() + 7 * 864e5), draft: true });
      try {
        await deletePost(post.id);
      } catch (e) {
        problems.push(`${ch.key || ch.service}: self-test post ${post.id} (status ${post.status}) could not be deleted, remove it in Buffer: ${e.message}`);
        continue;
      }
      // A draft is never published. If Buffer scheduled it instead, say so: the
      // real posts would behave the same way.
      if (post.status && post.status !== 'draft') problems.push(`${ch.key || ch.service}: self-test came back as '${post.status}', not a draft (deleted)`);
    } catch (e) {
      problems.push(`${ch.key || ch.service}: ${e.message}`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Cross-lane rule (BRO-6368): at most one post per show per network per local day
// (the show's own market day). Score posts win: only brief posts check this and
// move to the next free day. Fails closed: a listing that errors, or that misses
// posts the ledger says are scheduled in the window, blocks the brief post.

const MAX_PAGES = 1; // one request per channel: the brief's window never holds 100 posts on a channel

/** Every post on one channel due in [startIso, endIso]; refuses rather than read past MAX_PAGES. */
async function listChannelPosts({ channel, startIso, endIso }) {
  const out = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await gql(`query Posts($input: PostsInput!, $after: String) {
      posts(input: $input, first: 100, after: $after) { edges { node { id text status dueAt sentAt } } pageInfo { hasNextPage endCursor } }
    }`, { input: { organizationId: channel.organizationId, filter: { channelIds: [channel.id], dueAt: { start: startIso, end: endIso } } }, after });
    const p = data.posts || {};
    out.push(...(p.edges || []).map(e => e.node));
    if (!p.pageInfo || !p.pageInfo.hasNextPage) return out;
    after = p.pageInfo.endCursor;
  }
  throw new Error(`Buffer listing for ${channel.service} has more than ${MAX_PAGES} pages; refusing to guess`);
}

/** Wall-clock day (YYYY-MM-DD) of an instant in a time zone. */
function localDay(t, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(t)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * Pure: local days (in tz) on which `posts` already carry a post mentioning the show
 * (`marker` = its path pattern). Failed posts do not count.
 */
function busyDays(posts, { marker, tz }) {
  const days = new Set();
  for (const p of posts || []) {
    if (!p || p.status === 'error' || !marker.test(p.text || '')) continue;
    const t = Date.parse(p.sentAt || p.dueAt || '');
    if (Number.isFinite(t)) days.add(localDay(t, tz));
  }
  return days;
}

/**
 * Pure: a listing problem, or null. `expected` = Buffer post ids the ledger says are
 * due on this channel in the window; a listing that holds none of them is broken.
 */
function listingProblem(posts, expected) {
  if (!expected.length) return null;
  const ids = new Set((posts || []).map(p => p.id));
  return expected.some(id => ids.has(id)) ? null : `listing returned none of the ${expected.length} post(s) the ledger has scheduled in the window`;
}

module.exports = { gql, parseRateHeaders, rateLimit, quotaProblem, listChannelPosts, busyDays, listingProblem, localDay, listChannels, createImagePost, findExistingPost, getPost, deletePost, validateChannels, metadataFor, SERVICE_TO_NETWORK };
