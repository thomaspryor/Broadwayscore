// Tests for TodayTix page identity (BRO-4851). The fixture mirrors the real
// __NEXT_DATA__ shape of todaytix.com/london/shows/45696-the-shitheads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractTodaytixPageIdentity, todaytixPageMatchesShow, cleanTodaytixAbout, nonStoryReason } = require('./todaytix-page-identity.js');

const page = (product, extra = {}) => `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  props: { pageProps: { product, ...extra } },
})}</script></html>`;
const SHITHEADS = { id: 45696, displayName: 'The Shitheads', venue: { name: 'Royal Court' }, startingDate: '2026-02-06', closingDate: '2026-03-14' };
const show = { id: 'the-shitheads-west-end-2026', title: 'The Shitheads', venue: 'Royal Court', previewsStartDate: '2026-02-13', closingDate: '2026-03-14' };

test('reads the page\'s own product', () => {
  assert.deepEqual(extractTodaytixPageIdentity(page(SHITHEADS)),
    { id: '45696', title: 'The Shitheads', venue: 'Royal Court', start: '2026-02-06', end: '2026-03-14', about: '' });
  assert.equal(extractTodaytixPageIdentity('<html>no data</html>'), null);
  assert.equal(extractTodaytixPageIdentity('<script id="__NEXT_DATA__">{bad json</script>'), null);
});

test('matches only on id + title + venue + overlapping dates', () => {
  const id = extractTodaytixPageIdentity(page(SHITHEADS));
  assert.equal(todaytixPageMatchesShow(id, show, 45696), true);
  assert.equal(todaytixPageMatchesShow(id, show, 11111), false); // asked for another id
  assert.equal(todaytixPageMatchesShow(id, { ...show, title: 'Shitheads II' }, 45696), false);
  assert.equal(todaytixPageMatchesShow(id, { ...show, venue: 'Young Vic' }, 45696), false);
  assert.equal(todaytixPageMatchesShow(id, { ...show, previewsStartDate: '2027-01-10', closingDate: '2027-02-01' }, 45696), false);
});

test('a recycled id whose page lists our show only in a related carousel does not match', () => {
  const recycled = page(
    { id: 45696, displayName: 'Radiolab Live', venue: { name: 'Southbank Centre' } },
    { relatedProducts: [SHITHEADS] },
  );
  assert.equal(todaytixPageMatchesShow(extractTodaytixPageIdentity(recycled), show, 45696), false);
});

// Real product.about shape (45696). Run 37818726628 saved scraped paragraphs
// (quotes, age notes, cast lists) as synopses; only story sentences may pass.
test('cleanTodaytixAbout keeps story sentences and drops pitch, tickets, notes and lists', () => {
  const about = 'See the world premiere of *The Shitheads*, a captivating new black comedy at the Royal Court Theatre. Book *The Shitheads* tickets on TodayTix.   *The Shitheads* is a play that is set thousands of years ago among some of the earliest inhabitants of Britain. The harmony of their cave life is shattered when strangers arrive. Age guidance: 14+. Running time: 1 hour 40 minutes. ★★★★★ "Brilliant" – The Guardian.';
  assert.equal(cleanTodaytixAbout(about),
    'The Shitheads is a play that is set thousands of years ago among some of the earliest inhabitants of Britain. The harmony of their cave life is shattered when strangers arrive.');
});

test('cleanTodaytixAbout returns empty when nothing reads as plot (caller falls back to the verifier)', () => {
  assert.equal(cleanTodaytixAbout('The talented cast bringing this story to life are A, B and C. Book tickets now.'), '');
  assert.equal(cleanTodaytixAbout('This heartfelt drama is best for children ages 12 and above.'), '');
  assert.equal(cleanTodaytixAbout(''), '');
});

test('markdown links, headings and HTML are stripped; output ends at a sentence', () => {
  const out = cleanTodaytixAbout('## About\n<p>A family drama [set in](https://x) 1970s Glasgow follows three sisters.</p> ' + 'It explores grief. '.repeat(80));
  assert.ok(out.startsWith('About A family drama set in 1970s Glasgow follows three sisters.') || out.startsWith('A family drama set in 1970s Glasgow follows three sisters.'));
  assert.match(out, /[.!?]$/);
  assert.ok(out.length <= 700);
});

// Run 37828755764: curly apostrophes let "Don’t miss" openers through, a
// pull quote rode along (Unicorn) and a stray opening quote led (Brace Brace).
test('curly-quote openers, pull quotes and stray leading quotes are removed', () => {
  const unicorn = 'Don\u2019t miss the world premiere of Unicorn, the funny and provocative new play by Mike Bartlett. \u201CMike Bartlett\u2019s Unicorn is that rare beast, very, very funny,\u201D Nicola Walker said. The play follows a married couple whose life is upended when a younger woman enters it.';
  assert.equal(cleanTodaytixAbout(unicorn), 'The play follows a married couple whose life is upended when a younger woman enters it.');
  assert.equal(cleanTodaytixAbout('" Brace Brace is a play that explores how catastrophe impacts survivors.'), 'Brace Brace is a play that explores how catastrophe impacts survivors.');
});

// WE historical 2023-24 (BRO-4884): producer copy that passed as a synopsis.
test('cleanTodaytixAbout drops production news, billing and star credits', () => {
  // The meta-description path (no product record) saved this verbatim.
  assert.equal(cleanTodaytixAbout('“Mike Birbiglia is a true star” (The Times) and his hit show The Old Man &amp; The Pool, currently playing at Wyndham’s Theatre, has just won rave reviews.'), '');
  assert.equal(cleanTodaytixAbout("The play is performing at the Royal Court Theatre and is one of nine shows in the theatre's 2024 season under the new leadership of artistic director David Byrne."), '');
  // Cut mid-sentence by the meta tag: no sentence end, nothing kept.
  assert.equal(cleanTodaytixAbout('This landmark new production, often regarded as the greatest American play of the 20th Century, will be directed by the award-winning Jeremy Herrin ('), '');
  assert.equal(cleanTodaytixAbout('Book Why Am I So Single? Two friends who are perpetually single musical theatre writers procrastinate by exploring their dating woes, which follows them through dating apps.'),
    'Two friends who are perpetually single musical theatre writers procrastinate by exploring their dating woes, which follows them through dating apps.');
  assert.equal(cleanTodaytixAbout("Denise Gough reprises her mesmerising Olivier Award-winning lead role in Duncan Macmillan's contemporary classic. The original production returns to the West End this May, playing a limited 14-week season at the Trafalgar Theatre. People, Places & Things tells the story of Emma, a struggling actress whose life is spiralling out of control."),
    'People, Places & Things tells the story of Emma, a struggling actress whose life is spiralling out of control.');
  assert.equal(cleanTodaytixAbout('Sheridan Smith stars in the new musical Opening Night. Opening Night is based on the 1971 film, following a theatre company gearing up for a Broadway production. Hamnet premiered in April at the Swan Theatre.'),
    'Opening Night is based on the 1971 film, following a theatre company gearing up for a Broadway production.');
  // Bacchae (Phase B): "includes" slipped past the cast-list rule.
  assert.equal(cleanTodaytixAbout('The cast also includes Melanie-Joyce Bermudez, Ebony Clarke and Natasha Gooden. The play follows a god who returns to Thebes when the king denies him.'),
    'The play follows a god who returns to Thebes when the king denies him.');
});

// Season-audit sharing (BRO-4851): quoted titles are story; pull quotes are not.
test('nonStoryReason: quoted titles survive, pull quotes of any length and split quotes do not', () => {
  assert.equal(nonStoryReason('"After the Act" is a verbatim musical examining Section 28.'), null);
  assert.equal(nonStoryReason('"Utterly brilliant" \u2013 The Guardian.'), 'pull-quote');
  assert.equal(nonStoryReason('"Utterly brilliant" (Daily Mail).'), 'pull-quote');
  assert.equal(nonStoryReason('Go see it," said the Times.'), 'pull-quote');
  assert.equal(nonStoryReason('Hailed as \u201Cjoyous and emotionally volcanic\u201D (Daily Mail), this new musical features hits by Queen.'), 'pull-quote');
  assert.equal(nonStoryReason('Susan Sarandon is making her UK theatre debut.'), 'production-news');
  assert.equal(nonStoryReason('In a small rural pub in County Leitrim, a group of local men gather.'), null);
});

// Phase C 2023-24 (BRO-4884): billing and pitch lines that passed as story.
test('billing (reprise, nominee) and "this ... production" pitch are not story', () => {
  assert.equal(cleanTodaytixAbout('Jonny Lee Miller (Trainspotting) and Olivier Award nominee Tanya Reynolds (Sex Education) reprise their leading roles. A Mirror is a play set in a totalitarian society in which all new works of art have to be approved by the Minister for Culture.'),
    'A Mirror is a play set in a totalitarian society in which all new works of art have to be approved by the Minister for Culture.');
  assert.equal(nonStoryReason('This groundbreaking new production expertly balances rhyme, spoken word, movement, and music to transport audiences to Thebes.'), 'production-news');
  assert.equal(nonStoryReason('Lackawanna Blues transports audiences to 1950s Buffalo, where a young boy grows up in a boarding house.'), null);
});

// BRO-4884 2018-19: real TodayTix copy the cleaner kept whole.
test('UK single-quoted press quotes, audience address, billing and fragments are not story', () => {
  const summerAndSmoke = "Trapped between desire and a life of obligation, Alma meets John and her world turns upside down. With 'spellbinding, stripped-back staging' (Financial Times), this intoxicating classic about love, loneliness and self-destruction evokes the simmering passions of a sweltering summer in small-town Mississippi. Patsy Ferran is a genuine marvel' as Alma (Independent) and Matthew Needham 'fires up the stage' (The Times) as John in this 'unmissable Tennessee Williams revival' (The Telegraph).";
  assert.equal(cleanTodaytixAbout(summerAndSmoke), '');
  const onYourFeet = "This 'exhilarating extravaganza' (Whatsonstage) is the inspiring true love story of Emilio and Gloria and charts their journey from its origins in Cuba, onto the streets of Miami and finally to international superstardom. Beat' and '1-2-3'. , An Officer and a Gentleman) as Emilio Estefan, Madalena Alberto (Evita, Cats, Les Misérables) as Gloria Fajardo and Karen Mann (Sister Act, Fiddler on the Roof, Sweeney Todd) as Consuelo.";
  assert.equal(cleanTodaytixAbout(onYourFeet), '');
  // The second sentence leans on the dropped one ("That meant"), so it goes too.
  const comeFromAway = "Welcome to the Rock! The heart-warming musical Come From Away, based on an astonishing true story, invites you into the small town of Gander, Newfoundland, where you'll find the very best of humanity in the worst of times. That meant a sudden influx of 7,000 international visitors, who were taken in and cared for by the kindly locals.";
  assert.equal(cleanTodaytixAbout(comeFromAway), '');
  assert.equal(nonStoryReason('Join us on this emotional roller-coaster as this group of girls reunite after 25 years apart.'), 'pitch-opener');
  assert.equal(nonStoryReason('The show features the spectacular music of TAKE THAT, whose songs include Never Forget.'), 'selling-or-list');
  assert.equal(nonStoryReason('James McArdle takes the title role in this epic story of transformation.'), 'selling-or-list');
  assert.equal(nonStoryReason("Beat' and '1-2-3'."), 'fragment');
});

test('contractions, initials and quoted titles stay story', () => {
  assert.equal(nonStoryReason('It’s the future.'), null);
  assert.equal(nonStoryReason("Mark doesn't believe in fate or divine intervention, but the universe has other ideas."), null);
  assert.equal(nonStoryReason("It's 1992 and we meet five 16 year old girls for who 'the band' is everything."), null);
  assert.equal(nonStoryReason('The Minstrel welcomes everyone ("Welcome to the Renaissance").'), null);
  assert.equal(cleanTodaytixAbout('They are Johnny (originated by F. Murray Abraham), a short order cook, and Frankie, a waitress, who meet after a first date.'),
    'They are Johnny (originated by F. Murray Abraham), a short order cook, and Frankie, a waitress, who meet after a first date.');
  const follies = "New York, 1971. There's a party on the stage of the Weismann Theatre. Tomorrow the iconic building will be demolished. Thirty years after their final performance, the Follies girls gather to have a few drinks, sing a few songs and lie about themselves.";
  assert.equal(cleanTodaytixAbout(follies), follies);
});

test('a quoted song cue in its own brackets is plot, a press quote is not (BRO-5063)', () => {
  assert.equal(nonStoryReason('A trio of dockyard workers mourns the start of a new workday ("I Feel Like I\'m Not Out of Bed Yet").'), null);
  assert.equal(nonStoryReason('Bateman documents his morning routine before travelling to Wall Street ("Opening (Morning Routine)"/"Selling Out").'), null);
  assert.equal(nonStoryReason('A thriller that is "the best night out in years" (Evening Standard).'), 'pull-quote');
  assert.equal(nonStoryReason('"Utterly brilliant" – The Guardian.'), 'pull-quote');
});

// BRO-5063: three rows the backfill left empty although their pages had plot
// (TodayTix about text, 2026-10-11).
test('a run of initials does not swallow the sentence before it (P.T. Barnum)', () => {
  const about = 'Book The Greatest Showman tickets on TodayTix. The Greatest Showman is a musical that follows P.T. Barnum, who absolutely refuses to settle for the status quo. Driven by great creative ambition, he begins assembling a rather unconventional group of performers.';
  assert.match(cleanTodaytixAbout(about), /^The Greatest Showman is a musical that follows P\.T\. Barnum/);
});

test('half of a pull quote is dropped even after its opening mark is trimmed (Insane Asylum Seekers)', () => {
  const about = '“At 27, my dad had escaped multiple bloodthirsty dictatorships. I’m 27, I had a panic attack watching the final episode of Succession,” Laith says. Laith has been keeping a secret for years, and he believes the reason lies with his parents leaving Iraq 30 years prior. This story explores a century of the British-Iraqi experience.';
  const out = cleanTodaytixAbout(about);
  assert.doesNotMatch(out, /At 27/);
  assert.match(out, /^Laith has been keeping a secret/);
});

test('sentences ending in a quote or bracket are kept, quoted titles are story (BRO-5063 review)', () => {
  assert.equal(cleanTodaytixAbout('Set in 1920s Paris, the play follows Anna. She is introduced to a stranger called "the Count." They fall in love when war comes.'),
    'Set in 1920s Paris, the play follows Anna. She is introduced to a stranger called "the Count." They fall in love when war comes.');
  assert.match(cleanTodaytixAbout('"Hamilton" is the story of America then, told by America now. It follows a founding father.'), /^"Hamilton" is the story/);
  assert.match(cleanTodaytixAbout("'Tis the season for murder. A family gathers when a body is found in the snow."), /the season for murder\. A family gathers/);
});

// BRO-5063: the backfill saved these two from "trusted" TodayTix pages.
test('the show title\'s "!" is not a sentence end, and an ellipsis tail is a fragment (Schmigadoon!)', () => {
  const about = 'Get *Schmigadoon!* tickets on TodayTix to see the 2026 Best Musical Tony Award winner! A love letter to Broadway’s Golden Age wrapped in a modern musical comedy, *Schmigadoon!* will leave you with a “song in your heart” (The New York Times)... if you manage to get out.';
  assert.equal(cleanTodaytixAbout(about, 'Schmigadoon!'), '');
});

test('a content-warning bullet list is not story (The Comedy About Spies)', () => {
  const about = 'When a rogue British agent pilfers plans for a top-secret weapon, CIA and KGB spies converge on London’s Piccadilly Hotel in pursuit of the elusive file.\n\nSubject matters in the show include : • Characters include Spies from the United States of America and the USSR. • Physical and verbal abuse are depicted throughout the show with violence in multiple scenes.';
  assert.equal(cleanTodaytixAbout(about, 'The Comedy About Spies'), 'When a rogue British agent pilfers plans for a top-secret weapon, CIA and KGB spies converge on London\'s Piccadilly Hotel in pursuit of the elusive file.');
});
