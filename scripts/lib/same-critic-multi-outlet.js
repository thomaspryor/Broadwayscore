/**
 * BRO-7238 part 3: (show, critic) keys that hold reviews from 2+ outlets.
 * One critic's single review counted twice is the failure class; a key is
 * "unresolved" when no outlet in it is a known syndication secondary of another.
 * Pure over reviews.json rows so tests can require() the real function.
 */
const { getSyndicationPrimaries, SYNDICATION_PORTAL_OUTLETS } = require('./syndication-pairs');

/**
 * BRO-7272: keys a person read side by side and found to be DIFFERENT articles by a critic who really writes for
 * both outlets (word-level overlap of the stored texts ~0, distinct URLs, or one outlet carries a later/earlier
 * production or cast-change re-review). Each is counted once per article, so this is not the double-count failure
 * class. Reason codes are stable so a test can pin them. A key whose pair later turns out to be the same article
 * must move to KNOWN_SYNDICATION_PAIRS instead and be removed here.
 */
const DISTINCT = {
  'two-outlets': 'critic writes for both outlets; two different reviews of the show',
  'later-piece': 'second outlet is a later feature, cast-change re-review or different production, not a reprint',
  'no-text': 'one side has no stored text yet; distinct URLs and a critic known to write for both outlets',
};
const REVIEWED_DISTINCT = {};
function reviewed(code, keys) { for (const k of keys) REVIEWED_DISTINCT[k] = code; }
reviewed('two-outlets', [
  '1984-2017|adam feldman|theatermania+timeout', 'a-dolls-house-part-2-2017|jesse green|nytimes+vulture', 'a-night-with-janis-joplin-2013|scott brown|amny+vulture',
  'aladdin-2014|thom geier|culturesauce+ew', 'aladdin-2014|elysa gardner|nysr+usatoday', 'almost-famous-2022|joe dziemianowicz|nydailynews+nytg',
  'and-juliet-2022|matthew wexler|one-minute-critic+queerty', 'annie-west-end-2017|mark shenton|london-theatre+thestage', 'bacchae-west-end-2025|maryam philpott|plays-international+thereviewshub',
  'bat-out-of-hell-west-end-2017|tim bano|thestage+timeout-london', 'betty-blue-eyes-west-end-2011|michael coveney|independent+whatsonstage',
  'big-fish-2013|thom geier|culturesauce+ew', 'bug-2026|sandy macdonald|new-york-notebook+nysr', 'china-doll-2015|andy propst|american-theater-web+theatermania',
  'evita-west-end-2025|marianka swain|london-theatre+london-theatre-reviews', 'glengarry-glen-ross-2012|ben brantley|amny+nytimes', 'good-night-oscar-2023|jesse green|nytimes+theatermania',
  'good-people-2011|ben brantley|nytimes+theatermania', 'grease-west-end-2022|john nathan|metro-uk+the-jewish-chronicle', 'hadestown-2019|donna herman|front-row-center+nytg',
  'harry-potter-2021|alexis soloski|guardian+nytimes', 'illinoise-2024|jesse green|nytimes+observer', 'mj-2022|jesse green|nytimes+theatermania',
  'present-laughter-west-end-2019|matt wolf|artsdesk+nytimes', 'rosencrantz-and-guildenstern-are-dead-west-end-2011|michael coveney|independent+thestage',
  'shakespeare-in-love-west-end-2014|david benedict|telegraph+variety', 'sinatra-the-musical-west-end-2026|louise penn|loureviews+plays-international',
  'some-like-it-hot-2022|adam feldman|theatermania+timeout', 'that-is-not-who-i-am-west-end-2022|john nathan|metro-uk+the-jewish-chronicle',
  'the-bands-visit-2017|steven suskin|huffpost+nysr', 'the-car-man-off-west-end-2026|sarah crompton|observer+whatsonstage',
  'the-country-girl-west-end-2010|michael coveney|independent+whatsonstage', 'the-crucible-west-end-2022|maryam philpott|plays-international+thereviewshub',
  'the-great-wave-west-end-2018|sam marlowe|thestage+times-uk', 'the-p-word-off-west-end-2026|rosie wood|everything-theatre+thereviewshub',
  'the-pitmen-painters-2010|ben brantley|nytimes+theatermania', 'the-witches-west-end-2023|maryam philpott|plays-international+thereviewshub',
  'yellow-face-2024|greg evans|deadline+thewrap', 'martin-guerre-west-end-2026|patrick marmion|daily-mail+mail-on-sunday',
]);
reviewed('later-piece', [
  'cabaret-at-the-kit-kat-club-west-end-2021|marianka swain|broadwayworld+telegraph', 'six-the-musical-west-end-2021|marianka swain|london-theatre+telegraph',
  'hello-dolly-2017|jesse green|nytimes+vulture', 'harry-potter-2021|charles isherwood|broadwaynews+financialtimes', 'wicked-2003|charles isherwood|nytimes+variety',
  'the-book-of-mormon-west-end-2024|claire allfree|metro-uk+telegraph', 'la-boheme-off-broadway-2026|rick perdian|new-york-classical-review+seen-and-heard-international',
  'oliver-west-end-2024|dominic cavendish|sunday-telegraph+telegraph', 'the-producers-west-end-2025|dominic maxwell|sunday-times+times-uk',
  'mrs-doubtfire-west-end-2023|marianka swain|london-theatre+telegraph', 'frozen-west-end-2021|marianka swain|artsdesk+telegraph',
  'jersey-boys-west-end-2021|marianka swain|london-theatre+telegraph',
]);
reviewed('no-text', [
  'an-american-in-paris-west-end-2017|mark shenton|london-theatre+thestage', 'curse-of-the-starving-class-off-broadway-2025|samuel l. leiter|broadway-blog+theater-life',
  'dear-evan-hansen-west-end-2019|john nathan|metro-uk+the-jewish-chronicle', 'summer-1976-2023|joe dziemianowicz|nydailynews+nytg',
]);

const NO_BYLINE = /^(unknown|staff|n\/a|none|anonymous|)$/;

/**
 * @param {Array<{showId:string,criticName?:string,outletId:string}>} reviews
 * @returns {{showId:string,critic:string,outlets:string[],covered:string[]}[]}
 *   covered = outlets that are a known secondary of another outlet in the key (the rebuild drops them)
 */
function findSameCriticMultiOutlet(reviews) {
  const by = new Map();
  for (const r of reviews || []) {
    const critic = String(r.criticName || '').toLowerCase().trim();
    if (NO_BYLINE.test(critic) || !r.outletId) continue;
    const k = `${r.showId}|${critic}`;
    if (!by.has(k)) by.set(k, { showId: r.showId, critic, outlets: new Set() });
    by.get(k).outlets.add(r.outletId);
  }
  const out = [];
  for (const g of by.values()) {
    if (g.outlets.size < 2) continue;
    const outlets = [...g.outlets].sort();
    const covered = outlets.filter((o) => getSyndicationPrimaries(g.critic, o, { sameCriticOutlets: outlets })
      .some((p) => g.outlets.has(p)));
    const code = REVIEWED_DISTINCT[`${g.showId}|${g.critic}|${outlets.join('+')}`] || null;
    out.push({ showId: g.showId, critic: g.critic, outlets, covered, reviewed: code ? DISTINCT[code] : null });
  }
  return out;
}

/** Keys where every outlet is still counted (no known secondary), i.e. the double count is live. */
const unresolved = (keys) => keys.filter((k) => k.covered.length === 0 && !k.reviewed);

module.exports = { findSameCriticMultiOutlet, unresolved, REVIEWED_DISTINCT, SYNDICATION_PORTAL_OUTLETS };
