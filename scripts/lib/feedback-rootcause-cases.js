/**
 * feedback-rootcause-cases.js: one replayable intake case per reader report
 * whose "root cause" button the owner tapped (BRO-7919).
 *
 * The proposal email's root-cause button files a card keyed
 * `reader-feedback-rootcause-<issue>` (feedback-proposal.js buildRootCauseUrl).
 * No alert router ever writes that key, so check-alert-condition-absent.js
 * could only answer CANNOT TELL for it. The session that fixes the root cause
 * adds the reader's ask here (public wording only: the issue's show field and a
 * paraphrase of its public summary, never the private message, name or email)
 * with the catalog rows it needs. The checker replays the real intake router on
 * it: the condition is absent when the router now closes the ask as already in
 * the catalog. tests/unit/feedback-rootcause-cases.test.mjs replays every case,
 * so a later router change that reopens one fails CI.
 */
'use strict';

const CASES = {
  1190: {
    issue: 'https://github.com/thomaspryor/Broadwayscore/issues/1190',
    why: 'Two "13 Going on 30" productions; the reader named Toronto, the one we list as upcoming.',
    show: '13 Going on 30 - Toronto run coming up',
    message: 'There is a new show 13 Going on 30 that played a short London run and now goes to Toronto at Mirvish from December 1, 2026 to January 24, 2027. Can you add it? It stars Lucie Jones.',
    shows: [
      { id: '13-going-on-30-toronto-regional-2026', title: '13 Going on 30', venue: 'Princess of Wales Theatre, Toronto, ON', city: 'toronto-on', market: 'regional', category: 'regional', status: 'upcoming', openingDate: '2026-12-01' },
      { id: '13-going-on-30-manchester-regional-2025', title: '13 Going on 30', venue: 'Manchester Opera House, Manchester', city: 'manchester-uk', market: 'regional', category: 'regional', status: 'closed', openingDate: '2025-09-21' },
    ],
    expect: { alreadyInCatalog: ['13-going-on-30-toronto-regional-2026'] },
  },
};

const KEY_RE = /^reader-feedback-rootcause-(\d+)$/;

/** Issue number for a root-cause condition key, else null. */
function rootCauseIssueNumber(key) {
  const m = KEY_RE.exec(String(key || '').trim());
  return m ? Number(m[1]) : null;
}

/**
 * Replay one case through the real router.
 * @returns {{ code: 0|1|3, message: string }} 0 absent, 1 still firing, 3 no case
 */
function replayCase(issueNumber, cases = CASES) {
  const c = cases[issueNumber];
  if (!c) {
    return { code: 3, message: `CANNOT TELL: no replay case for reader report #${issueNumber}; add one to scripts/lib/feedback-rootcause-cases.js (public wording only) with the fix` };
  }
  const { planContentRequestActions } = require('./content-request-routing.js');
  const { isAlreadyInCatalog } = require('./feedback-issue-body.js');
  const actions = planContentRequestActions({ message: c.message, show: c.show, shows: c.shows });
  const want = [...c.expect.alreadyInCatalog].sort();
  const got = [...new Set(actions.map((a) => a && a.showId).filter(Boolean))].sort();
  if (isAlreadyInCatalog(actions) && JSON.stringify(got) === JSON.stringify(want)) {
    return { code: 0, message: `PASS: intake router now closes reader report #${issueNumber} as already in the catalog (${got.join(', ')})` };
  }
  const kinds = actions.map((a) => `${a.kind}${a.showId ? `:${a.showId}` : ''}${a.alreadyInCatalog === false ? '(not bare)' : ''}`).join(', ');
  return { code: 1, message: `FAIL: intake router still leaves reader report #${issueNumber} open (${kinds}); expected already-in-catalog ${want.join(', ')}` };
}

module.exports = { CASES, rootCauseIssueNumber, replayCase };
