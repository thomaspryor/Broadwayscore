/**
 * Minimal Buffer GraphQL client (https://api.buffer.com, personal API key in
 * BUFFER_API_KEY; create one at publish.buffer.com/settings/api).
 * Docs: developers.buffer.com/llms.txt. GraphQL always answers HTTP 200;
 * failures arrive in `errors` or as a MutationError union member.
 */

const ENDPOINT = process.env.BUFFER_API_URL || 'https://api.buffer.com'; // override for local tests
// Buffer `service` values this system posts to, mapped to our caption keys.
const SERVICE_TO_NETWORK = { twitter: 'twitter', bluesky: 'bluesky', threads: 'threads', instagram: 'instagram', facebook: 'facebook' };

// Buffer's quota (250 calls a day per key) is shared by every caller; the last
// response's x-ratelimit-* headers say how much is left.
let lastRateLimit = { remaining: null, reset: null };
const rateLimit = () => lastRateLimit;

async function gql(query, variables = {}) {
  const key = process.env.BUFFER_API_KEY;
  if (!key) throw new Error('BUFFER_API_KEY not set');
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30000),
  });
  const rem = res.headers.get('x-ratelimit-remaining');
  if (rem != null) lastRateLimit = { remaining: Number(rem), reset: res.headers.get('x-ratelimit-reset') };
  if (res.status === 429) throw new Error('Buffer rate limit reached (HTTP 429)');
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

module.exports = { gql, rateLimit, listChannels, createImagePost, findExistingPost, getPost, deletePost, validateChannels, metadataFor, SERVICE_TO_NETWORK };
