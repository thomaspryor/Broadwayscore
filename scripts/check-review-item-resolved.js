#!/usr/bin/env node
/**
 * check-review-item-resolved.js (BRO-5371): read-only acceptance check for the commercial
 * review cards that used to be parked "awaiting owner's manual look" with a bare
 * "VERIFY: owner-judgment". A cloud worker can now do the review, and this exits 0 once it did.
 *
 *   --claim=<pending key>   a recouped claim: the pending row is gone (applied or rejected),
 *                           or the show carries humanReviewedDesignation
 *   --closure=<slug>        a stale-closure review: the show has a designation other than TBD,
 *                           or humanReviewedDesignation
 *   --held-empty            the pending-review file has no rows left
 *   --issue-closed=<N>      GitHub issue N (the feedback report) is closed (one read-only gh api GET)
 * Exit 0 resolved, 1 still open, 2 bad usage. Never writes.
 */
'use strict';

require('./lib/cli-help').exitOnHelp(module);

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const load = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));

function slugOfKey(key) {
  return String(key).replace(/-\d{4}$/, '');
}

/** @returns {{ resolved: boolean, why: string }} */
function checkResolved(mode, value, { commercial, pending }) {
  const shows = (commercial && commercial.shows) || {};
  if (mode !== 'closure' && !(pending && pending.shows && typeof pending.shows === 'object' && !Array.isArray(pending.shows))) {
    return { resolved: false, why: 'pending-review file has an unrecognised shape' };
  }
  const rows = (pending && pending.shows) || {};
  if (mode === 'claim') {
    if (!Object.prototype.hasOwnProperty.call(rows, value)) return { resolved: true, why: `pending row ${value} is gone` };
    const show = Object.prototype.hasOwnProperty.call(shows, value) ? shows[value] : shows[slugOfKey(value)];
    if (show && show.humanReviewedDesignation === true) return { resolved: true, why: `${value} marked humanReviewedDesignation` };
    return { resolved: false, why: `pending row ${value} still waits` };
  }
  if (mode === 'closure') {
    const show = shows[value];
    if (!show) return { resolved: false, why: `no commercial.json entry for ${value}` };
    if (show.humanReviewedDesignation === true) return { resolved: true, why: `${value} marked humanReviewedDesignation` };
    if (show.designation && show.designation !== 'TBD') return { resolved: true, why: `${value} designation is ${show.designation}` };
    return { resolved: false, why: `${value} is still TBD` };
  }
  if (mode === 'held-empty') {
    // The digest card lists every pending row and closes only when none remain.
    const keys = Object.keys(rows);
    return keys.length ? { resolved: false, why: `${keys.length} pending row(s) remain: ${keys.slice(0, 3).join(', ')}` } : { resolved: true, why: 'no pending row remains' };
  }
  return { resolved: false, why: `unknown mode ${mode}` };
}

function parse(argv) {
  const a = argv.slice(2);
  if (a.length !== 1) return null;
  let m;
  if ((m = /^--(claim|closure)=([a-z0-9][a-z0-9:_-]{0,120})$/.exec(a[0]))) return { mode: m[1], value: m[2] };
  if (a[0] === '--held-empty') return { mode: 'held-empty', value: '' };
  if ((m = /^--issue-closed=([1-9]\d{0,6})$/.exec(a[0]))) return { mode: 'issue-closed', value: m[1] };
  return null;
}

function issueState(n) {
  const r = require('child_process').spawnSync('gh', ['api', `repos/thomaspryor/Broadwayscore/issues/${n}`, '--jq', '.state'], { encoding: 'utf8', timeout: 30000 });
  return r.status === 0 ? r.stdout.trim().toLowerCase() : null;
}

function main(argv) {
  const parsed = parse(argv);
  if (parsed && parsed.mode !== 'issue-closed' && !fs.existsSync(path.join(DATA, 'commercial.json'))) {
    console.error('OPEN: private data/commercial.json is missing in this checkout');
    return 1;
  }
  if (!parsed) {
    console.error('usage: check-review-item-resolved.js --claim=<pending key> | --closure=<slug> | --held-empty | --issue-closed=<N>');
    return 2;
  }
  if (parsed.mode === 'issue-closed') {
    const state = issueState(parsed.value);
    if (state === null) { console.error(`OPEN: could not read issue ${parsed.value}`); return 1; }
    console.log(`${state === 'closed' ? 'RESOLVED' : 'OPEN'}: issue ${parsed.value} is ${state}`);
    return state === 'closed' ? 0 : 1;
  }
  const res = checkResolved(parsed.mode, parsed.value, { commercial: load('commercial.json'), pending: load('commercial-pending-review.json') });
  console.log(`${res.resolved ? 'RESOLVED' : 'OPEN'}: ${res.why}`);
  return res.resolved ? 0 : 1;
}

if (require.main === module) process.exit(main(process.argv));
module.exports = { checkResolved, parse, slugOfKey };
