// Review-panel commands must not spawn model-inheriting subagents.
// A subagent_type "general-purpose" with no model inherits the parent
// session's model, so an Opus/Fable session fans out four Opus/Fable
// reviewers (cloud-memory/feedback_subagent_model_inheritance_cost.md).
// The panels use the project agents in .claude/agents/, which pin a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const commandsDir = path.join(root, '.claude', 'commands');
const agentsDir = path.join(root, '.claude', 'agents');

function parseFrontmatter(text) {
  const m = text.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

const EXPECTED = {
  'review-panelist': { model: 'claude-opus-5-5', effort: 'medium' },
  'repo-sweeper': { model: 'claude-sonnet-5-5', effort: 'low' },
};
const BUILTIN = new Set(['general-purpose', 'Explore', 'Plan', 'claude', 'claude-code-guide', 'statusline-setup']);

const commandFiles = fs.readdirSync(commandsDir).filter((f) => f.endsWith('.md'));

test('no command spawns subagent_type "general-purpose" without a model', () => {
  const offenders = [];
  for (const f of commandFiles) {
    fs.readFileSync(path.join(commandsDir, f), 'utf8').split('\n').forEach((line, i) => {
      if (/subagent_type\W+general-purpose/.test(line) && !/\bmodel\b/.test(line)) {
        offenders.push(`${f}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `use subagent_type "review-panelist" or "repo-sweeper": ${offenders.join(', ')}`);
});

test('every non-builtin subagent_type in commands has an agent file', () => {
  const missing = [];
  for (const f of commandFiles) {
    const text = fs.readFileSync(path.join(commandsDir, f), 'utf8');
    for (const m of text.matchAll(/subagent_type\s*[:=]?\s*["']([\w-]+)["']/g)) {
      if (!BUILTIN.has(m[1]) && !fs.existsSync(path.join(agentsDir, `${m[1]}.md`))) missing.push(`${f}: ${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('a prose "Claude agent" spawn names its subagent_type on the same line', () => {
  // "fall back to a Claude agent" with no agent name gets improvised as
  // general-purpose, which inherits the parent model.
  const offenders = [];
  for (const f of commandFiles) {
    fs.readFileSync(path.join(commandsDir, f), 'utf8').split('\n').forEach((line, i) => {
      if (/(use|fall back to|launch) a (single )?Claude agent/i.test(line) && !/subagent_type/.test(line)) {
        offenders.push(`${f}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(offenders, []);
});

const PANELS = {
  'plan-review.md': 'review-panelist',
  'ship-check.md': 'review-panelist',
  'second-opinion.md': 'review-panelist',
  'right-problem.md': 'review-panelist',
  'plan-tasks.md': 'repo-sweeper',
};
for (const [file, agent] of Object.entries(PANELS)) {
  test(`${file} spawns the pinned ${agent} agent`, () => {
    const text = fs.readFileSync(path.join(commandsDir, file), 'utf8');
    assert.ok(text.includes(`subagent_type "${agent}"`));
  });
}

for (const [name, want] of Object.entries(EXPECTED)) {
  test(`agent ${name} parses with pinned model, effort and read-only tools`, () => {
    const fm = parseFrontmatter(fs.readFileSync(path.join(agentsDir, `${name}.md`), 'utf8'));
    assert.ok(fm, 'frontmatter must parse');
    assert.equal(fm.name, name);
    assert.equal(fm.model, want.model);
    assert.equal(fm.effort, want.effort);
    assert.ok(fm.description && fm.description.length <= 200, 'description must be short');
    assert.ok(fm.tools, `${name} must declare an explicit tools allowlist`);
    const tools = fm.tools.split(',').map((t) => t.trim());
    for (const banned of ['Write', 'Edit', 'NotebookEdit', 'Agent', 'Task']) {
      assert.ok(!tools.includes(banned), `${name} must not have ${banned}`);
    }
  });
}
