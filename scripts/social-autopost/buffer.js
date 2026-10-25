/**
 * Minimal Buffer GraphQL client (https://api.buffer.com, personal API key in
 * BUFFER_API_KEY; create one at publish.buffer.com/settings/api).
 * Docs: developers.buffer.com/llms.txt. GraphQL always answers HTTP 200;
 * failures arrive in `errors` or as a MutationError union member.
 */

const ENDPOINT = 'https://api.buffer.com';
// Buffer `service` values this system posts to, mapped to our caption keys.
const SERVICE_TO_NETWORK = { twitter: 'twitter', bluesky: 'bluesky', threads: 'threads', instagram: 'instagram', facebook: 'facebook' };

async function gql(query, variables = {}) {
  const key = process.env.BUFFER_API_KEY;
  if (!key) throw new Error('BUFFER_API_KEY not set');
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, variables }),
  });
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
    const d = await gql('query Ch($org: OrganizationId!) { channels(input: { organizationId: $org }) { id name displayName service isQueuePaused } }', { org: org.id });
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
async function createImagePost({ channel, text, imageUrl, altText, dueAt }) {
  const input = {
    channelId: channel.id,
    text,
    schedulingType: 'automatic',
    mode: 'customScheduled',
    dueAt: dueAt.toISOString(),
    assets: [{ image: { url: imageUrl, metadata: { altText: altText.slice(0, 1000) } } }],
  };
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

module.exports = { listChannels, createImagePost, metadataFor, SERVICE_TO_NETWORK };
