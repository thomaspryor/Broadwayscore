#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('acorn');

// BRO-2519: the crown-loop handoff's "Dispatch funnel" contract is
// "Backlog/Todo, not Marketing, not BSC Daily/CANARY". Update this list
// whenever that documented contract changes. These issue-shaped guards
// cannot be blind-simulated by predispatch-queue-audit's Notion task audit.
const FUNNEL_CLAUSES = [
  { clause: 'Backlog/Todo: no terminal states', guard: 'checkTerminalStateGuard' },
  { clause: 'Backlog/Todo: no started states', guard: 'startedStateGuard' },
  { clause: 'Not Marketing', guard: 'marketingProjectGuard' },
  { clause: 'Not BSC Daily/CANARY', guard: 'autofixFiledIssueGuard' },
];

function isIdentifier(node, name) {
  return node?.type === 'Identifier' && node.name === name;
}

function isMember(node, object, property) {
  return node?.type === 'MemberExpression' && !node.computed &&
    isIdentifier(node.object, object) && isIdentifier(node.property, property);
}

function isRefusalExit(statement) {
  const call = statement.type === 'ExpressionStatement' && statement.expression;
  return call?.type === 'CallExpression' && isMember(call.callee, 'process', 'exit') &&
    call.arguments.length === 1 && call.arguments[0].value === 1;
}

// Match the dispatcher's actual guard-chain shape. A mention, ignored return,
// call inside a dead helper, or exit hidden in a nested branch is not a gate.
function hasRefusalGate(statements, binding, guard) {
  return statements.some((statement, index) => {
    if (statement.type !== 'VariableDeclaration') return false;
    return statement.declarations.some(({ id, init }) => {
      if (id.type !== 'Identifier' || init?.type !== 'CallExpression' ||
          !isMember(init.callee, binding, guard)) return false;
      const expectedArgs = guard === 'checkTerminalStateGuard' ? ['issue'] : ['issue', 'args'];
      if (init.arguments.length !== expectedArgs.length ||
          !expectedArgs.every((name, i) => isIdentifier(init.arguments[i], name))) return false;
      const refusal = statements[index + 1];
      return refusal?.type === 'IfStatement' && isIdentifier(refusal.test, id.name) &&
        refusal.consequent.type === 'BlockStatement' &&
        refusal.consequent.body.some(isRefusalExit);
    });
  });
}

function auditDispatchFunnelCoverage({
  guards = require('./linear-dispatch.js'),
  dispatchSource = fs.readFileSync(path.join(__dirname, '..', 'linear-next.js'), 'utf8'),
} = {}) {
  // Fail closed on parser errors. Never require linear-next: inspecting its
  // AST needs no credentials and cannot launch a worker or mutate Linear.
  const ast = parse(dispatchSource, { ecmaVersion: 'latest', sourceType: 'script' });
  const binding = ast.body.flatMap(node => node.type === 'VariableDeclaration' ? node.declarations : [])
    .find(({ id, init }) => id.type === 'Identifier' && init?.type === 'CallExpression' &&
      isIdentifier(init.callee, 'require') && init.arguments.length === 1 &&
      init.arguments[0].value === './lib/linear-dispatch.js')?.id.name;
  const main = ast.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'main');
  const mainStatements = main?.body.body || [];
  // A gate below the headless launch branch protects only cmux: headless
  // dispatch returns before reaching it. Fail closed if the branch changes
  // shape, so both launch paths keep the same documented funnel protection.
  const launchIndex = mainStatements.findIndex(node => node.type === 'IfStatement' &&
    node.test.type === 'BinaryExpression' && node.test.operator === '===' &&
    isMember(node.test.left, 'routing', 'mode') && node.test.right.value === 'headless');
  const statements = launchIndex < 0 ? [] : mainStatements.slice(0, launchIndex);

  return FUNNEL_CLAUSES.map(({ clause, guard }) => {
    const errors = [];
    if (typeof guards[guard] !== 'function') errors.push('not exported as a function by linear-dispatch.js');
    // Terminal states have an existing, explicit --force exemption. Other
    // clauses must be unconditional here; their guards own their bypasses.
    const terminalWrapper = guard === 'checkTerminalStateGuard' && statements.find(node =>
      node.type === 'IfStatement' && node.test.type === 'UnaryExpression' && node.test.operator === '!' &&
      isMember(node.test.argument, 'args', 'force') && node.consequent.type === 'BlockStatement');
    const wired = binding && (hasRefusalGate(statements, binding, guard) ||
      (terminalWrapper && hasRefusalGate(terminalWrapper.consequent.body, binding, guard)));
    if (!wired) errors.push('not wired to a refusal exit before the linear-next.js headless launch branch');
    return { clause, guard, errors };
  });
}

function main() {
  try {
    const results = auditDispatchFunnelCoverage();
    for (const { clause, guard, errors } of results) {
      console.log(`${errors.length ? 'FAIL' : 'PASS'} ${clause} -> ${guard}${errors.length ? ': ' + errors.join('; ') : ''}`);
    }
    const failures = results.filter(result => result.errors.length).length;
    console.log(`Dispatch funnel coverage: ${results.length - failures}/${results.length} clauses covered`);
    process.exitCode = failures ? 1 : 0;
  } catch (error) {
    console.error(`Dispatch funnel coverage: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { FUNNEL_CLAUSES, auditDispatchFunnelCoverage };
