'use strict';

// Owner wording 2026-11-17 (BRO-7693): every reply we write to a reader ends
// with this line, just above the sign-off. Feedback replies
// (feedback-reply-drafts.js) and review-form confirmations
// (submission-decision.js) both read it from here, so the wording lives in one
// place. Welcome emails already ask for ideas in their own words; left as is.
const READER_REPLY_CLOSING_LINE = 'Thanks for using the site, and please do let me know if you have any other ideas or requests.';

module.exports = { READER_REPLY_CLOSING_LINE };
