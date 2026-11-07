'use strict';

const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const { isPageWorthy } = require('./page-worthy-alerts');
const { shouldEmailAlert } = require('./discord-notify');

// BRO-3946: scan inline github-script alerts using their actual delivery
// policies. routeAlert's human, page-worthy path emails even for info/warning
// (it promotes delivery severity); sendAlert requires email:true and an
// emailable severity. Unknown/dynamic options are conservatively included.
// Comments, descriptions and other calls' option objects are not evidence.
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach(item => walk(item, visit));
  if (node.type) visit(node);
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') walk(value, visit);
  }
}

function staticValue(node) {
  if (node?.type === 'Literal') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return undefined;
}

function readOption(object, key, defaultValue) {
  if (object?.type !== 'ObjectExpression') return undefined;
  let value = defaultValue;
  for (const property of object.properties) {
    if (property.type === 'SpreadElement') value = undefined;
    else if ((property.computed ? staticValue(property.key) : property.key.name || staticValue(property.key)) === key) {
      value = staticValue(property.value);
    }
  }
  return value;
}

function findInlineAlertCalls(script) {
  const ast = acorn.parse(script, {
    ecmaVersion: 'latest', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true,
  });
  const bindings = new Map();
  walk(ast, node => {
    if (node.type !== 'VariableDeclarator' || node.init?.type !== 'CallExpression') return;
    if (node.init.callee.name !== 'require') return;
    const source = staticValue(node.init.arguments[0]);
    if (typeof source !== 'string') return;
    const name = /(?:^|\/)owner-alert-router(?:\.js)?$/.test(source) ? 'routeAlert'
      : /(?:^|\/)discord-notify(?:\.js)?$/.test(source) ? 'sendAlert' : null;
    if (!name) return;
    if (node.id.type === 'Identifier') bindings.set(node.id.name, { namespace: true, name });
    if (node.id.type === 'ObjectPattern') {
      for (const property of node.id.properties) {
        if (property.key?.name === name && property.value?.type === 'Identifier') {
          bindings.set(property.value.name, { namespace: false, name });
        }
      }
    }
  });
  const calls = [];
  walk(ast, node => {
    if (node.type !== 'CallExpression') return;
    const callee = node.callee;
    const binding = bindings.get(callee.type === 'Identifier' ? callee.name : callee.object?.name);
    if (!binding) return;
    if (binding.namespace ? callee.type !== 'MemberExpression'
      || (callee.computed ? staticValue(callee.property) : callee.property.name) !== binding.name
      : callee.type !== 'Identifier') return;
    const options = node.arguments[0];
    const severity = readOption(options, 'severity', 'error');
    const conditionKey = readOption(options, 'conditionKey');
    const disposition = readOption(options, 'disposition');
    const email = readOption(options, 'email', false);
    const immediateEmail = binding.name === 'routeAlert'
      ? (disposition === undefined || disposition === 'human')
        && (conditionKey === undefined || isPageWorthy(conditionKey))
      : (email === undefined || Boolean(email))
        && (severity === undefined || shouldEmailAlert(severity));
    calls.push({ function: binding.name, severity, conditionKey, disposition, immediateEmail });
  });
  return calls;
}

function findInlineAlertSteps(workflowsDir, yamlLoad) {
  const found = [];
  for (const file of fs.readdirSync(workflowsDir).filter(f => /\.ya?ml$/.test(f)).sort()) {
    const doc = yamlLoad(fs.readFileSync(path.join(workflowsDir, file), 'utf8')) || {};
    for (const [jobId, job] of Object.entries(doc.jobs || {})) {
      const steps = job.steps || [];
      steps.forEach((step, index) => {
        if (!/^actions\/github-script@/.test(step.uses || '')) return;
        const script = step.with?.script;
        if (typeof script !== 'string') return;
        const calls = findInlineAlertCalls(script);
        if (calls.length) found.push({ file, jobId, index, steps, name: step.name || '(unnamed)', if: String(step.if || ''), calls });
      });
    }
  }
  return found;
}

function findFailureOnlyPagingAlerts(entries) {
  return entries.filter(entry => entry.calls.some(call => call.immediateEmail)
    && /\bfailure\s*\(\s*\)/.test(entry.if) && !canRunOnCancellation(entry.if));
}

// Check status guards with failure=false and cancelled=true. Other operands
// are unknown: an output/ref guard may be satisfied, but failure() AND
// cancelled() cannot. This also accepts always() rather than requiring a
// redundant cancelled() spelling when the condition already covers it.
function canRunOnCancellation(condition) {
  if (!condition.trim()) return false; // implicit success() guard
  const source = condition.trim().replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, '$1');
  const ast = acorn.parse(`(${source})`, { ecmaVersion: 'latest' });
  let hasStatusCheck = false;
  walk(ast, node => {
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier'
      && ['failure', 'success', 'cancelled', 'always'].includes(node.callee.name)) hasStatusCheck = true;
  });
  if (!hasStatusCheck) return false; // GitHub adds success() to ordinary conditions
  function evaluate(node) {
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
      if (node.callee.name === 'cancelled' || node.callee.name === 'always') return true;
      if (node.callee.name === 'failure' || node.callee.name === 'success') return false;
    }
    if (node.type === 'Literal' && typeof node.value === 'boolean') return node.value;
    if (node.type === 'UnaryExpression' && node.operator === '!') {
      const value = evaluate(node.argument);
      return value === undefined ? undefined : !value;
    }
    if (node.type === 'LogicalExpression') {
      const left = evaluate(node.left), right = evaluate(node.right);
      if (node.operator === '&&') {
        if (left === false || right === false) return false;
        if (left === true && right === true) return true;
      }
      if (node.operator === '||') {
        if (left === true || right === true) return true;
        if (left === false && right === false) return false;
      }
    }
    return undefined;
  }
  return evaluate(ast.body[0].expression) !== false;
}

function findBlockedPagingCheckouts(entries) {
  return entries.filter(entry => {
    if (!entry.calls.some(call => call.immediateEmail) || !canRunOnCancellation(entry.if)) return false;
    const checkouts = entry.steps.slice(0, entry.index)
      .filter(step => /^actions\/checkout@/.test(step.uses || ''));
    return checkouts.length > 0 && checkouts.every(step => step.if && !canRunOnCancellation(String(step.if)));
  });
}

module.exports = { findInlineAlertCalls, findInlineAlertSteps, findFailureOnlyPagingAlerts, findBlockedPagingCheckouts };
