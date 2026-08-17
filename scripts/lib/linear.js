/**
 * linear.js — the single Linear client every caller uses (BRO-374, Phase 1).
 *
 * WHAT THIS IS: one small, injectable surface for the Linear operations this
 * project performs. Five operations, nothing more:
 *   1. createIssue        — file a new issue
 *   2. updateIssue        — patch an existing issue
 *   3. addComment         — comment on an issue
 *   4. delegateToAgent    — delegate an issue to a Linear agent (app user)
 *   5. getIssue           — read one issue by human identifier ("BRO-123")
 *
 * WHY THE CLIENT IS INJECTED (the whole point of this phase): the GraphQL
 * executor is passed INTO the constructor, never imported as a module-level
 * singleton. scripts/lib/linear-client.js reads LINEAR_API_KEY at require-time
 * and every method calls a shared fetch()-backed `graphql()` — so nothing that
 * uses it can be unit-tested without a live API key and a network round trip.
 * Here the executor is a plain `graphql(query, variables) => Promise<data>`
 * function the caller supplies. Production wires the real fetch-backed one via
 * createLinearClient(); tests inject a stub that records the calls and returns
 * canned data, so all five operations are covered with zero network (see
 * linear.test.mjs).
 *
 * The GraphQL query/mutation TEXT lives here (not copied into the test) so the
 * test require()s this real module and asserts against the exact strings sent
 * over the wire — CLAUDE.md rule 15, never a second drifting copy.
 */

'use strict';

const API_URL = 'https://api.linear.app/graphql';
const DEFAULT_TEAM_KEY = 'BRO';

// ── GraphQL text (pure strings — no I/O) ───────────────────────────────────

const ISSUE_CREATE_MUTATION = `mutation($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { id identifier title url }
  }
}`;

const ISSUE_UPDATE_MUTATION = `mutation($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue { id identifier }
  }
}`;

const COMMENT_CREATE_MUTATION = `mutation($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) {
    success
    comment { id }
  }
}`;

// Single-issue read by human identifier. Linear's `issue(id:)` field accepts
// either the UUID or the "BRO-123" identifier directly — no team/number
// filter needed.
const ISSUE_QUERY = `query($id: String!) {
  issue(id: $id) {
    id
    identifier
    title
    description
    priority
    url
    state { id name type }
  }
}`;

// ── the client ─────────────────────────────────────────────────────────────

class LinearClient {
  /**
   * @param {object} opts
   * @param {(query: string, variables?: object) => Promise<object>} opts.graphql
   *   The injected GraphQL executor. Given a query/mutation string and its
   *   variables, resolves to the `data` object Linear returns and REJECTS on
   *   GraphQL errors. This is the seam that makes the client testable: the
   *   real one talks to the network (see createLinearClient); a test passes a
   *   stub.
   * @param {string} [opts.teamKey='BRO'] Team key used by createIssue when the
   *   caller does not pass an explicit teamId-bearing input.
   */
  constructor({ graphql, teamKey = DEFAULT_TEAM_KEY } = {}) {
    if (typeof graphql !== 'function') {
      throw new TypeError(
        'LinearClient requires an injected `graphql(query, variables)` function — ' +
          'use createLinearClient() for the network-backed executor, or pass a stub in tests.'
      );
    }
    this.graphql = graphql;
    this.teamKey = teamKey;
  }

  /**
   * Create a new issue. Returns the created issue node
   * ({ id, identifier, title, url }).
   */
  async createIssue({ teamId, title, description, priority, stateId, projectId, assigneeId } = {}) {
    if (!teamId) throw new Error('createIssue: teamId is required');
    if (!title) throw new Error('createIssue: title is required');
    const data = await this.graphql(ISSUE_CREATE_MUTATION, {
      input: { teamId, title, description, priority, stateId, projectId, assigneeId },
    });
    if (!data || !data.issueCreate || !data.issueCreate.success) {
      throw new Error(`issueCreate failed for "${title}"`);
    }
    return data.issueCreate.issue;
  }

  /**
   * Patch an existing issue by id. `input` is a Linear IssueUpdateInput
   * (e.g. { stateId }, { title }, { priority }). Returns the issueUpdate
   * payload ({ success, issue }).
   */
  async updateIssue(id, input) {
    if (!id) throw new Error('updateIssue: id is required');
    if (!input || typeof input !== 'object') throw new Error('updateIssue: input object is required');
    const data = await this.graphql(ISSUE_UPDATE_MUTATION, { id, input });
    if (!data || !data.issueUpdate || !data.issueUpdate.success) {
      throw new Error(`issueUpdate failed for ${id}`);
    }
    return data.issueUpdate;
  }

  /**
   * Add a comment to an issue. Returns the created comment node ({ id }).
   */
  async addComment(issueId, body) {
    if (!issueId) throw new Error('addComment: issueId is required');
    if (!body) throw new Error('addComment: body is required');
    const data = await this.graphql(COMMENT_CREATE_MUTATION, { issueId, body });
    if (!data || !data.commentCreate || !data.commentCreate.success) {
      throw new Error(`commentCreate failed for issue ${issueId}`);
    }
    return data.commentCreate.comment;
  }

  /**
   * Delegate an issue to a Linear agent (app user). In Linear, delegation is
   * an issue field, not a separate mutation: setting `delegateId` on an
   * IssueUpdateInput hands the issue to the agent while the human assignee
   * keeps ownership (see Linear's "Assign and delegate issues" docs). Given
   * its own method (rather than making callers hand-build the delegateId
   * update) because "delegate to an agent" is a named operation in this
   * client's surface. Returns the issueUpdate payload ({ success, issue }).
   */
  async delegateToAgent(issueId, agentId) {
    if (!issueId) throw new Error('delegateToAgent: issueId is required');
    if (!agentId) throw new Error('delegateToAgent: agentId is required');
    return this.updateIssue(issueId, { delegateId: agentId });
  }

  /**
   * Read one issue by human identifier (e.g. "BRO-123") or UUID. Returns the
   * issue node, or null when the identifier doesn't resolve — same
   * "caller checks for null" contract as linear-client.js's getIssue().
   */
  async getIssue(identifier) {
    if (!identifier) throw new Error('getIssue: identifier is required');
    const data = await this.graphql(ISSUE_QUERY, { id: identifier });
    return (data && data.issue) || null;
  }
}

// ── production wiring (network-backed executor) ────────────────────────────

// Built lazily so requiring this module (e.g. from a test) never reads env or
// touches the network — only createLinearClient() below pulls the key in.
function createNetworkGraphql() {
  const { readEnvKeys } = require('./load-env');
  function getApiKey() {
    const { LINEAR_API_KEY } = readEnvKeys(['LINEAR_API_KEY']);
    const key = process.env.LINEAR_API_KEY || LINEAR_API_KEY;
    if (!key) throw new Error('LINEAR_API_KEY not set in .env or environment');
    return key;
  }
  return async function graphql(query, variables) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: getApiKey() },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
    const json = await res.json();
    if (json.errors && json.errors.length) {
      const err = new Error(`Linear GraphQL error: ${json.errors.map((e) => e.message).join('; ')}`);
      // Raw errors attached so callers can branch on a specific code
      // (e.g. USAGE_LIMIT_EXCEEDED) without string-matching the message.
      err.linearErrors = json.errors;
      throw err;
    }
    return json.data;
  };
}

/**
 * Build a LinearClient wired to the real, network-backed GraphQL executor.
 * This is the ONLY place a Linear API key is read — the class itself stays
 * pure and injectable.
 */
function createLinearClient({ teamKey = DEFAULT_TEAM_KEY } = {}) {
  return new LinearClient({ graphql: createNetworkGraphql(), teamKey });
}

module.exports = {
  LinearClient,
  createLinearClient,
  createNetworkGraphql,
  DEFAULT_TEAM_KEY,
  API_URL,
  // Exported so tests (and future callers) assert against the exact strings
  // this client sends — one copy, no drift (CLAUDE.md rule 15).
  ISSUE_CREATE_MUTATION,
  ISSUE_UPDATE_MUTATION,
  COMMENT_CREATE_MUTATION,
  ISSUE_QUERY,
};
