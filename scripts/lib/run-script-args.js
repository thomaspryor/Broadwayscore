/**
 * The argument string a pending-fix plan's run-script action runs with
 * (execute-approved-fix.js). Plans give `args` as a string; some planners
 * wrote `arguments: ["--apply"]`, which the executor used to ignore, so the
 * script ran with no flags: BRO-5866's purge ran as a dry run and reported
 * success. An array in either field is accepted; any other shape is refused
 * rather than run without its flags.
 */
'use strict';

const SHELL_META = /[;&|`$(){}]/g;

/**
 * @param {{args?: string|string[], arguments?: string[]}} action
 * @returns {{ok: true, args: string} | {ok: false, reason: string}}
 */
function runScriptArgs(action) {
  const present = (v) => v !== undefined && v !== null && v !== '';
  // Both set: which one the planner meant is a guess, and guessing wrong is
  // the silent dry run this exists to stop.
  if (present(action.args) && present(action.arguments)) return { ok: false, reason: 'run-script action sets both args and arguments; use args' };
  const given = present(action.args) ? action.args : action.arguments;
  if (!present(given)) return { ok: true, args: '' };
  let list;
  if (typeof given === 'string') list = [given];
  else if (Array.isArray(given) && given.every((a) => typeof a === 'string')) list = given;
  else return { ok: false, reason: `run-script args must be a string or an array of strings (got ${JSON.stringify(given)})` };
  // execSync splits on spaces, so an array element with a space would split.
  const bad = Array.isArray(given) ? list.find((a) => /\s/.test(a)) : undefined;
  if (bad !== undefined) return { ok: false, reason: `run-script argument "${bad}" contains whitespace; pass it as separate elements` };
  return { ok: true, args: list.join(' ').replace(SHELL_META, '').trim() };
}

module.exports = { runScriptArgs };
