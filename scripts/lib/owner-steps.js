'use strict';
// BRO-7994: manual steps handed to the owner (a non-technical person, usually on a phone) must be usable as written:
// numbered, one action per step, a direct link wherever one can be built, the exact on-screen button and field names
// in quotes, what they will see when it worked, and no jargon or ids they have to interpret.
//
// Incident (2026-11-21): the owner received "In the Google console, add both broadwayscorecard.com addresses as
// authorized JavaScript origins on the web client starting 1084460721483-0vvpc, leaving the redirect URIs alone, then
// tell me when you've saved." No link, no click path, jargon throughout, a credential named by an id prefix. The repo
// already had the deep-link builder (consoleClientUrl in gmail-reauth.js); nothing pointed sessions at it.
//
//   node scripts/lib/owner-steps.js                    -> list recipes
//   node scripts/lib/owner-steps.js <recipe> [k=v ...] -> print ready-to-paste steps for the owner
//   node scripts/lib/owner-steps.js --lint <file|->    -> list what is wrong with owner steps in a message (exit 1 on problems)
//
// Used by scripts/lib/owner-steps-stop.mjs (Stop check). Pinned by owner-steps.test.mjs.
const fs = require('node:fs');
const path = require('node:path');
// Lazy (hook-replay scope): gmail-reauth pulls a signing chain the Stop check never needs at load.
function consoleClientUrl(id) {
  return require('./gmail-reauth.js').consoleClientUrl(id);
}

const ROOT = path.resolve(__dirname, '..', '..');
const SITE_ORIGINS = ['https://broadwayscorecard.com', 'https://www.broadwayscorecard.com'];

/** The Google web client id the site really uses: the env override when set, else the fallback in google-one-tap.ts. */
function googleWebClientId(env = process.env) {
  if (env.NEXT_PUBLIC_GOOGLE_CLIENT_ID) return env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  try {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'google-one-tap.ts'), 'utf8');
    const m = /GOOGLE_WEB_CLIENT_ID\s*=[\s\S]{0,120}?'(\d+-[a-z0-9]+\.apps\.googleusercontent\.com)'/.exec(src);
    return m ? m[1] : null;
  } catch { return null; }
}

// Each recipe returns { title, link, steps: [one action each], seen, note? }. Quote on-screen names exactly.
const RECIPES = {
  'google-js-origins': {
    about: 'Let Google sign-in (One Tap) run on the live site: add the site addresses to the Google sign-in settings.',
    build: ({ clientId = googleWebClientId() } = {}) => ({
      title: 'Let Google sign-in work on the live site',
      link: consoleClientUrl(clientId),
      steps: [
        'Open this link, signed in with the Google account that owns Broadway Scorecard: ' + consoleClientUrl(clientId),
        'Scroll down to the box called "Authorized JavaScript origins".',
        'Tap "+ Add URI" under that box.',
        `Type ${SITE_ORIGINS[0]} in the new empty line.`,
        'Tap "+ Add URI" again.',
        `Type ${SITE_ORIGINS[1]} in the second new line.`,
        'Scroll to the bottom and tap "Save". Leave every other box as it is.',
      ],
      seen: `Both addresses are listed under "Authorized JavaScript origins", and a note from Google says the change can take a little while to apply. Then reply "done".`,
    }),
  },
  'github-secret': {
    about: 'Add a secret value the automation needs (name=SECRET_NAME).',
    build: ({ name = 'SECRET_NAME' } = {}) => ({
      title: `Save the ${name} key for the site's automation`,
      link: 'https://github.com/thomaspryor/Broadwayscore/settings/secrets/actions/new',
      steps: [
        'Open this link: https://github.com/thomaspryor/Broadwayscore/settings/secrets/actions/new',
        `In the "Name" box, type ${name}`,
        'In the "Secret" box, paste the key.',
        'Tap "Add secret".',
      ],
      seen: `${name} appears in the list under "Repository secrets". Then reply "done".`,
    }),
  },
  'claude-env-var': {
    about: 'Add a setting to the Claude cloud environment (name=KEY). No direct link exists, so the click path is spelled out.',
    build: ({ name = 'KEY' } = {}) => ({
      title: `Add ${name} to the Claude cloud settings`,
      link: 'https://claude.ai/code',
      steps: [
        'Open this link: https://claude.ai/code',
        'Tap the cloud icon with the environment name, at the top of the screen.',
        'Tap the gear next to the environment.',
        `In the "Environment variables" box, add a new line: ${name}=<the value>`,
        'Tap "Save".',
      ],
      seen: `The new line ${name}=... is in the "Environment variables" box when you open the gear again. Then reply "done".`,
    }),
  },
};

/** Ready-to-paste text for the owner. */
function render(id, params = {}) {
  const r = RECIPES[id];
  if (!r) throw new Error(`unknown recipe "${id}" (have: ${Object.keys(RECIPES).join(', ')})`);
  const b = r.build(params);
  return [`You need to: ${b.title.charAt(0).toLowerCase()}${b.title.slice(1)}.`, ...b.steps.map((s, i) => `${i + 1}. ${s}`), `You'll see: ${b.seen}`].join('\n');
}

// ─── Lint ────────────────────────────────────────────────────────────────────
// What the owner is asked to do by hand. Only these blocks are judged, so a report that MENTIONS a console is not.
const UI_VERB = String.raw`(?:add|click|tap|open|go to|visit|paste|sign in|log in|select|enable|disable|turn (?:on|off)|type|enter|save|press|delete|remove|change|set|create|upload|copy|scroll|find|check the box|toggle|install|rotate|revoke|generate|connect)`;
// No bare settings/google/linear/domain (ship-check): "check the settings page" on our own site, "sign in with
// Google" and "approve the Linear card" are not steps on an outside site's settings.
const OUTSIDE_SITE = String.raw`(?:console|dashboard|google (?:cloud|console|account settings|search console|admin)|apple|app store|testflight|vercel|supabase|github|resend|cloudflare|registrar|dns|claude\.ai|posthog|sentry|stripe|impact|formspree|developer|admin page|account page|bright ?data|scrapingbee|gmail settings|domain (?:settings|records?|registrar))`;
const MANUAL_RE = new RegExp(String.raw`\b${UI_VERB}\b[^.\n]{0,120}?\b${OUTSIDE_SITE}\b|\b${OUTSIDE_SITE}\b[^.\n]{0,120}?\b${UI_VERB}\b`, 'i');
// Asks that only want a reply, a choice or an in-chat approval are not manual steps.
const REPLY_ONLY_RE = /^\W*(?:reply|answer|say|choose|pick|tell me|approve|confirm|look at|read|check)\b/i;
const VERB_RE = new RegExp(String.raw`\b${UI_VERB}\b`, 'gi');
// Words the owner has to interpret. Exact on-screen names in quotes are fine and are stripped first.
const JARGON_RE = /\b(?:o-?auth|client[ -]?id|web client|origins?|redirect uris?|env(?:ironment)? var(?:iable)?s?|api key|token|cname|txt record|a record|dns record|webhook|endpoint|repo(?:sitory)?|workflow|ci\b|scopes?|credentials?|cors|csp|fedcm|gsi|deploy(?:ment)?|branch|commit|pr\b|pull request|json|yaml|cli|terminal|ssh|sdk|jwt|bundle id|service id|payload)\b/i;
const SEEN_RE = /\byou(?:'|’)?ll see\b|\byou will see\b|\bwhen it (?:worked|works)\b|\bif it worked\b|\bshould (?:now )?(?:see|show)\b|\bit worked (?:when|if)\b/i;
const NUMBERED_RE = /^\s*\d+[.)]\s+/;
const URL_RE = /https?:\/\/\S+/;
// A link the owner opens. A URL the owner is told to TYPE (the incident's "add https://broadwayscorecard.com") is a
// value, not a link: it counts only on a line that says to open/visit/follow it, or when it points off our own site.
const OPEN_WORD_RE = /\b(?:open|visit|go to|link|follow|sign in|log in|here:)/i;
const OWN_SITE_RE = /^https?:\/\/(?:www\.)?broadwayscorecard\.com(?:[\/?#]|$)/i;
const hasOpenableLink = (block) => block.split('\n').some((l) => (l.match(/https?:\/\/[^\s)`"'>]+/g) || [])
  .some((u) => !OWN_SITE_RE.test(u) || OPEN_WORD_RE.test(l.replace(u, ' '))));

/**
 * PURE. The owner-action block of a closing message: the "You need to:" line plus the list lines under it, and the
 * ACTION NEEDED FROM YOU line. Fenced code and quotes are dropped. '' when the owner is asked for nothing.
 */
function ownerBlock(message) {
  const lines = String(message || '').replace(/```[\s\S]*?```/g, '').split('\n').filter((l) => !/^\s*>/.test(l));
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const you = /^\W*you need to:?\s*(.*)$/i.exec(l);
    if (you) {
      if (/^\W*(?:nothing|n\/?a|none|no(?: action)?\b)/i.test(you[1])) continue;
      out.push(you[1]);
      for (let j = i + 1; j < lines.length && lines[j].trim() && /^\s*(?:\d+[.)]|[-*•])\s+|^\s*you(?:'|’)?ll see\b/i.test(lines[j]); j++) out.push(lines[j]);
      // "do the steps above" points at a numbered list elsewhere in the message: judge those steps too.
      if (/\bsteps? (?:above|below)\b/i.test(you[1])) for (const n of lines) if (/^\s*\d+[.)]\s+/.test(n) && !out.includes(n)) out.push(n);
      continue;
    }
    const act = /^[\s*_•-]{0,4}ACTION NEEDED FROM YOU\b\W*(.*)$/.exec(l);
    if (act && act[1].trim()) out.push(act[1]);
  }
  return out.join('\n').trim();
}

const unquote = (t) => String(t || '').replace(/"[^"\n]*"|“[^”\n]*”|\*\*[^*\n]+\*\*|`[^`\n]*`/g, ' ').replace(/https?:\/\/\S+/g, ' ');

/** PURE. Is the block a manual action on an outside site (the class this lint judges)? */
function isManualOutsideAsk(block) {
  const b = String(block || '');
  if (!b) return false;
  // Judge each clause: "approve the screenshots below, then open the GitHub app" still holds a manual step (ship-check).
  const actionLines = b.split('\n').flatMap((l) => l.replace(/^\s*(?:\d+[.)]|[-*•])\s+/, '').split(/,\s*(?:and\s+)?then\b|\band then\b|;\s*/))
    .filter((l) => l.trim() && !REPLY_ONLY_RE.test(l.trim()));
  return actionLines.some((l) => MANUAL_RE.test(unquote(l)) || (URL_RE.test(l) && MANUAL_RE.test(l)));
}

/** PURE. Problems with owner steps in a message: [{ code, detail }]. Empty when there is no manual outside-site ask. */
function lintOwnerSteps(message) {
  const block = ownerBlock(message);
  if (!isManualOutsideAsk(block)) return [];
  const problems = [];
  const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
  const steps = lines.filter((l) => NUMBERED_RE.test(l));
  const verbs = (unquote(block).match(VERB_RE) || []).length;
  if (!hasOpenableLink(block)) problems.push({ code: 'no-link', detail: 'no direct link: give the exact page as a link (owner-steps.js has deep links, e.g. consoleClientUrl for Google sign-in settings)' });
  if (verbs >= 2 && steps.length < 2) problems.push({ code: 'not-numbered', detail: 'more than one action but no numbered steps: write 1., 2., 3., one action each' });
  for (const s of steps) {
    const body = unquote(s.replace(NUMBERED_RE, ''));
    // Narrow on purpose: only an explicit chain ("tap X, then tap Y", "open X and then add Y") counts. Measured on the
    // incident thread: the owner followed "Click + Add URI. In the empty line, paste: ..." without trouble.
    if ((body.match(VERB_RE) || []).length >= 2 && /\b(?:,\s*then|and then|then)\s+\w+/i.test(body)) {
      problems.push({ code: 'two-actions', detail: `step "${s.slice(0, 70)}" asks for more than one action: split it` });
      break;
    }
  }
  const jargon = unquote(block).match(JARGON_RE);
  if (jargon) problems.push({ code: 'jargon', detail: `"${jargon[0]}" is a technical word the owner has to interpret: say what it is in plain words, and put the exact on-screen name in quotes` });
  if (!SEEN_RE.test(block)) problems.push({ code: 'no-seen', detail: 'no "You\'ll see: ..." line saying what the screen shows when it worked' });
  return problems;
}

function main(argv) {
  if (!argv.length) {
    for (const [id, r] of Object.entries(RECIPES)) console.log(`${id.padEnd(18)} ${r.about}`);
    return 0;
  }
  if (argv[0] === '--lint') {
    const src = argv[1] && argv[1] !== '-' ? fs.readFileSync(argv[1], 'utf8') : fs.readFileSync(0, 'utf8');
    const p = lintOwnerSteps(src);
    if (!p.length) { console.log('owner steps: ok (or no manual outside-site step asked)'); return 0; }
    for (const x of p) console.log(`- ${x.code}: ${x.detail}`);
    return 1;
  }
  const params = Object.fromEntries(argv.slice(1).map((a) => a.split('=')).filter((kv) => kv.length === 2));
  if (argv[0] === 'google-js-origins' && !params.clientId) {
    const id = googleWebClientId();
    if (!id) { console.error('could not read the Google web client id from src/lib/google-one-tap.ts; pass clientId=<id>'); return 2; }
  }
  console.log(render(argv[0], params));
  return 0;
}

module.exports = { RECIPES, render, ownerBlock, isManualOutsideAsk, lintOwnerSteps, googleWebClientId, SITE_ORIGINS };

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 2; }
}
