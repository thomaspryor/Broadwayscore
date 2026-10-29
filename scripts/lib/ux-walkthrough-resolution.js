#!/usr/bin/env node
'use strict';

// Read-only, card-specific acceptance. Unit tests of the filer cannot prove that a finding was checked.
const { classifyStatus } = require('./visual-approval.js');
const { hasHelpFlag } = require('./cli-help.js');
const { stripCode } = require('../../src/lib/owner-decision-link.js');

function resolutionForIssue(issue) {
  const comments = [...((issue.comments && issue.comments.nodes) || [])]
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  // Only comments count: instructions and example reasons in the description are not closing evidence.
  const lines = comments.flatMap(c => stripCode(c.body));
  const resolution = lines.filter(l => /^UX-RESOLUTION:/i.test(l)).at(-1);
  const reason = /^UX-RESOLUTION:[ \t]*noise:[ \t]*(.+)$/i.exec(resolution || '')?.[1].trim();
  if (reason && reason.length >= 20 && !/[<>]|^(?:TODO|TBD|placeholder|example)\b/i.test(reason)) {
    return { ok: true, reason: 'noise checked, with a closing reason recorded' };
  }
  if (classifyStatus(issue.description, comments) === 'landed') {
    return { ok: true, reason: 'visual approval landing recorded' };
  }
  return { ok: false, reason: 'record a UX-RESOLUTION: noise: comment with what you checked, or land the visually approved fix' };
}

async function checkResolution(key, client = require('./linear-client.js')) {
  if (!/^[a-f0-9]{32}$/.test(key || '')) throw new Error('Expected a 32-hex finding key');
  const marker = `UX-FINDING: ${key}`;
  const data = await client.graphql(`query($marker: String!, $teamKey: String!) {
    issues(first: 2, filter: { team: { key: { eq: $teamKey } }, description: { contains: $marker } }) {
      nodes { identifier title description
        comments(first: 100, orderBy: createdAt) {
          nodes { body createdAt } pageInfo { hasNextPage endCursor }
        }
      }
      pageInfo { hasNextPage }
    }
  }`, { marker, teamKey: client.TEAM_KEY });
  const issues = data.issues?.nodes;
  if (!Array.isArray(issues) || issues.length !== 1 || data.issues.pageInfo?.hasNextPage) {
    return { ok: false, reason: 'expected exactly one card for this finding key' };
  }
  const issue = issues[0];
  if (!/^UX audit:/.test(issue.title || '') || !String(issue.description || '').split('\n').includes(marker)) {
    return { ok: false, reason: 'the finding key is not on a UX walkthrough card' };
  }
  let page = issue.comments;
  if (!Array.isArray(page?.nodes) || typeof page.pageInfo?.hasNextPage !== 'boolean') throw new Error('Incomplete comment read');
  const comments = [...page.nodes];
  const cursors = new Set();
  while (page.pageInfo.hasNextPage) {
    const after = page.pageInfo.endCursor;
    if (!after || cursors.has(after) || comments.length >= 2000) throw new Error('Incomplete comment read');
    cursors.add(after);
    const next = await client.graphql(`query($id: String!, $after: String!) {
      issue(id: $id) { comments(first: 100, after: $after, orderBy: createdAt) {
        nodes { body createdAt } pageInfo { hasNextPage endCursor }
      } }
    }`, { id: issue.identifier, after });
    page = next.issue?.comments;
    if (!Array.isArray(page?.nodes) || typeof page.pageInfo?.hasNextPage !== 'boolean') throw new Error('Incomplete comment read');
    comments.push(...page.nodes);
  }
  return { ...resolutionForIssue({ ...issue, comments: { nodes: comments } }), id: issue.identifier };
}

async function main(args = process.argv.slice(2), client) {
  if (hasHelpFlag(args)) {
    console.log('Usage: node scripts/lib/ux-walkthrough-resolution.js --key=<32-hex finding key>');
    return 0;
  }
  try {
    if (args.length !== 1 || !/^--key=[a-f0-9]{32}$/.test(args[0])) throw new Error('Expected --key=<32-hex finding key>');
    const result = await checkResolution(args[0].slice(6), client);
    console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.id || 'UX finding'}: ${result.reason}`);
    return result.ok ? 0 : 1;
  } catch (error) {
    console.error(`FAIL UX resolution: ${error.message}`);
    return 2;
  }
}

if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { resolutionForIssue, checkResolution, main };
