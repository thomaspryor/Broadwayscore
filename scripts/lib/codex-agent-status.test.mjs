import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assessCodexAgentStatus, isCodexDelegate } = require('./codex-agent-status.js');

const NOW = Date.parse('2026-08-26T12:00:00.000Z');
const ago = (min) => new Date(NOW - min * 60000).toISOString();

const issue = (identifier, sessions, delegateName = 'Codex') => ({ identifier, delegateName, sessions });

test('isCodexDelegate matches case-insensitively and ignores other delegates', () => {
  assert.equal(isCodexDelegate('Codex'), true);
  assert.equal(isCodexDelegate('codex'), true);
  assert.equal(isCodexDelegate('Cyrus'), false);
  assert.equal(isCodexDelegate(undefined), false);
});

test('no Codex-delegated issues at all reports unknown, not disconnected', () => {
  const r = assessCodexAgentStatus([issue('BRO-1', [{ createdAt: ago(10), status: 'active', activities: [] }], 'Cyrus')], NOW);
  assert.equal(r.status, 'unknown');
  assert.equal(r.verdicts.length, 0);
});

// This is the exact BRO-256 signature: Linear shows the issue as delegated,
// but never creates an agent session at all.
test('every Codex attempt with zero sessions is reported disconnected', () => {
  const r = assessCodexAgentStatus(
    [
      issue('BRO-256', []),
      issue('BRO-260', []),
    ],
    NOW
  );
  assert.equal(r.status, 'disconnected');
  assert.match(r.detail, /BRO-256/);
  assert.equal(r.verdicts.every((v) => v.verdict === 'never-started'), true);
});

test('a Codex delegation that produced any session activity is reported connected', () => {
  const r = assessCodexAgentStatus(
    [
      issue('BRO-300', [
        {
          createdAt: ago(5),
          status: 'active',
          activities: [{ createdAt: ago(2), body: "I'll start by exploring the existing code structure." }],
        },
      ]),
    ],
    NOW
  );
  assert.equal(r.status, 'connected');
});

test('a mix of never-started and working Codex issues is still connected — the request IS reaching the agent', () => {
  const r = assessCodexAgentStatus(
    [
      issue('BRO-256', []),
      issue('BRO-300', [
        {
          createdAt: ago(5),
          status: 'active',
          activities: [{ createdAt: ago(2), body: 'Investigating the failing test.' }],
        },
      ]),
    ],
    NOW
  );
  assert.equal(r.status, 'connected');
});

test('a brand-new Codex session with no verdict evidence yet is unknown, not disconnected', () => {
  const r = assessCodexAgentStatus(
    [issue('BRO-400', [{ createdAt: ago(0.1), status: 'active', activities: [] }])],
    NOW
  );
  assert.equal(r.status, 'unknown');
});
