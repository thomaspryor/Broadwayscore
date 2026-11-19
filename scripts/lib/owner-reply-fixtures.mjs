// Shared reply fixtures for the push-gate reader tests (BRO-7848, BRO-7873) and the judge replay script.
// The OWNER_YES entries are verbatim messages from 2026-11-19 that the old whole-message keyword check
// refused, costing the owner six repeated yeses.
export const OWNER_YES = [
  "Yes\nBut fix the system so it's far less inefficient after",
  'Go',
  "okay, this has just gotten outrageous. I don't know how many times I need to say yes, do it, go, ship it, but get it done and then use Opus plan to figure out how I never have to fall into this heinous trap again.",
  'ship it',
  'yes',
  'Ship all four',
  'looks good',
  'go!',
  'yes, go ahead',
  'Go. Ship it.',
];

// Every one of these is a stop or a conditional: approving it would ship against the owner's wish.
export const MUST_NOT_APPROVE = [
  "don't ship",
  'do not push it yet',
  'yes but wait',
  'looks good, fix the padding first',
  'go back and change the color',
  'no',
  'not yet',
  'hold on',
  'send me the screenshots first',
  'looks good except the footer',
  'yes, unless mobile is broken',
  'Yes after you fix the padding',
  'ship it once the build is green',
  'looks great but I want to see mobile before we push',
  "ship it? I'm not sure",
  'not sure, go',
  'do it later',
  "yes I'd rather you didn't",
  'love it, though the footer is off',
  'please hold',
  'actually wait',
  'nah',
  'I said don’t push it yet',
  'ship it? no wait',
  // Second-review findings (BRO-7848): negation split from its verb, partial approvals, conditions, delays.
  "don't. ship. it.", 'do. not. ship.', 'ship it, NOT', 'yes. kidding. don’t.',
  'yes but not the header', 'ship it but not the footer', 'looks good but not on mobile', 'nice but not quite',
  'I said yes to the copy, not the layout', 'ship version B not A', 'not A, ship B',
  'yes but let me check', 'yes but I need to see mobile', 'approve but I want to look again', 'yes but let me sleep on it',
  'ship it but only after review', 'looks good but the mobile is broken', 'yes but the header is wrong', 'yes, however the footer is off',
  'yes if tests pass', 'ship if green', 'deploy when CI passes', 'ship it when ready', 'yes, assuming tests pass',
  'yes provided it builds', 'yes as long as mobile works', 'yes, pending review', 'ship it next week', 'ship it monday',
  'ship it in an hour', 'ship it after lunch', 'ship it soon', 'approve after I look', 'ok nice, now show me mobile',
  'looks great, can you also show tablet', 'Yes\nhmm the mobile is off', 'yes\nactually, let me look again',
  'cannot ship this', "I wouldn't ship this", 'DO NOT SHIP', 'dont ship', 'sure, but not yet', "let's wait", 'yes\nactually hold off',
];

// Gray replies a person reads as a go-ahead but a word list cannot. The judge is expected to answer "approve".
export const GRAY_YES = [
  'sounds good',
  "that's the one",
  'works for me',
  'looks right to me',
  "I'm happy with it",
  'yes. also look at the footer separately',
  'yes, though the system still asks too much',
  'ship it, also fix the system',
  // held out from the prompt wording
  'sounds right, separately can you look at the settings page',
  'awesome, thanks',
  'all set, and in a follow up please fix the typo',
];

// Gray replies that still hold the push back. The judge is expected to answer "ask".
export const GRAY_ASK = [
  'good but can you make the badge bigger',
  'nice. one thing, the title wraps on iphone',
  'i like it, can you also show me the dark mode',
  'fine, but the spacing looks odd',
  'the score badge looks smaller than before',
  'hmm',
];
