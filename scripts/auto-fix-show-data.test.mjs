// BRO-102: the IBDB creative-team scrape path (fixCreativeTeam Step 2) used
// to take ibdb.creativeTeam verbatim — a wrong table cell or stale IBDB entry
// would ship a hallucinated attribution the same way the LLM path did before
// the 2026-05-26 Liberation fix (generateCreativeTeamWithSerpVerification).
// Both paths now route through the same verifyCreativeTeamViaSerp() gate.
//
// serpQuery and lookupIBDBDates are network calls, so this file mocks them
// via require.cache injection (pre-seed the module cache for their owning
// libs before requiring auto-fix-show-data.js fresh) rather than re-implementing
// their decision logic — see CLAUDE.md rule 15 ("require() the real function").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

process.env.SCRAPINGBEE_API_KEY = process.env.SCRAPINGBEE_API_KEY || 'test-key';

const targetPath = require.resolve('./auto-fix-show-data.js');
const urlDiscoveryPath = require.resolve('./lib/url-discovery.js');
const ibdbDatesPath = require.resolve('./lib/ibdb-dates.js');

// Load auto-fix-show-data.js with serpQuery and lookupIBDBDates swapped out.
// Restores the real modules afterward so other tests in the same process
// (or a later require in this file) aren't left with mocks installed.
function loadWithMocks({ serpQueryImpl, ibdbCreativeTeam }) {
  const realUrlDiscovery = require(urlDiscoveryPath);
  const realIbdbDates = require(ibdbDatesPath);

  delete require.cache[urlDiscoveryPath];
  delete require.cache[ibdbDatesPath];
  delete require.cache[targetPath];

  require.cache[urlDiscoveryPath] = {
    id: urlDiscoveryPath, filename: urlDiscoveryPath, loaded: true,
    exports: { ...realUrlDiscovery, serpQuery: serpQueryImpl },
  };
  require.cache[ibdbDatesPath] = {
    id: ibdbDatesPath, filename: ibdbDatesPath, loaded: true,
    exports: {
      ...realIbdbDates,
      lookupIBDBDates: async () => ({
        previewsStartDate: '2026-01-01',
        openingDate: '2026-01-15',
        closingDate: null,
        creativeTeam: ibdbCreativeTeam,
        showType: null,
        ibdbUrl: 'https://www.ibdb.com/broadway-production/example-123456',
        found: true,
      }),
    },
  };

  try {
    return require(targetPath);
  } finally {
    // Restore the real modules for anything requiring them after this point,
    // even if requiring targetPath threw — a leaked mock in require.cache
    // would otherwise silently poison every later test in this process that
    // does a plain require('./lib/ibdb-dates') / require('./lib/url-discovery').
    delete require.cache[urlDiscoveryPath];
    delete require.cache[ibdbDatesPath];
    delete require.cache[targetPath];
    require.cache[urlDiscoveryPath] = { id: urlDiscoveryPath, filename: urlDiscoveryPath, loaded: true, exports: realUrlDiscovery };
    require.cache[ibdbDatesPath] = { id: ibdbDatesPath, filename: ibdbDatesPath, loaded: true, exports: realIbdbDates };
  }
}

function fakeShow(overrides = {}) {
  return {
    id: 'example-2026',
    title: 'Example',
    openingDate: '2026-01-15',
    ibdbUrl: 'https://www.ibdb.com/broadway-production/example-123456',
    ...overrides,
  };
}

test('verifyCreativeTeamViaSerp: unrecognized (design/tech-credit) roles are rejected without a network call', async () => {
  let calls = 0;
  const { verifyCreativeTeamViaSerp } = loadWithMocks({
    serpQueryImpl: async () => { calls++; return []; },
    ibdbCreativeTeam: [],
  });

  const proposed = [{ name: 'Arnulfo Maldonado', role: 'Scenic Design' }];
  const verified = await verifyCreativeTeamViaSerp(fakeShow(), proposed, '2026', 'serp-verified-ibdb');

  assert.deepEqual(verified, []);
  assert.equal(calls, 0, 'unverifiable roles must never reach serpQuery');
});

test('verifyCreativeTeamViaSerp: a member confirmed by SERP is accepted and tagged with the source', async () => {
  const { verifyCreativeTeamViaSerp } = loadWithMocks({
    serpQueryImpl: async () => [
      { title: 'Example opens', snippet: 'Example, directed by Mary Zimmerman, begins previews.' },
    ],
    ibdbCreativeTeam: [],
  });

  const proposed = [{ name: 'Mary Zimmerman', role: 'Director' }];
  const verified = await verifyCreativeTeamViaSerp(fakeShow(), proposed, '2026', 'serp-verified-ibdb');

  assert.equal(verified.length, 1);
  assert.equal(verified[0].name, 'Mary Zimmerman');
  assert.equal(verified[0].role, 'Director');
  assert.equal(verified[0]._source, 'serp-verified-ibdb');
});

test('verifyCreativeTeamViaSerp: a member SERP does not confirm is rejected (the wrong-table-cell / hallucination case)', async () => {
  const { verifyCreativeTeamViaSerp } = loadWithMocks({
    // No result mentions "written by Reginald Rose" for this show — simulates
    // IBDB regex grabbing the wrong playwright (the romantic-comedy-1979 bug).
    serpQueryImpl: async () => [
      { title: 'Unrelated', snippet: 'Some other show entirely, opening next month.' },
    ],
    ibdbCreativeTeam: [],
  });

  const proposed = [{ name: 'Reginald Rose', role: 'Playwright' }];
  const verified = await verifyCreativeTeamViaSerp(fakeShow({ title: 'Romantic Comedy' }), proposed, '2026', 'serp-verified-ibdb');

  assert.deepEqual(verified, []);
});

test('fixCreativeTeam: IBDB step drops an unconfirmed member but keeps a confirmed one, and writes only the verified set', async () => {
  const { fixCreativeTeam } = loadWithMocks({
    serpQueryImpl: async (query) => {
      if (query.includes('directed by')) {
        return [{ title: 'Example opens', snippet: 'Example, directed by Mary Zimmerman, begins previews.' }];
      }
      // "written by Reginald Rose" (or any other query) finds nothing.
      return [];
    },
    ibdbCreativeTeam: [
      { name: 'Mary Zimmerman', role: 'Director' },
      { name: 'Reginald Rose', role: 'Playwright' }, // wrong table cell — unconfirmed
    ],
  });

  const show = fakeShow();
  const result = await fixCreativeTeam(show, { shows: {} });

  assert.match(result, /SERP-verified/);
  assert.equal(show.creativeTeam.length, 1);
  assert.equal(show.creativeTeam[0].name, 'Mary Zimmerman');
  assert.ok(!show.creativeTeam.some(m => m.name === 'Reginald Rose'), 'the unconfirmed member must not be written');
});

test('fixCreativeTeam: IBDB step writes nothing when no member passes SERP verification', async () => {
  const { fixCreativeTeam } = loadWithMocks({
    serpQueryImpl: async () => [],
    ibdbCreativeTeam: [{ name: 'Someone Wrong', role: 'Director' }],
  });

  const show = fakeShow();
  const result = await fixCreativeTeam(show, { shows: {} });

  assert.equal(result, null);
  assert.equal(show.creativeTeam, undefined, 'no creative team data may be introduced without verification');
});

test('verifyCreativeTeamViaSerp: dedupes duplicate name+role entries (one SERP call, one output entry)', async () => {
  let calls = 0;
  const { verifyCreativeTeamViaSerp } = loadWithMocks({
    serpQueryImpl: async () => {
      calls++;
      return [{ title: 'Example opens', snippet: 'Example, directed by Mary Zimmerman, begins previews.' }];
    },
    ibdbCreativeTeam: [],
  });

  const proposed = [
    { name: 'Mary Zimmerman', role: 'Director' },
    { name: 'Mary Zimmerman', role: 'Director' },
    { name: 'mary zimmerman', role: 'director' }, // case-insensitive duplicate
  ];
  const verified = await verifyCreativeTeamViaSerp(fakeShow(), proposed, '2026', 'serp-verified-ibdb');

  assert.equal(calls, 1, 'duplicate members must only be SERP-queried once');
  assert.equal(verified.length, 1, 'duplicate members must only appear once in the output');
});

test('verifyCreativeTeamViaSerp: a blank/missing name is rejected without a network call (would otherwise wildcard-match any "<verb> <anyone>" snippet)', async () => {
  let calls = 0;
  const { verifyCreativeTeamViaSerp } = loadWithMocks({
    serpQueryImpl: async () => { calls++; return [{ title: 'Example opens', snippet: 'Example, directed by Someone Else, begins previews.' }]; },
    ibdbCreativeTeam: [],
  });

  const proposed = [{ name: '', role: 'Director' }, { name: '   ', role: 'Director' }];
  const verified = await verifyCreativeTeamViaSerp(fakeShow(), proposed, '2026', 'serp-verified-ibdb');

  assert.deepEqual(verified, []);
  assert.equal(calls, 0, 'a blank name must never reach serpQuery');
});

test('verifyCreativeTeamViaSerp: "Music & Lyrics" confirms on either "music and lyrics by" or "music & lyrics by"', async () => {
  const { verifyCreativeTeamViaSerp } = loadWithMocks({
    serpQueryImpl: async () => [
      { title: 'Example opens', snippet: 'Example, music & lyrics by Jason Robert Brown, begins previews.' },
    ],
    ibdbCreativeTeam: [],
  });

  const proposed = [{ name: 'Jason Robert Brown', role: 'Music & Lyrics' }];
  const verified = await verifyCreativeTeamViaSerp(fakeShow(), proposed, '2026', 'serp-verified-ibdb');

  assert.equal(verified.length, 1);
  assert.equal(verified[0].name, 'Jason Robert Brown');
});

test('fixCreativeTeam: IBDB step never overwrites an existing creativeTeam[1] with an unverified replacement', async () => {
  const { fixCreativeTeam } = loadWithMocks({
    serpQueryImpl: async () => [],
    ibdbCreativeTeam: [{ name: 'Someone Wrong', role: 'Director' }],
  });

  const show = fakeShow({ creativeTeam: [{ name: 'Existing Person', role: 'Director' }] });
  await fixCreativeTeam(show, { shows: {} });

  assert.deepEqual(show.creativeTeam, [{ name: 'Existing Person', role: 'Director' }]);
});

// BRO-4884: sparse WE revival rows (title + venue + year) got UNKNOWN from both
// models; the prompt must tell them a revival has its source work's plot.
test('buildSynopsisPrompt asks for the source work\'s story on a revival and keeps the wrong-show guard', () => {
  const { buildSynopsisPrompt } = loadWithMocks({ serpQueryImpl: async () => [], ibdbCreativeTeam: [] });
  const prompt = buildSynopsisPrompt({ title: 'King Lear', type: 'play', venue: 'Wyndham\'s Theatre', openingDate: '2023-11-01' });
  assert.match(prompt, /Title: "King Lear" \(2023\)/);
  assert.match(prompt, /revival or new staging of an existing work/);
  assert.match(prompt, /describe its story even when you know nothing about this staging/);
  assert.match(prompt, /Do NOT guess or describe a different same-titled show/);
  assert.doesNotMatch(prompt, /not certain about the plot of THIS specific production/);
});

// Run 37868803406 logged a bare UNKNOWN reply as "no text returned" (the
// sentence trim ran first). Fake the Anthropic reply at https.request.
test('generateSynopsisWithLLM logs UNKNOWN and cut-off replies by their real reason', async () => {
  const https = require('https');
  const { EventEmitter } = require('events');
  const realRequest = https.request;
  const realLog = console.log;
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const replies = ['UNKNOWN', 'A king divides his realm between'];
  const logs = [];
  https.request = (_opts, onRes) => {
    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      onRes(res);
      res.emit('data', JSON.stringify({ content: [{ text: replies.shift() }] }));
      res.emit('end');
    };
    return req;
  };
  console.log = (...a) => logs.push(a.join(' '));
  try {
    const { generateSynopsisWithLLM } = loadWithMocks({ serpQueryImpl: async () => [], ibdbCreativeTeam: [] });
    assert.equal(await generateSynopsisWithLLM({ title: 'King Lear', type: 'play', venue: 'Wyndham\'s Theatre', openingDate: '2023-11-01' }), null);
  } finally {
    https.request = realRequest;
    console.log = realLog;
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
  }
  assert.ok(logs.some(l => /replied UNKNOWN/.test(l)), logs.join('\n'));
  assert.ok(logs.some(l => /no complete sentence: "A king divides his realm between"/.test(l)), logs.join('\n'));
});

// BRO-4884: Opus invented an emo/dead-father plot for Instructions for a
// Teenage Armageddon after Haiku replied UNKNOWN. A fallback plot now needs
// search results that describe the same story.
async function runFallback(judgeReply) {
  const https = require('https');
  const { EventEmitter } = require('events');
  const realRequest = https.request;
  const realLog = console.log;
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const invented = 'A teenage girl navigates grief and the emo scene of the mid-2000s after the loss of her father.';
  const replies = ['UNKNOWN', invented, judgeReply];
  const prompts = [];
  const logs = [];
  https.request = (_opts, onRes) => {
    const req = new EventEmitter();
    req.write = (body) => prompts.push(JSON.parse(body).messages[0].content);
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      onRes(res);
      res.emit('data', JSON.stringify({ content: [{ text: replies.shift() }] }));
      res.emit('end');
    };
    return req;
  };
  console.log = (...a) => logs.push(a.join(' '));
  const snippets = [{ title: 'Instructions for a Teenage Armageddon review', snippet: 'Eileen, 15, is grieving her sister Olive, who died of anorexia.' }];
  try {
    const { generateSynopsisWithLLM } = loadWithMocks({ serpQueryImpl: async () => snippets, ibdbCreativeTeam: [] });
    const out = await generateSynopsisWithLLM({ title: 'Instructions for a Teenage Armageddon', type: 'play', venue: 'Garrick Theatre', openingDate: '2024-03-14' });
    return { out, invented, prompts, logs };
  } finally {
    https.request = realRequest;
    console.log = realLog;
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
  }
}

test('generateSynopsisWithLLM drops an Opus fallback plot that search results contradict', async () => {
  const { out, prompts, logs } = await runFallback('CONTRADICTED: the results describe a girl grieving her sister');
  assert.equal(out, null);
  assert.match(prompts[2], /died of anorexia/);
  assert.ok(logs.some(l => /dropped, search results CONTRADICTED/.test(l)), logs.join('\n'));
});

test('generateSynopsisWithLLM keeps an Opus fallback plot that search results support', async () => {
  const { out, invented } = await runFallback('SUPPORTED: same premise');
  assert.equal(out, invented);
});

// BRO-4884: the LLM creative-team path must tie a director to the venue.
// Fake the model's proposal at https.request and record the SERP queries.
test('generateCreativeTeamWithSerpVerification anchors directors to the venue', async () => {
  const https = require('https');
  const { EventEmitter } = require('events');
  const realRequest = https.request;
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const grounded = [];
  https.request = (_opts, onRes) => {
    const req = new EventEmitter();
    let body = '';
    req.write = chunk => { body += chunk; };
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      onRes(res);
      // The credit-grounding judge (lib/credit-grounding.js) and the team proposal share callClaudeAPI.
      const isJudge = /checking one theatre credit/.test(body);
      if (isJudge) grounded.push(body);
      res.emit('data', JSON.stringify({ content: [{ text: isJudge ? 'SUPPORTED: result 2 credits him' : '[{"name": "Dominic Cooke", "role": "Director"}, {"name": "Rupert Holmes", "role": "Book"}]' }] }));
      res.emit('end');
    };
    return req;
  };
  const queries = [];
  const serpQueryImpl = async q => {
    queries.push(q);
    return [
      { title: 'Curtains review', snippet: 'Curtains, directed by Dominic Cooke, is a backstage murder mystery.' },
      { title: 'Curtains musical', snippet: 'Curtains, book by Rupert Holmes, music by John Kander.' },
    ];
  };
  try {
    const { generateCreativeTeamWithSerpVerification } = loadWithMocks({ serpQueryImpl, ibdbCreativeTeam: [] });
    const team = await generateCreativeTeamWithSerpVerification({ id: 'curtains-west-end-2019', title: 'Curtains', type: 'musical', venue: "Wyndham's Theatre", openingDate: '2019-12-13' });
    assert.deepEqual((team || []).map(m => m.name), ['Rupert Holmes']);
    assert.ok(queries.some(q => /Wyndham's Theatre/.test(q)), queries.join('\n'));
    assert.equal(grounded.length, 1, 'the surviving writer credit went through the production grounding check');
    assert.match(grounded[0], /Rupert Holmes as Book/);
  } finally {
    https.request = realRequest;
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
  }
});
